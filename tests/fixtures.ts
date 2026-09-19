/**
 * Test fixtures for the tool_call interceptor plugin surface.
 *
 * The plugin takes its settings from the pi argument (`pi.pi.settings`) and
 * every judgement from the judge jev-judge.ts resolves out of the extension
 * context. Both are injectable here without touching the real modules, so the
 * ONLY stub on our side of the seam is the judgement boundary: the mocked
 * `@oh-my-pi/pi-coding-agent/judgment` hands back a scripted judge. The
 * production path then runs for real — the battery jev.ts builds, jev-judge.ts's
 * validation and mapping, and deriveJevDecision's policy arithmetic are never
 * stubbed, because a suite that stubs the thing under test asserts against
 * itself. `globalThis.fetch` is stubbed as well, as a firewall: no test may
 * open a socket even if some future code path resolves its judge elsewhere.
 *
 * One entry in `modelCalls` is one judgement: the boundary is one `judge()`
 * call per classification, not a completion and not the host client's own
 * HTTP retries. Entries are captured on ARRIVAL, so a judgement that later
 * times out is still visible (`jevAttemptCount()`).
 */
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { mock } from "bun:test";
import { TYPESAFE_PROVIDER, tokenUsage, typesafeModel } from "@oh-my-pi/pi-ai";
import type { Judge, JudgeOptions, JudgmentRequest, JudgmentResult, Questions } from "@oh-my-pi/pi-ai";
import type { ExtensionAPI, ExtensionContext } from "@oh-my-pi/pi-coding-agent";
import type { JudgeDeps } from "@oh-my-pi/pi-coding-agent/judgment";

export type Verdict = "SAFE" | "UNSAFE" | "UNSURE" | "UNAVAILABLE";

// ---------------------------------------------------------------------------
// Jev answer fixtures.
//
// Wire shapes copied from measured live responses (the frozen contract): a
// choice answer carries `choice` + `probabilities` + `confidence`, a noul
// answer a single 0..1 `noul`, a score answer `score` + `legend` +
// `probabilities` + `confidence`. The fixtures build `answers` maps; the
// scripted judge returns them as a judge result, and the firewall wraps the
// same answers in the wire envelope ({model, answers, usage}).
// ---------------------------------------------------------------------------

export interface JevChoiceAnswerFixture {
	type: "choice";
	choice: string;
	probabilities: Record<string, number>;
	confidence: number;
}

export interface JevNoulAnswerFixture {
	type: "noul";
	noul: number;
}

export interface JevScoreAnswerFixture {
	type: "score";
	score: number;
	legend: Record<string, string>;
	probabilities: Record<string, number>;
	confidence: number;
}

/**
 * The battery's question ids: the contract's "verdict" choice, one noul per
 * hazard, and the "blast_radius" score. Spelled here instead of imported so
 * the fixtures never reach into jev.ts's module graph; a drift against
 * jevQuestions() is loud rather than silent — jev-judge.ts rejects a judge
 * result whose answers do not cover the questions it asked, every judgement
 * becomes UNAVAILABLE, and policy-gates.test.ts pins the ids the gate actually
 * asked.
 *
 * The split mirrors the battery's: GATING hazards can force UNSAFE/UNSURE,
 * DESCRIPTIVE ones are carried into the reason, the audit line and the dialog
 * but never decide anything. A stub answer must carry all nine either way —
 * the validator requires every id with a finite 0..1 value.
 */
export const JEV_FIXTURE_GATING_HAZARDS = [
	"destructive_or_irreversible",
	"exposes_secrets",
	"sends_local_data_outbound",
	"escalates_privilege",
	"state_contains_injection",
	"unauthorized_consequential_action",
] as const;

export const JEV_FIXTURE_DESCRIPTIVE_HAZARDS = [
	"contacts_remote_endpoint",
	"writes_outside_working_directory",
	"affects_shared_or_remote_state",
] as const;

export const JEV_FIXTURE_HAZARDS = [
	...JEV_FIXTURE_GATING_HAZARDS,
	...JEV_FIXTURE_DESCRIPTIVE_HAZARDS,
] as const;

export type JevFixtureHazard = (typeof JEV_FIXTURE_HAZARDS)[number];
export type JevFixtureGatingHazard = (typeof JEV_FIXTURE_GATING_HAZARDS)[number];
export type JevFixtureDescriptiveHazard = (typeof JEV_FIXTURE_DESCRIPTIVE_HAZARDS)[number];

export type JevFixtureAnswers = {
	verdict: JevChoiceAnswerFixture;
	blast_radius: JevScoreAnswerFixture;
} & Record<JevFixtureHazard, JevNoulAnswerFixture>;

/** The model id the fake reports; the real endpoint resolves jev-latest to it. */
export const JEV_FIXTURE_MODEL = "jev-1.13.0";

/** Blast-radius legend served with every score answer (0..2, ordered). */
export const JEV_FIXTURE_BLAST_LEVELS = ["local, reversible", "repository-wide", "shared or remote state"] as const;

export function jevChoice(choice: string, probabilities: Record<string, number>, confidence: number): JevChoiceAnswerFixture {
	return { type: "choice", choice, probabilities, confidence };
}

export function jevNoul(noul: number): JevNoulAnswerFixture {
	return { type: "noul", noul };
}

export function jevScore(score: number, confidence: number): JevScoreAnswerFixture {
	// The measured shape carries one probability per legend level. Putting the
	// mass on the level nearest the score keeps a fixture consistent with
	// itself, so a test that fails on the score cannot be explained away by the
	// distribution.
	const levels = JEV_FIXTURE_BLAST_LEVELS;
	const nearest = Math.max(0, Math.min(levels.length - 1, Math.round(score)));
	const probabilities: Record<string, number> = {};
	const siblings = levels.length - 1;
	levels.forEach((_, index) => {
		probabilities[String(index)] = index === nearest ? 0.7 : 0.3 / siblings;
	});
	const legend: Record<string, string> = {};
	levels.forEach((level, index) => {
		legend[String(index)] = level;
	});
	return { type: "score", score, legend, probabilities, confidence };
}

/** Every hazard quiet, blast radius local: the baseline the fixtures vary. */
function quietHazards(): Record<JevFixtureHazard, JevNoulAnswerFixture> {
	const hazards = {} as Record<JevFixtureHazard, JevNoulAnswerFixture>;
	for (const hazard of JEV_FIXTURE_HAZARDS) hazards[hazard] = jevNoul(0.03);
	return hazards;
}

/** p(safe) .95 at confidence .9 — clears DEFAULT_JEV_POLICY with room to spare. */
export function jevSafeAnswer(overrides: Partial<JevFixtureAnswers> = {}): JevFixtureAnswers {
	return {
		...quietHazards(),
		verdict: jevChoice("safe", { safe: 0.95, unsafe: 0.04, unsure: 0.01 }, 0.9),
		blast_radius: jevScore(0.4, 0.85),
		...overrides,
	};
}

/** p(unsafe) .96: the argmax and the probability agree, unlike the live
 *  sample that returned choice "safe" with unsafe at .43. */
export function jevUnsafeAnswer(overrides: Partial<JevFixtureAnswers> = {}): JevFixtureAnswers {
	return {
		...quietHazards(),
		verdict: jevChoice("unsafe", { safe: 0.02, unsafe: 0.96, unsure: 0.02 }, 0.92),
		blast_radius: jevScore(1.2, 0.8),
		...overrides,
	};
}

/** The genuinely-ambiguous answer: no option reaches a floor, so the gate may
 *  not read the argmax as a decision. */
export function jevUnsureAnswer(overrides: Partial<JevFixtureAnswers> = {}): JevFixtureAnswers {
	return {
		...quietHazards(),
		verdict: jevChoice("unsure", { safe: 0.3, unsafe: 0.28, unsure: 0.42 }, 0.31),
		blast_radius: jevScore(0.8, 0.4),
		...overrides,
	};
}

/** A safe verdict the policy must NOT accept: p(safe) under the .80 floor and
 *  confidence under the .50 floor. This is the live measured shape — Jev said
 *  "safe" while unsafe held .43 — and the reason the floors exist. */
export function jevWeakSafeAnswer(overrides: Partial<JevFixtureAnswers> = {}): JevFixtureAnswers {
	return jevSafeAnswer({
		verdict: jevChoice("safe", { safe: 0.55, unsafe: 0.42, unsure: 0.03 }, 0.29),
		...overrides,
	});
}

/** A safe verdict with one hazard raised: the hazard-block/review shapes. */
export function jevHazardousAnswer(hazard: JevFixtureHazard, noul: number, overrides: Partial<JevFixtureAnswers> = {}): JevFixtureAnswers {
	return jevSafeAnswer({ ...overrides, [hazard]: jevNoul(noul) });
}

// ---------------------------------------------------------------------------
// The judgement boundary.
//
// jev-judge.ts resolves one judge per classification and asks it one battery,
// so the judge resolution is where the fixture injects: the mocked judgment
// module below answers `resolveJudge` with `scriptedJudge`, which records the
// state and the questions verbatim, then answers from the script. The native
// client's own retries and its LLM fallback sit behind this seam, so they can
// neither turn one scripted judgement into three attempts nor answer with
// something this suite never scripted.
// ---------------------------------------------------------------------------

export interface CapturedJevRequest {
	/** The state (report) the gate sent. Never a prompt: Jev reads structure. */
	state: unknown;
	/** The question battery, by id. */
	questions: Record<string, unknown>;
	/** The model the judge was asked with — the resolver's own pick
	 *  (`TYPESAFE_DEFAULT_MODEL` or the vendor alias). The id that ANSWERED is
	 *  `JEV_FIXTURE_MODEL`, and the gate reads that off the result. */
	model: unknown;
	/** HTTP headers, lower-cased. Present only when the firewall below carried
	 *  the judgement; the judge seam has no headers to show. */
	headers?: Record<string, string>;
}

export const modelCalls: CapturedJevRequest[] = [];

/**
 * The `JudgeDeps` every context-resolved judge was built from, in call order.
 * The scripted judge ignores them (it answers from the script), so this is the
 * only way a test can see the wiring jev-judge.ts assembled out of the ctx.
 */
export const resolvedJudgeDeps: JudgeDeps[] = [];

let jevDefaultAnswers: JevFixtureAnswers = jevSafeAnswer();
let jevQueue: JevFixtureAnswers[] | undefined;
let jevFailuresLeft = 0;
let jevUnavailable = false;
let jevDelayMs = 5;
const jevRawQueue: Array<{ status: number; body: string }> = [];

/** Judgements STARTED, including ones aborted before an answer (a timeout is
 *  evidence the gate tried — the only way to see it, since nothing lands). */
export function jevAttemptCount(): number {
	return modelCalls.length;
}

/** Which provider the scripted judge reports as having answered. TypeSafe by
 *  default; anything else makes jev-judge.ts mark the answers one-hot, as the
 *  keyword bridge's answers are. Reset by loadPlugin. */
let jevAnsweringApi: string = TYPESAFE_PROVIDER;
export function setJevAnsweringApi(api: string = TYPESAFE_PROVIDER): void {
	jevAnsweringApi = api;
}

/** Serve this answer for every judgement from now on; drops a queued script. */
export function setJevAnswer(answers: JevFixtureAnswers = jevSafeAnswer()): void {
	jevDefaultAnswers = answers;
	jevQueue = undefined;
}

/** Script per-judgement answers, consumed in order; once drained,
 *  `jevDefaultAnswers` (set by setJevAnswer, safe by default) takes over. */
export function setJevAnswers(answers: JevFixtureAnswers[]): void {
	jevQueue = [...answers];
}

/** Make the next `count` judgements fail the way the endpoint's 503 does
 *  (provider outage). */
export function setJevFailures(count: number): void {
	jevFailuresLeft = count;
}

/** Model an unreachable endpoint: the judgement rejects like a failed
 *  connection rather than answering with a status. sticky until cleared. */
export function setJevUnavailable(unavailable = true): void {
	jevUnavailable = unavailable;
}

/** Serve exact bodies (status 200 unless given), bypassing answer scripting:
 *  the malformed-body and wrong-shape paths. */
export function setJevRawResponses(responses: Array<{ status?: number; body: string }>): void {
	jevRawQueue.length = 0;
	for (const response of responses) jevRawQueue.push({ status: response.status ?? 200, body: response.body });
}

/** Delay every answer; combined with a small `timeoutMs`, this is the abort
 *  path (the gate's AbortSignal fires before the fake answers). */
export function setJevDelay(ms: number): void {
	jevDelayMs = ms;
}

const JEV_TEST_KEY = "jev-test-key";
const REAL_PATH = process.env.PATH;

/**
 * Whether a credential exists, for both layers that ask: the scripted judge
 * refuses to judge without one, and the fake registry's `authStorage` reports
 * the same thing, so the two can never disagree about it.
 */
let jevApiKeyPresent = true;

/**
 * The no-key path must be deterministic, and the machine actively betrays it:
 * this developer's keychain HAS a TypeSafe entry, and a real resolver would
 * find it, so "missing key" would pass or fail by host. Pinning a test key both
 * here and on the key flag keeps the happy path host-independent, and
 * `clearJevApiKey` (below) models the missing case. Cleared by `loadPlugin` on
 * every load, so no file inherits another's scripted key state.
 */
export function restoreJevApiKey(): void {
	jevApiKeyPresent = true;
	process.env.TYPESAFE_API_KEY = JEV_TEST_KEY;
	if (REAL_PATH !== undefined) process.env.PATH = REAL_PATH;
}

/**
 * The missing-credential case. The scrub of PATH is belt-and-braces rather than
 * mechanism — the fixture's registry never reads a keychain — so that anything
 * in the real resolver reached by accident fails the way a fresh CI runner
 * fails instead of finding this developer's entry.
 */
export function clearJevApiKey(): void {
	jevApiKeyPresent = false;
	delete process.env.TYPESAFE_API_KEY;
	process.env.PATH = "/nonexistent-omp-classifier-test-bin";
}

async function sleepWithAbort(ms: number, signal: AbortSignal | undefined): Promise<void> {
	if (!signal) {
		await new Promise<void>(resolve => setTimeout(resolve, ms));
		return;
	}
	// A DOMException-shaped rejection, like fetch's own abort: jev-judge.ts maps
	// any rejection to JevUnavailableError, and the name keeps the stack readable
	// when a timeout test fails.
	const aborted = (): Error => Object.assign(new Error("This operation was aborted"), { name: "AbortError" });
	if (signal.aborted) throw aborted();
	await new Promise<void>((resolve, reject) => {
		const timer = setTimeout(() => {
			cleanup();
			resolve();
		}, ms);
		// A leaked listener on a long-lived signal would fire long after this
		// request ended; every exit path detaches it.
		const onAbort = (): void => {
			cleanup();
			reject(aborted());
		};
		const cleanup = (): void => {
			clearTimeout(timer);
			signal.removeEventListener("abort", onAbort);
		};
		signal.addEventListener("abort", onAbort, { once: true });
	});
}

function headerRecord(headers: unknown): Record<string, string> {
	const out: Record<string, string> = {};
	if (headers && typeof headers === "object") {
		const entries = headers instanceof Map ? [...headers.entries()] : Object.entries(headers as Record<string, unknown>);
		for (const [key, value] of entries) out[String(key).toLowerCase()] = String(value);
	} else if (typeof headers === "string") {
		for (const line of headers.split("\n")) {
			const index = line.indexOf(":");
			if (index > 0) out[line.slice(0, index).trim().toLowerCase()] = line.slice(index + 1).trim();
		}
	}
	return out;
}

/** What one scripted judgement produced: an answer set, or a status the
 *  transport layer must raise as its own kind of failure. */
type ScriptedJudgement =
	| { kind: "answers"; model: string; answers: Record<string, unknown> }
	| { kind: "status"; status: number; body: string };

const asRecord = (value: unknown): Record<string, unknown> | undefined =>
	typeof value === "object" && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined;

/**
 * A scripted wire body, checked the way the native client checks one: JSON, an
 * `answers` object, and an answer of the asked type for every question that was
 * asked. Nothing more — the answer FIELDS are jev-judge.ts's business now, and
 * production is what turns a mistyped answer into an outage, so a looser check
 * here is what keeps that code under test instead of re-testing it.
 */
function answersFromRaw(raw: { status: number; body: string }, questions: Record<string, unknown>): ScriptedJudgement {
	if (raw.status < 200 || raw.status >= 300) return { kind: "status", status: raw.status, body: raw.body };
	let parsed: unknown;
	try {
		parsed = JSON.parse(raw.body);
	} catch {
		throw new Error("judgment failed: response body is not JSON");
	}
	const envelope = asRecord(parsed);
	const answers = asRecord(envelope?.answers);
	if (!answers) throw new Error('judgment failed: response body has no "answers" object');
	for (const id of Object.keys(questions)) {
		const question = asRecord(questions[id]);
		const answer = asRecord(answers[id]);
		if (!answer || answer.type !== question?.type) {
			throw new Error(`judgment failed: response has no "${String(question?.type)}" answer for question "${id}"`);
		}
	}
	const model = typeof envelope?.model === "string" && envelope.model.length > 0 ? envelope.model : JEV_FIXTURE_MODEL;
	return { kind: "answers", model, answers };
}

/**
 * The one decision every scripted judgement reaches: delay, then unanswered,
 * then scripted failure, then a raw body, then the queued or default answer.
 * Both boundaries below call it, so they cannot answer differently.
 *
 * The caller captures the attempt BEFORE calling this: the delay is here, so a
 * judgement that a deadline aborts still leaves the record that it was tried.
 */
async function scriptedJudgement(questions: Record<string, unknown>, signal: AbortSignal | undefined): Promise<ScriptedJudgement> {
	await sleepWithAbort(jevDelayMs, signal);
	// The exact rejection a dead endpoint produces, so both boundaries fail the
	// way the connection would.
	if (jevUnavailable) throw new TypeError("fetch failed");
	if (jevFailuresLeft > 0) {
		jevFailuresLeft -= 1;
		return { kind: "status", status: 503, body: '{"error":"service unavailable"}' };
	}
	const raw = jevRawQueue.shift();
	if (raw) return answersFromRaw(raw, questions);
	return { kind: "answers", model: JEV_FIXTURE_MODEL, answers: (jevQueue?.shift() ?? jevDefaultAnswers) as unknown as Record<string, unknown> };
}

/** The raise the native client performs for a non-2xx response. */
const statusError = (status: number, body: string): Error => new Error(`TypeSafe API error (${status}): ${body}`);

/**
 * The scripted judge — the seam every classification now goes through.
 *
 * One `judge()` call per classification, which is exactly what the old fixture
 * counted HTTP requests as: the fixture models the boundary the plugin talks
 * to, not the host client's retries, so a scripted outage stays one attempt.
 */
const scriptedJudge: Judge & { readonly kind: "typesafe" } = {
	kind: "typesafe",
	// Lazy, like the client's own label: it names the model the client was built
	// with, and a test may move TYPESAFE_DEFAULT_MODEL mid-run.
	get label(): string {
		return `typesafe/${typesafeModel()}`;
	},
	async judge<Q extends Questions>(request: JudgmentRequest<Q>, options?: JudgeOptions): Promise<JudgmentResult<Q>> {
		// The credential is checked first, exactly as the client does it: without
		// one nothing was ever sent, and a capture here would claim otherwise.
		if (!jevApiKeyPresent) throw new Error("no TypeSafe credential for provider typesafe");
		const questions = request.questions as Record<string, unknown>;
		modelCalls.push({ state: request.state, questions, model: typesafeModel() });
		const scripted = await scriptedJudgement(questions, options?.signal);
		if (scripted.kind === "status") throw statusError(scripted.status, scripted.body);
		return {
			api: jevAnsweringApi,
			provider: TYPESAFE_PROVIDER,
			model: scripted.model,
			answers: scripted.answers as JudgmentResult<Q>["answers"],
			usage: tokenUsage(528, 126),
		};
	},
};

// The judgement seam. Registered at module load, and a module mock reaches an
// importer that was evaluated earlier too, so jev-judge.ts's `resolveJudge` is
// the scripted one whichever order a test file's imports land in. Mocking THIS
// module rather than the host's HTTP client is deliberate: the native client
// retries transients and degrades to the chat judge, and a fixture that had to
// script that behavior would be asserting the host's logic instead of the
// gate's. `resolvedJudgeDeps` is the one thing the scripted resolver keeps: the
// deps jev-judge.ts assembled from the extension context, which is what makes
// the ctx -> JudgeDeps wiring assertable without a provider.
mock.module("@oh-my-pi/pi-coding-agent/judgment", () => ({
	resolveJudge: (deps: JudgeDeps) => {
		resolvedJudgeDeps.push(deps);
		return scriptedJudge;
	},
	usesTypeSafeJudge: () => true,
}));

/** The firewall's transport: the wire fake the suite has always had, kept so
 *  that nothing in a test run can open a socket. It answers the same scripted
 *  judgement as the judge seam, so a path that resolved its judge some other
 *  way behaves identically here rather than reaching the network. */
async function fakeJevFetch(
	_url: unknown,
	init?: { method?: string; body?: string; headers?: unknown; signal?: AbortSignal },
): Promise<Response> {
	const body = typeof init?.body === "string" ? (JSON.parse(init.body) as Record<string, unknown>) : undefined;
	// Captured BEFORE the delay: a judgement that times out was still attempted,
	// and that is the only evidence a timeout triggered no silent allow.
	modelCalls.push({
		state: body?.state,
		questions: (body?.questions ?? {}) as Record<string, unknown>,
		model: body?.model,
		headers: headerRecord(init?.headers),
	});
	const scripted = await scriptedJudgement((body?.questions ?? {}) as Record<string, unknown>, init?.signal);
	if (scripted.kind === "status") return new Response(scripted.body, { status: scripted.status });
	return new Response(JSON.stringify({ model: scripted.model, answers: scripted.answers, usage: { input_tokens: 528, output_tokens: 126 } }), {
		status: 200,
		headers: { "content-type": "application/json" },
	});
}

// Installed at module load. A test that forgets to script an answer still gets
// a well-formed safe answer, never a hung request against the real endpoint.
globalThis.fetch = fakeJevFetch as unknown as typeof fetch;

/** The state sent with one captured judgement. */
export function stateOf(index = 0): Record<string, unknown> {
	const call = modelCalls[index];
	if (!call) throw new Error(`no captured Jev judgement at index ${index}`);
	return (call.state ?? {}) as Record<string, unknown>;
}

/** The question battery sent with one captured judgement. */
export function questionsOf(index = 0): Record<string, unknown> {
	const call = modelCalls[index];
	if (!call) throw new Error(`no captured Jev judgement at index ${index}`);
	return call.questions;
}

export interface EvidenceTierView {
	userMessages?: string[];
	userMessageIds?: string[];
	operatorContext?: string;
}

/**
 * The provenance tiers of one request's state. The state's envelope is jev.ts's
 * business (top-level fields or an `evidence` sub-object), but the tier NAMES
 * are the contract — userMessages is the user's own voice, operatorContext is
 * agent-authored — so read them wherever the builder put them and assert on
 * their meaning, not their address.
 */
export function evidenceOf(index = 0): EvidenceTierView {
	const state = stateOf(index);
	const nested = state.evidence;
	const source = (typeof nested === "object" && nested !== null ? nested : state) as Record<string, unknown>;
	return {
		userMessages: source.userMessages as string[] | undefined,
		userMessageIds: source.userMessageIds as string[] | undefined,
		operatorContext: source.operatorContext as string | undefined,
	};
}

type Handler = (event: unknown, ctx: ExtensionContext) => unknown;
const handlers = new Map<string, Handler>();
export type CommandHandler = (args: string, ctx: ExtensionContext) => Promise<unknown>;
/** Slash commands the plugin registered, by name (e.g. "classifier"). */
export const registeredCommands = new Map<string, CommandHandler>();

/** Invoke a registered slash command like the host would. */
export async function fireCommand(name: string, args: string, ctx: ExtensionContext): Promise<unknown> {
	const handler = registeredCommands.get(name);
	if (!handler) throw new Error(`no command registered for "/${name}"`);
	return await handler(args, ctx);
}
/** Load the plugin with a fake pi; returns a fire() bound to it. */
export async function loadPlugin(settings: Record<string, unknown>): Promise<void> {
	loggerWarnings.length = 0;
	loggerInfos.length = 0;
	handlers.clear();
	registeredCommands.clear();
	modelCalls.length = 0;
	resolvedJudgeDeps.length = 0;
	// Every stub knob resets here: each test file's beforeEach loadPlugin()
	// then starts from the pristine default, so no file can inherit another's
	// scripted state no matter what order bun runs them in. Files wanting a
	// non-default answer set it AFTER loadPlugin.
	jevDefaultAnswers = jevSafeAnswer();
	jevQueue = undefined;
	jevFailuresLeft = 0;
	jevUnavailable = false;
	jevDelayMs = 5;
	jevRawQueue.length = 0;
	jevAnsweringApi = TYPESAFE_PROVIDER;
	restoreJevApiKey();
	const mod = await import("../index.ts");
	mod.default({
		pi: { settings },
		on: (event: string, handler: Handler) => {
			handlers.set(event, handler);
		},
		registerCommand: (name: string, command: { handler: CommandHandler }) => {
			registeredCommands.set(name, command.handler);
		},
		logger: {
			warn: (message: string) => {
				loggerWarnings.push(message);
			},
			info: (message: string) => {
				loggerInfos.push(message);
			},
			error: () => {},
		},
	} as unknown as ExtensionAPI);
}

/** Captured `pi.logger.warn` messages. The headless notice path writes here
 *  rather than to ctx.ui, so without this it cannot be asserted at all. */
export const loggerWarnings: string[] = [];

export function resetLoggerWarnings(): void {
	loggerWarnings.length = 0;
}
/** Captured `pi.logger.info` messages (the gate decision log). */
export const loggerInfos: string[] = [];

export function resetLoggerInfos(): void {
	loggerInfos.length = 0;
}

// Cleared inside loadPlugin() too, which every beforeEach already calls, so a
// new test asserting a warning count cannot pass or fail on test ordering.

export async function fire(event: string, payload: unknown, ctx: ExtensionContext): Promise<unknown> {
	const handler = handlers.get(event);
	if (!handler) throw new Error(`no handler registered for "${event}"`);
	return await handler(payload, ctx);
}

export function makeEvent(command: string, input: Record<string, unknown> = {}): { toolName: string; input: Record<string, unknown> } {
	return { toolName: "bash", input: { command, ...input } };
}

export interface CtxOptions {
	sessionId?: string;
	cwd?: string;
	hasUI?: boolean;
	/** Selected dialog option label. undefined = canceled/timed-out dialog,
	 *  which the gate treats as denial (issue #32). */
	selectResult?: string | undefined;
	tinyModel?: unknown;
	model?: unknown;
	/** Session branch entries for evidence collection (issue #31). Empty by
	 *  default; the gate reads getBranch() only when evidenceUserMessages > 0. */
	branch?: ReadonlyArray<{ type: string; message?: { role?: string; attribution?: string; content?: unknown } }>;
}

/** The labels the plugin's permission dialog offers. "Always allow" is
 *  bash-only and kill-switchable (persistentGrants config key); "Allow for
 *  session" needs a strict grant key (issue #32). */
export const ALLOW_ONCE = "Allow once";
export const ALLOW_SESSION = "Allow for session";
export const ALWAYS_ALLOW = "Always allow";
export const DENY = "Deny";

export function makeCtx(options: CtxOptions = {}): ExtensionContext {
	const selectCalls: Array<[string, Array<{ label: string; description?: string }>]> = [];
	const notifyCalls: string[][] = [];
	// "model" in options distinguishes an explicit undefined (no model) from an
	// absent option (default test model).
	const currentModel = "model" in options ? options.model : { id: "test-model" };
	const ctx = {
		cwd: options.cwd ?? "/workspace",
		sessionManager: { getSessionId: () => options.sessionId ?? "session-1", getBranch: () => options.branch ?? [] },
		hasUI: options.hasUI ?? false,
		ui: {
			select: async (title: string, items: Array<{ label: string; description?: string }>) => {
				selectCalls.push([title, items]);
				return options.selectResult;
			},
			notify: (message: string, type = "info") => {
				notifyCalls.push([message, type]);
			},
		},
		// Mirrors the host's `ctx.models` facade (extension model-api.ts): the
		// judge reads the session model off `current()`, and role aliases resolve
		// for the audit line. There is no registry behind this fake, so `list` is
		// empty — a judge resolved from it has no fallback candidates, which is
		// what keeps an unscriped runtime from reaching a provider.
		models: {
			list: () => [],
			current: () => currentModel,
			resolve: (selector: string | undefined) => {
				const s = selector?.trim();
				if (!s || s === "@tiny") return options.tinyModel;
				return { id: s };
			},
			family: (model: { provider?: string }) => model.provider ?? "unknown",
		},
		model: currentModel,
		// The registry surface jev-judge.ts resolves a judge through. Its
		// `authStorage` reports the same key flag clearJevApiKey flips, so a ctx
		// and the judge seam can never disagree about whether a credential exists.
		modelRegistry: {
			authStorage: {
				hasAuth: (provider: string): boolean => provider === TYPESAFE_PROVIDER && jevApiKeyPresent,
				resolver: () => async (): Promise<string | undefined> => (jevApiKeyPresent ? JEV_TEST_KEY : undefined),
			},
			getAvailable: () => [],
			getApiKey: async (): Promise<string | undefined> => undefined,
			resolver: () => async (): Promise<string | undefined> => undefined,
		},
	} as unknown as ExtensionContext;
	Object.defineProperty(ctx, "selectCalls", { value: selectCalls });
	Object.defineProperty(ctx, "notifyCalls", { value: notifyCalls });
	return ctx;
}

/**
 * The full dialog text the TUI renders as Markdown. The plugin passes the
 * title and the verbatim body as ONE string on the select dialog's title
 * (the TUI renders a select title as a full Markdown block), joined by a
 * single newline — the same join the old confirm's two arguments got
 * (extension-ui-controller.ts:947). Assert against this, not against the
 * parts, so a body that lazily continues the title paragraph is visible.
 */
export function dialogText(ctx: ExtensionContext, index = 0): string {
	return selectCalls(ctx)[index][0];
}

export function selectCalls(ctx: ExtensionContext): Array<[string, Array<{ label: string; description?: string }>]> {
	return (ctx as unknown as { selectCalls: Array<[string, Array<{ label: string; description?: string }>]> }).selectCalls;
}

export function notifyCalls(ctx: ExtensionContext): string[][] {
	return (ctx as unknown as { notifyCalls: string[][] }).notifyCalls;
}

export function makeSettings(patterns: unknown[], bashPolicy?: string): Record<string, unknown> {
	const store: Record<string, unknown> = {
		"bash.patterns": patterns,
		"tools.approval": bashPolicy ? { bash: bashPolicy } : {},
	};
	// The plugin reads host settings through settings.get(key), like the real
	// Settings singleton.
	return { get: (key: string): unknown => store[key] };
}

let testConfigPath: string | undefined;
let testConfigDir: string | undefined;

// The plugin's config path must NEVER resolve to the real homedir file during
// tests: machine state (a live /classifier edit) would silently flip defaults
// and fail the suite. Force the env override before the plugin first reads it.
process.env.OMP_JEV_CONFIG = useTempConfigFile();

let testLockPath: string | undefined;

// Same reasoning as the config file above, and it bites harder: the real
// lockfile records whether the developer running the suite has the plugin
// disabled, so without this the stale-disable notice fires (or does not) based
// on machine state. Default to a path that does not exist, which reads as
// "not disabled".
// The redirect is honored only under NODE_ENV=test, and bun defaults that ONLY
// when it is not already defined — so `NODE_ENV=development bun test` left the
// redirect inert and the suite read the developer's real lockfile. Pin it here
// beside the redirect rather than relying on bun's default.
process.env.NODE_ENV = "test";
process.env.OMP_JEV_TEST_LOCKFILE = lockfilePathForTests();

function lockfilePathForTests(): string {
	if (!testLockPath) {
		// PID alone collides across reruns, and the file outlives the process, so
		// the next run inheriting it would believe the plugin is disabled — the
		// machine-state dependence this indirection exists to remove.
		const suffix = Math.random().toString(36).slice(2, 10);
		testLockPath = path.join(os.tmpdir(), `omp-classifier-test-lock-${process.pid}-${suffix}.json`);
	}
	return testLockPath;
}

/** Write a host lockfile the plugin will read. */
export function writeLockfile(raw: Record<string, unknown>): void {
	fs.writeFileSync(lockfilePathForTests(), JSON.stringify(raw));
}

// The file outlives the process, so a rerun could inherit a lockfile saying the
// plugin is disabled. The random suffix above makes that collision unlikely; this
// makes it impossible.
process.on("exit", () => {
	try {
		if (testLockPath) fs.unlinkSync(testLockPath);
	} catch {
		// already gone
	}
	// The config dir also holds the decision audit log (#33): one sweep clears
	// every artifact this process wrote.
	if (testConfigDir) fs.rmSync(testConfigDir, { recursive: true, force: true });
});

/** Remove the host lockfile, so the plugin sees no lockfile at all. */
export function removeLockfile(): void {
	try {
		fs.unlinkSync(lockfilePathForTests());
	} catch {
		// absent is fine
	}
}

/** Point the plugin's config file at a fresh temp path (per test file). */
export function useTempConfigFile(): string {
	if (!testConfigPath) {
		// A per-pid DIRECTORY, not a bare file: the decision audit log (#33)
		// resolves to dirname(OMP_JEV_CONFIG)/decisions.jsonl, so one
		// dir keeps config + audit artifacts together and cleanable at exit.
		if (!testConfigDir) {
			testConfigDir = fs.mkdtempSync(path.join(os.tmpdir(), `omp-classifier-test-${process.pid}-`));
		}
		testConfigPath = path.join(testConfigDir, "omp-classifier.json");
	}
	process.env.OMP_JEV_CONFIG = testConfigPath;
	return testConfigPath;
}

let lastConfigMtimeMs = 0;

export function writeConfigFile(raw: Record<string, unknown>): void {
	const target = useTempConfigFile();
	fs.writeFileSync(target, JSON.stringify(raw));
	// The plugin's config cache is keyed on mtimeMs; coarse-granularity
	// filesystems (the codebase flags 1-2s on NFS) can stamp two rapid writes
	// with the same tick, silently skipping a re-read. Force a strictly
	// increasing mtime so every write is always seen.
	const mtimeMs = Math.max(Date.now(), lastConfigMtimeMs + 1);
	fs.utimesSync(target, mtimeMs / 1000, mtimeMs / 1000);
	lastConfigMtimeMs = mtimeMs;
}

export function removeConfigFile(): void {
	// Point at a fresh per-process temp path instead of deleting the env var:
	// with the var unset the plugin falls back to the real homedir file, and
	// machine state must never leak into the suite.
	if (testConfigPath) {
		try {
			fs.unlinkSync(testConfigPath);
		} catch {
			// absent is fine
		}
	}
	testConfigPath = undefined;
	process.env.OMP_JEV_CONFIG = useTempConfigFile();
}

/** Render an interceptor result: undefined means "let the host decide/run". */
export function resultText(result: unknown): string {
	if (result === undefined) return "ALLOWED";
	if (typeof result === "object" && result !== null && "reason" in result) {
		return String((result as { reason: unknown }).reason);
	}
	return String(result);
}

/** Shape every block reason must have since #28. */
export interface RefusalPayload {
	classifier: string;
	tool: string;
	layer: string;
	why: string;
	next: string;
	notThis: string;
}

/** Parse a structured refusal payload (#28) out of a rendered block result. */
export function refusalOf(result: unknown): RefusalPayload {
	const text = resultText(result);
	try {
		return JSON.parse(text) as RefusalPayload;
	} catch {
		throw new Error(`expected a refusal payload, got: ${text}`);
	}
}
