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
	JEV_V3_POLICY_VERSION,
	JevUnavailableError,
	jevQuestions,
	type JevAnswers,
	type JevBatteryVersion,
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
	/** Which battery to ask. Omitted, it is the live jev-v2 battery. */
	version?: JevBatteryVersion;
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
 * The REQUEST half of the split (issue #62): ask the whole battery about one
 * state and map the answers into `JevAnswers`.
 *
 * `signal` is the request's own control, not the gate's deadline — the two are
 * separate on purpose. The shadow and the eval harness hand in
 * `AbortSignal.timeout(...)`, where aborting the request IS the failure policy,
 * because neither wants a verdict after the fact. The live path hands in a
 * cancellation signal and owns the deadline itself (`judgeBatteryUnderDeadline`
 * below): aborting the transport destroys the answer it was waiting for, and
 * the issue is exactly that the answer lands a beat late.
 *
 * `undefined` leaves the native timeouts in charge. One call, no retries of our
 * own and no second opinion: the judge already retries its own transients, and
 * a request that could not be answered has to surface as no judgment rather
 * than as a guess.
 *
 * Throws `JevUnavailableError` for every failure, so the caller's `catch` is
 * the whole availability policy.
 */
export async function judgeBattery(signal: AbortSignal | undefined, options: JudgeBatteryOptions): Promise<JevAnswers> {
	const judge = options.judge ?? judgeForClassification(options);
	const battery = jevQuestions(options.version) as JevBattery;
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

/** How long past the deadline the gate keeps listening for a late answer
 *  (issue #62): `min(2 x timeoutMs, 30s)`. The dialog may outlive the request,
 *  but not by more than this — a wedged provider must not hold a socket for the
 *  rest of the session. */
const MAX_LATE_LISTEN_MS = 30_000;

/** A judgment whose deadline fired while its request was still in flight
 *  (issue #62). The answer it eventually produces is worth keeping: it can
 *  refine the dialog the deadline opened, and nothing else. */
export interface LateAnswers {
	/** The late answers, or undefined when the request was cancelled (the
	 *  human answered first) or the listen window closed. Never rejects. */
	answers: Promise<JevAnswers | undefined>;
	/** Stop listening and abort the in-flight request. */
	cancel(): void;
}

/** How one judgment request ended under its deadline. `deadline` is not a
 *  failure: the request is still running, and `late` carries what a late
 *  answer can still do. */
export type BatteryOutcome =
	| { kind: "answered"; answers: JevAnswers }
	| { kind: "failed"; error: unknown }
	| { kind: "deadline"; late: LateAnswers };

export interface JudgeBatteryDeadlineOptions extends JudgeBatteryOptions {
	/** The caller's deadline in millis (config `timeoutMs`). */
	timeoutMs: number;
}

/**
 * The judge half of the split (issue #62): ask the battery under a deadline
 * WITHOUT giving up on the answer the deadline was waiting for.
 *
 * The request owns its signal and the deadline is a race, not an abort. That is
 * the whole fix: `judgeBattery(AbortSignal.timeout(timeoutMs), ...)` killed the
 * transport at the deadline, so the judgment that finished a beat later was
 * discarded and the user answered a dialog that said nothing but "the gate
 * broke". Here the deadline reports `UNAVAILABLE` to the caller as before, and
 * `late` hands back the answer when it lands: the caller (classify, then
 * requestPermission) turns a late SAFE into a dismissal or a late UNSAFE into a
 * reasoned dialog, never into a bypass.
 *
 * Listening stops at `min(2 x timeoutMs, 30s)` past the deadline, or as soon as
 * the caller cancels, and either one aborts the request. A cancel leaves the
 * window timer armed, because it can still fire: it then aborts an already
 * settled request and resolves nothing twice, so no handle has to be kept just
 * to disarm it.
 */
export async function judgeBatteryUnderDeadline(options: JudgeBatteryDeadlineOptions): Promise<BatteryOutcome> {
	const { timeoutMs, ...request } = options;
	const controller = new AbortController();
	const pending = judgeBattery(controller.signal, request);
	const { promise: deadlineReached, resolve: reachDeadline } = Promise.withResolvers<undefined>();
	const { promise: late, resolve: settleLate } = Promise.withResolvers<JevAnswers | undefined>();
	const deadlineTimer = setTimeout(() => reachDeadline(undefined), timeoutMs);
	let lateSettled = false;
	const settle = (answers: JevAnswers | undefined): void => {
		if (lateSettled) return;
		lateSettled = true;
		settleLate(answers);
	};
	// Attached before the race so an answer that lands after the deadline is
	// already routed to `settle`, and so a failure is never unhandled.
	void pending.then(
		answers => settle(answers),
		() => settle(undefined),
	);
	// One body for both ways listening ends, so a cancel and a closed window
	// cannot drift apart.
	const stopListening = (): void => {
		controller.abort();
		settle(undefined);
	};
	const outcome = await Promise.race([
		pending.then(
			(answers): BatteryOutcome => ({ kind: "answered", answers }),
			(error): BatteryOutcome => ({ kind: "failed", error }),
		),
		deadlineReached.then((): BatteryOutcome => ({ kind: "deadline", late: { answers: late, cancel: stopListening } })),
	]);
	if (outcome.kind !== "deadline") {
		clearTimeout(deadlineTimer);
		return outcome;
	}
	setTimeout(stopListening, Math.min(2 * timeoutMs, MAX_LATE_LISTEN_MS));
	return outcome;
}

/** How far a returned distribution may sit from summing to 1 before it stops
 *  being a distribution. Wide enough for rounding at two decimals, narrow
 *  enough that three independent 0.8s cannot pass. */
const DISTRIBUTION_TOLERANCE = 0.05;

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

export interface JevV3Judgment {
	risk: JevAnswers;
	/** Undefined when the authorization request failed; `deriveAuthorization`
	 *  reads that as `none`. */
	authorization: JevAuthorizationAnswer | undefined;
	/** Why the authorization request failed, for the audit line. */
	authorizationError?: string;
}

/**
 * Ask the jev-v3 risk battery and the authorization question in parallel,
 * each over its own state. Wall time is the slower of the two.
 *
 * The two failures are not equal. A risk request that fails throws
 * `JevUnavailableError`, because there is no judgment without it. An
 * authorization request that fails only costs the command its fast path: the
 * result carries `authorization: undefined` and the risk answer still decides.
 */
export async function judgeJevV3(
	signal: AbortSignal | undefined,
	options: Omit<JudgeBatteryOptions, "state" | "version"> & { riskState: unknown; authorizationState: unknown },
): Promise<JevV3Judgment> {
	const { riskState, authorizationState, ...rest } = options;
	// Resolved once so both requests ask the same judge.
	const judge = rest.judge ?? judgeForClassification({ ...rest, state: riskState });
	const [risk, authorization] = await Promise.allSettled([
		judgeBattery(signal, { judge, state: riskState, version: JEV_V3_POLICY_VERSION }),
		judgeAuthorization(signal, { judge, state: authorizationState }),
	]);
	if (risk.status === "rejected") throw risk.reason;
	if (authorization.status === "fulfilled") return { risk: risk.value, authorization: authorization.value };
	const reason = authorization.reason;
	return { risk: risk.value, authorization: undefined, authorizationError: reason instanceof Error ? reason.message : String(reason) };
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
	// Each probability being in 0..1 is not a distribution. `{none: 0.8, goal:
	// 0.8, named: 0.8}` passes every per-value check and would clear the
	// `named` floor while saying nothing, and a `choice` that is not the
	// argmax is an answer disagreeing with itself. Both are no answer.
	const total = Object.values(probabilities).reduce((sum, value) => sum + value, 0);
	if (Math.abs(total - 1) > DISTRIBUTION_TOLERANCE) {
		throw fieldError("answers.user_authorization.probabilities", `sums to ${total.toFixed(2)} rather than 1`);
	}
	if (labels.some(label => probabilities[label] > probabilities[level])) {
		throw fieldError("answers.user_authorization.choice", "is not the option with the most probability");
	}

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
 * TypeSafe in front with nothing behind it: the gate never degrades to a
 * keyword judge. The host's judge-role chain (modelRoles.judge, primary
 * `typesafe/jev-latest`; `retry.fallbackChains.judge: []` pins off the
 * built-in tiny/smol chain) is the whole candidate list, and `sessionModel`
 * is deliberately absent from the deps — the host's ChainJudge appends the
 * session's chat model when given it, which would let a TypeSafe outage
 * produce a chat-derived verdict. Every unavailability must surface as
 * JevUnavailableError and a permission request instead (see
 * tests/fallback.test.ts).
 *
 * `settings` must be the host instance, because a plugin-local
 * `import { settings }` is a second copy of the singleton with no instance
 * behind it and throws on the first read (see index.ts's header). Session
 * identity is only advisory to the judge — it scopes the session's
 * credentials — so a context that cannot supply it must not cost the gate
 * its judgment.
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
			// 18.2.4's JudgeDeps requires `backend`; the 18.3 ChainJudge ignores
			// it. What matters for fail-closed is the absent `sessionModel`:
			// without it the chain ends after the configured judge role, so an
			// unreachable TypeSafe endpoint is an outage, not a weaker verdict
			// from whatever model the session is using.
			backend: ONLINE_MEMORY_MODEL_KEY,
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
