/**
 * jev-judge — the one adapter between the gate's question battery and the
 * harness's own judgment module (`@oh-my-pi/pi-coding-agent/judgment`).
 *
 * The gate used to own its transport: a POST to TypeSafe, an API key resolved
 * from the environment or the macOS keychain, a hand-rolled timeout, and a
 * response validator. OMP 18.2.4 ships that path as its native judgment module
 * — credentials through AuthStorage (`/login typesafe` and a stored
 * `TYPESAFE_API_KEY` both land there, and 401s rotate them), retries with
 * backoff on 408/429/5xx, and a fallback to the tiny/smol/default chat chain
 * when TypeSafe cannot answer — so what is left for this file is the battery,
 * the answers, and their provenance.
 *
 * Invariants it keeps:
 *   - One judge call per battery, carrying the whole battery (jevQuestions():
 *     one Choice, nine Nouls, one Score). Questions in a request are answered
 *     in parallel over the same state, so batching is the natural shape — and
 *     it is the only shape that cannot ask a question the policy then reads by
 *     a different name. The authorization question (judgeAuthorization) is a
 *     second request rather than a tenth question for the same reason read the
 *     other way: it is asked over a different state, one with no command text
 *     in it, and one request carries one state.
 *   - The same strict validation the old HTTP transport performed, because the
 *     answer set now arrives from a text bridge as often as from a server. Every
 *     field the policy reads is checked, a missing hazard is a throw rather than
 *     a 0, and an option label that is not one of ours is dropped rather than
 *     passed through into a dialog or an audit line.
 *   - Provenance. `result.api !== "typesafe"` means a text/keyword bridge
 *     answered — the configured local model, or the chat chain TypeSafe falls
 *     back to — and those answers are one-hot by construction: pi-ai's
 *     `TextJudge.parseAnswer` returns the label it parsed with probability 1 and
 *     confidence 1. `JevAnswers.oneHot` records that, and deriveJevDecision
 *     reads its distribution-shaped floors accordingly.
 *   - Fail closed. Every failure — no judge to ask, a resolver that throws, the
 *     judge throwing (network, non-2xx after retries, a reply that parses to no
 *     answer, the caller's deadline aborting the call), an answer set that does
 *     not validate — becomes JevUnavailableError, the single thing the gate
 *     treats as "there is no judgment". Nothing here ever returns a partial or
 *     defaulted answer set.
 */
import {
	type ChoiceQuestion,
	type Judge,
	type JudgmentResult,
	type JudgmentState,
	type Questions,
	type ScoreQuestion,
	TYPESAFE_PROVIDER,
	type Usage,
} from "@oh-my-pi/pi-ai";
import type { ExtensionContext } from "@oh-my-pi/pi-coding-agent";
import type { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { type JudgeDeps, resolveJudge } from "@oh-my-pi/pi-coding-agent/judgment";
import { ONLINE_MEMORY_MODEL_KEY } from "@oh-my-pi/pi-coding-agent/tiny/models";
import {
	jevAuthorizationQuestions,
	type JevAuthorizationAnswer,
	type JevAuthorizationLevel,
} from "./authorization";
import {
	JEV_HAZARDS,
	JevUnavailableError,
	jevQuestions,
	type JevAnswers,
	type JevChoiceOption,
	type JevHazard,
} from "./jev";

/**
 * The battery as the native module types it. `Questions` is a plain
 * `Record<string, Question>`, so the hazard ids need no names here; the two
 * questions whose answers are read by name — the verdict choice and the blast
 * radius — do.
 */
type JevBattery = Questions & {
	verdict: ChoiceQuestion<JevChoiceOption>;
	blast_radius: ScoreQuestion;
};

/**
 * The part of the extension context a judge is resolved from. `Pick` rather
 * than a hand-written shape so a real `ExtensionContext` passes as-is, and a
 * test can pass the same three fields without an assertion.
 */
export type JudgeContext = Pick<ExtensionContext, "modelRegistry" | "models" | "sessionManager">;

export interface JudgeBatteryOptions {
	/**
	 * What the battery judges: a `buildJevState(...)` result. Typed `unknown`
	 * because jev.ts stays free of harness imports and because the judge accepts
	 * any JSON state — `Judge.judge` narrows it to `JudgmentState` at the call.
	 */
	state: unknown;
	/**
	 * The judge to ask. Production omits it and passes `context` + `settings`;
	 * a test or a CLI passes a resolved judge (`resolveJudge(...)`, or a
	 * hand-built `{ label, judge }`) so the transport is not part of what it is
	 * testing.
	 */
	judge?: Judge;
	/** Extension context: supplies the model registry and the session identity. */
	context?: JudgeContext;
	/**
	 * The HOST settings instance (`pi.pi.settings` in the plugin). Required when
	 * `judge` is absent, because the native resolver reads
	 * `providers.judgmentProvider` and the credential store through it.
	 */
	settings?: Settings;
}

/**
 * Ask the whole battery about one state and map the answers into `JevAnswers`.
 *
 * `signal` is the caller's deadline — the gate passes
 * `AbortSignal.timeout(timeoutMs)` when its own budget is shorter than the
 * judge's defaults; `undefined` leaves the native timeouts in charge. One call,
 * no retries of our own and no second opinion: the judge already retries its
 * own transients, and a request that could not be answered has to surface as no
 * judgment rather than as a guess.
 *
 * Throws `JevUnavailableError` for every failure, so the caller's `catch` is
 * the whole availability policy.
 */
export async function judgeBattery(signal: AbortSignal | undefined, options: JudgeBatteryOptions): Promise<JevAnswers> {
	const judge = options.judge ?? judgeForClassification(options);
	const battery = jevQuestions() as JevBattery;
	const startedAt = performance.now();
	let result: JudgmentResult<JevBattery>;
	try {
		result = await judge.judge({ state: options.state as JudgmentState, questions: battery }, { signal });
	} catch (err) {
		throw new JevUnavailableError(`judgment failed: ${err instanceof Error ? err.message : String(err)}`);
	}
	// Measured across the whole call, so latencyMs is what the classification
	// waited for the judgment rather than the time to the first answer.
	return toJevAnswers(result, battery, Math.round(performance.now() - startedAt));
}

/**
 * The authorization battery as the native module types it: one choice question,
 * whose option labels are the plan's three levels.
 */
type AuthorizationBattery = Questions & { user_authorization: ChoiceQuestion<JevAuthorizationLevel> };

/**
 * Ask the authorization question about one authorization state.
 *
 * A second request rather than a question added to the risk battery, because
 * the two are asked over different states: this one never sees the command
 * text, and the risk battery does. Questions in one request are answered over
 * one state, so separating the states means separating the requests.
 *
 * Throws `JevUnavailableError` on every failure, exactly as `judgeBattery`
 * does. The caller maps a throw to authorization `none`
 * (`deriveAuthorization(undefined, …)`): a risk judgment that succeeded still
 * decides, and the command loses only its fast path.
 */
export async function judgeAuthorization(signal: AbortSignal | undefined, options: JudgeBatteryOptions): Promise<JevAuthorizationAnswer> {
	const judge = options.judge ?? judgeForClassification(options);
	const battery = jevAuthorizationQuestions() as AuthorizationBattery;
	const startedAt = performance.now();
	let result: JudgmentResult<AuthorizationBattery>;
	try {
		result = await judge.judge({ state: options.state as JudgmentState, questions: battery }, { signal });
	} catch (err) {
		throw new JevUnavailableError(`authorization judgment failed: ${err instanceof Error ? err.message : String(err)}`);
	}
	return toAuthorizationAnswer(result, battery, Math.round(performance.now() - startedAt));
}

function toAuthorizationAnswer(
	result: JudgmentResult<AuthorizationBattery>,
	battery: AuthorizationBattery,
	latencyMs: number,
): JevAuthorizationAnswer {
	const fieldError = (field: string, problem: string): JevUnavailableError =>
		new JevUnavailableError(`authorization answer field ${field} ${problem}`);
	const model = result.model;
	if (typeof model !== "string" || model === "") throw fieldError("model", "is missing or not a non-empty string");
	const answers = asRecord(result.answers);
	if (answers === undefined) throw fieldError("answers", "is missing or not an object");
	const answer = asRecord(answers.user_authorization);
	if (answer === undefined) throw fieldError("answers.user_authorization", "is missing or not an object");
	if (answer.type !== "choice") throw fieldError("answers.user_authorization.type", 'is missing or not "choice"');

	// The labels come from the question that was asked, not from a constant
	// here: every level the policy reads by name was in the battery.
	const labels = Object.keys(battery.user_authorization.criteria) as JevAuthorizationLevel[];
	const rawLevel = answer.choice;
	const level = typeof rawLevel === "string" ? labels.find(label => label === rawLevel) : undefined;
	if (level === undefined) throw fieldError("answers.user_authorization.choice", "is missing or not one of the question's options");
	const rawProbabilities = asRecord(answer.probabilities);
	if (rawProbabilities === undefined) throw fieldError("answers.user_authorization.probabilities", "is missing or not an object");
	const probabilities: Record<string, number> = {};
	for (const label of labels) {
		const value = unitNumber(rawProbabilities[label]);
		if (value === undefined) throw fieldError(`answers.user_authorization.probabilities.${label}`, "is missing or not a number in 0..1");
		probabilities[label] = value;
	}
	const confidence = unitNumber(answer.confidence);
	if (confidence === undefined) throw fieldError("answers.user_authorization.confidence", "is missing or not a number in 0..1");

	const usage = usageFrom(result.usage);
	return {
		model,
		level,
		probabilities,
		confidence,
		...(usage === undefined ? {} : { usage }),
		latencyMs,
		oneHot: result.api !== TYPESAFE_PROVIDER,
	};
}

/**
 * The judge for one classification, resolved from the extension context.
 *
 * TypeSafe in front and the online tiny/smol/default chain behind it
 * (`ONLINE_MEMORY_MODEL_KEY`), which is the native module's own precedence: a
 * TypeSafe failure degrades to a keyword judgment instead of to no judgment at
 * all, and that is the path whose answers come back flagged one-hot.
 *
 * `settings` must be the host instance, because a plugin-local
 * `import { settings }` is a second copy of the singleton with no instance
 * behind it and throws on the first read (see index.ts's header). Session
 * identity is only advisory to the judge — it scopes the session's credentials
 * and adds the session's model to the fallback chain — so a context that cannot
 * supply it must not cost the gate its judgment.
 */
function judgeForClassification(options: JudgeBatteryOptions): Judge {
	const { context, settings } = options;
	if (context === undefined || settings === undefined) {
		throw new JevUnavailableError(
			"no judge to ask: pass a resolved `judge`, or a `context` with the host `settings` instance",
		);
	}
	try {
		const deps: JudgeDeps = {
			settings,
			registry: context.modelRegistry,
			backend: ONLINE_MEMORY_MODEL_KEY,
			sessionModel: safely(() => context.models.current()),
			sessionId: safely(() => context.sessionManager.getSessionId()),
		};
		return resolveJudge(deps);
	} catch (err) {
		throw new JevUnavailableError(`judge unavailable: ${err instanceof Error ? err.message : String(err)}`);
	}
}

/** Read advisory session metadata; an isolated context's throw is not a reason
 *  to leave the gate without a verdict. */
function safely<T>(read: () => T): T | undefined {
	try {
		return read();
	} catch {
		return undefined;
	}
}

const asRecord = (value: unknown): Record<string, unknown> | undefined =>
	typeof value === "object" && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined;

const finiteNumber = (value: unknown): number | undefined =>
	typeof value === "number" && Number.isFinite(value) ? value : undefined;

/** Probability-shaped numbers: finite and inside 0..1. A noul of 1.4 or a
 *  confidence of -0.2 means the answer is not the shape this module consumes. */
const unitNumber = (value: unknown): number | undefined => {
	const unit = finiteNumber(value);
	return unit !== undefined && unit >= 0 && unit <= 1 ? unit : undefined;
};

/**
 * Validate one judge result into `JevAnswers`, or throw naming the field that
 * failed.
 *
 * The verdict's option labels come from the question that was asked, not from a
 * constant here: that is the stronger statement of the rule the policy depends
 * on — every option the policy reads by name was in the battery, and the answer
 * covers it. The blast-radius levels come from the same question, because the
 * native answer carries the score and its distribution but not the legend the
 * old HTTP response echoed back.
 */
function toJevAnswers(result: JudgmentResult<JevBattery>, battery: JevBattery, latencyMs: number): JevAnswers {
	const fieldError = (field: string, problem: string): JevUnavailableError =>
		new JevUnavailableError(`judgment answer field ${field} ${problem}`);
	const model = result.model;
	if (typeof model !== "string" || model === "") throw fieldError("model", "is missing or not a non-empty string");
	const answers = asRecord(result.answers);
	if (answers === undefined) throw fieldError("answers", "is missing or not an object");

	const verdictAnswer = asRecord(answers.verdict);
	if (verdictAnswer === undefined) throw fieldError("answers.verdict", "is missing or not an object");
	if (verdictAnswer.type !== "choice") throw fieldError("answers.verdict.type", 'is missing or not "choice"');
	const labels = Object.keys(battery.verdict.criteria) as JevChoiceOption[];
	const rawChoice = verdictAnswer.choice;
	const choice = typeof rawChoice === "string" ? labels.find(label => label === rawChoice) : undefined;
	if (choice === undefined) throw fieldError("answers.verdict.choice", "is missing or not one of the question's options");
	const rawProbabilities = asRecord(verdictAnswer.probabilities);
	if (rawProbabilities === undefined) throw fieldError("answers.verdict.probabilities", "is missing or not an object");
	const probabilities: Record<string, number> = {};
	for (const label of labels) {
		const value = unitNumber(rawProbabilities[label]);
		if (value === undefined) throw fieldError(`answers.verdict.probabilities.${label}`, "is missing or not a number in 0..1");
		probabilities[label] = value;
	}
	const confidence = unitNumber(verdictAnswer.confidence);
	if (confidence === undefined) throw fieldError("answers.verdict.confidence", "is missing or not a number in 0..1");

	const hazards = {} as Record<JevHazard, number>;
	for (const hazard of JEV_HAZARDS) {
		const answer = asRecord(answers[hazard]);
		if (answer === undefined) throw fieldError(`answers.${hazard}`, "is missing or not an object");
		if (answer.type !== "noul") throw fieldError(`answers.${hazard}.type`, 'is missing or not "noul"');
		const value = unitNumber(answer.noul);
		if (value === undefined) throw fieldError(`answers.${hazard}.noul`, "is missing or not a number in 0..1");
		hazards[hazard] = value;
	}

	const blastAnswer = asRecord(answers.blast_radius);
	if (blastAnswer === undefined) throw fieldError("answers.blast_radius", "is missing or not an object");
	if (blastAnswer.type !== "score") throw fieldError("answers.blast_radius.type", 'is missing or not "score"');
	// The score is checked for finite and non-negative only. Its upper end is a
	// probability-weighted position that can sit above the top level index, and
	// clamping to the levels is the server's documented behavior; a score above
	// the top level can only push the value toward the UNSURE floor, never past it.
	const score = finiteNumber(blastAnswer.score);
	if (score === undefined || score < 0) throw fieldError("answers.blast_radius.score", "is missing or not a non-negative number");
	const blastConfidence = unitNumber(blastAnswer.confidence);
	if (blastConfidence === undefined) throw fieldError("answers.blast_radius.confidence", "is missing or not a number in 0..1");

	const usage = usageFrom(result.usage);
	return {
		model,
		verdict: { choice, probabilities, confidence },
		hazards,
		blastRadius: { score, confidence: blastConfidence, levels: battery.blast_radius.criteria },
		...(usage === undefined ? {} : { usage }),
		latencyMs,
		oneHot: result.api !== TYPESAFE_PROVIDER,
	};
}

/**
 * The judge's usage mapped onto the two counters the answer shape carries. The
 * native `Usage` also has cache counters and a cost breakdown; those are dropped
 * rather than widened here, because JevAnswers.usage is what the audit line and
 * the dialog know how to print. An answer set whose usage is unusable simply
 * carries none.
 */
function usageFrom(usage: Usage | undefined): JevAnswers["usage"] {
	if (usage === undefined) return undefined;
	const mapped: { input_tokens?: number; output_tokens?: number } = {};
	const input = finiteNumber(usage.input);
	if (input !== undefined && input >= 0) mapped.input_tokens = input;
	const output = finiteNumber(usage.output);
	if (output !== undefined && output >= 0) mapped.output_tokens = output;
	return Object.keys(mapped).length === 0 ? undefined : mapped;
}
