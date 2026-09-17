/**
 * Test fixtures for the tool_call interceptor plugin surface.
 *
 * The plugin takes its settings from the pi argument (`pi.pi.settings`) and
 * every judgement from TypeSafe's Jev (System One) over HTTP. Both are
 * injectable here without touching the real modules, so the ONLY stub is the
 * network boundary: `globalThis.fetch` is replaced by a scripted fake that
 * answers with wire-shaped Jev responses. The production path runs for real —
 * jev.ts's askJev (request body, response validation, error mapping) and
 * deriveJevDecision (the policy arithmetic) are never stubbed, because a suite
 * that stubs the thing under test asserts against itself.
 *
 * One entry in `modelCalls` is one judgement request: the boundary is an HTTP
 * request now, not a provider completion. Entries are captured on ARRIVAL, so
 * a request that later times out is still visible (`jevAttemptCount()`).
 */
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { mock } from "bun:test";
import type { ExtensionAPI, ExtensionContext } from "@oh-my-pi/pi-coding-agent";

export type Verdict = "SAFE" | "UNSAFE" | "UNSURE" | "UNAVAILABLE";

// ---------------------------------------------------------------------------
// Jev answer fixtures.
//
// Wire shapes copied from measured live responses (the frozen contract): a
// choice answer carries `choice` + `probabilities` + `confidence`, a noul
// answer a single 0..1 `noul`, a score answer `score` + `legend` +
// `probabilities` + `confidence`. The fixtures build `answers` maps; the fake
// fetch wraps them in the response envelope ({model, answers, usage}).
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
 * jevQuestions() is loud rather than silent — askJev rejects a response whose
 * answers do not cover the questions it sent, every judgement becomes
 * UNAVAILABLE, and policy-gates.test.ts pins the ids the gate actually asked.
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
// The fake network boundary.
// ---------------------------------------------------------------------------

export interface CapturedJevRequest {
	/** The state (report) the gate sent. Never a prompt: Jev reads structure. */
	state: unknown;
	/** The question battery, by id. */
	questions: Record<string, unknown>;
	/** The model id from the request body. */
	model: unknown;
	/** Request headers, lower-cased (the bearer token rides here). */
	headers: Record<string, string>;
}

export const modelCalls: CapturedJevRequest[] = [];

let jevDefaultAnswers: JevFixtureAnswers = jevSafeAnswer();
let jevQueue: JevFixtureAnswers[] | undefined;
let jevFailuresLeft = 0;
let jevUnavailable = false;
let jevDelayMs = 5;
const jevRawQueue: Array<{ status: number; body: string }> = [];

/** Requests SENT, including ones aborted before a response (a timeout is
 *  evidence the gate tried — the only way to see it, since nothing lands). */
export function jevAttemptCount(): number {
	return modelCalls.length;
}

/** Serve this answer for every request from now on; drops a queued script. */
export function setJevAnswer(answers: JevFixtureAnswers = jevSafeAnswer()): void {
	jevDefaultAnswers = answers;
	jevQueue = undefined;
}

/** Script per-request answers, consumed in order; once drained,
 *  `jevDefaultAnswers` (set by setJevAnswer, safe by default) takes over. */
export function setJevAnswers(answers: JevFixtureAnswers[]): void {
	jevQueue = [...answers];
}

/** Make the next `count` requests fail with HTTP 503 (provider outage). */
export function setJevFailures(count: number): void {
	jevFailuresLeft = count;
}

/** Model an unreachable endpoint: the request rejects like a failed
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

/** Delay every response; combined with a small `timeoutMs`, this is the abort
 *  path (the gate's AbortSignal fires before the fake answers). */
export function setJevDelay(ms: number): void {
	jevDelayMs = ms;
}

const JEV_TEST_KEY = "jev-test-key";
const REAL_PATH = process.env.PATH;

/**
 * The API key must never be resolved from the developer's keychain during a
 * test run: `resolveJevApiKey` falls back to
 * `security find-generic-password -s jev -w`, so the happy path would depend on
 * this machine having the entry and CI not having it — pass/fail by host. Pin
 * a test key instead. Cleared by clearJevApiKey for the missing-key path.
 */
export function restoreJevApiKey(): void {
	process.env.TYPESAFE_API_KEY = JEV_TEST_KEY;
	if (REAL_PATH !== undefined) process.env.PATH = REAL_PATH;
}

/**
 * The no-key path must be deterministic too, and here the machine actively
 * betrays it: this developer's keychain HAS the `jev` entry, so leaving the
 * fallback reachable would make "missing key" pass or fail by machine state.
 * An unreachable PATH makes the keychain read fail the way it does on a host
 * with no entry — the same shape a fresh CI runner sees.
 */
export function clearJevApiKey(): void {
	delete process.env.TYPESAFE_API_KEY;
	process.env.PATH = "/nonexistent-omp-jevens-test-bin";
}

async function sleepWithAbort(ms: number, signal: AbortSignal | undefined): Promise<void> {
	if (!signal) {
		await new Promise<void>(resolve => setTimeout(resolve, ms));
		return;
	}
	// A DOMException-shaped rejection, like fetch's own abort: askJev maps any
	// rejection to JevUnavailableError, and the name keeps the stack readable
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

async function fakeJevFetch(
	_url: unknown,
	init?: { method?: string; body?: string; headers?: unknown; signal?: AbortSignal },
): Promise<Response> {
	const body = typeof init?.body === "string" ? (JSON.parse(init.body) as Record<string, unknown>) : undefined;
	// Captured BEFORE the delay: a request that times out was still sent, and
	// that is the only evidence a timeout triggered no silent allow.
	modelCalls.push({
		state: body?.state,
		questions: (body?.questions ?? {}) as Record<string, unknown>,
		model: body?.model,
		headers: headerRecord(init?.headers),
	});
	await sleepWithAbort(jevDelayMs, init?.signal);
	if (jevUnavailable) throw new TypeError("fetch failed");
	if (jevFailuresLeft > 0) {
		jevFailuresLeft -= 1;
		return new Response('{"error":"service unavailable"}', { status: 503, headers: { "content-type": "application/json" } });
	}
	const raw = jevRawQueue.shift();
	if (raw) return new Response(raw.body, { status: raw.status });
	const answers = jevQueue?.shift() ?? jevDefaultAnswers;
	return new Response(JSON.stringify({ model: JEV_FIXTURE_MODEL, answers, usage: { input_tokens: 528, output_tokens: 126 } }), {
		status: 200,
		headers: { "content-type": "application/json" },
	});
}

// Installed at module load, before any test imports index.ts (loadPlugin's
// dynamic import), so the plugin binds the fake and never opens a socket. A
// test that forgets to script an answer still gets a well-formed safe answer,
// never a hung request against the real endpoint.
globalThis.fetch = fakeJevFetch as unknown as typeof fetch;

/** The state sent with one captured request. */
export function stateOf(index = 0): Record<string, unknown> {
	const call = modelCalls[index];
	if (!call) throw new Error(`no captured Jev request at index ${index}`);
	return (call.state ?? {}) as Record<string, unknown>;
}

/** The question battery sent with one captured request. */
export function questionsOf(index = 0): Record<string, unknown> {
	const call = modelCalls[index];
	if (!call) throw new Error(`no captured Jev request at index ${index}`);
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

// The published 17.3.8 pi-ai/coding-agent pair is not mutually coherent: 30
// names coding-agent imports are absent from the pi-ai barrel. The live OMP
// binary bundles a coherent pair; the npm pair explodes on these names. The
// mock fakes the whole surface; the test boundary is the HTTP request in
// fakeJevFetch above, everything else is inert.
const missingExportStub = () => undefined;
const typeMarkerStub = "type-only-inert";
mock.module("@oh-my-pi/pi-ai", () => ({
	ANTHROPIC_OAUTH_GRANT_TTL_MS: 1000 * 60 * 60 * 24 * 30,
	AnthropicAuthConfig: typeMarkerStub,
	AnthropicSystemBlock: typeMarkerStub,
	Api: typeMarkerStub,
	ApiKey: typeMarkerStub,
	ApiKeyResolver: typeMarkerStub,
	AssistantMessage: typeMarkerStub,
	AssistantMessageEvent: typeMarkerStub,
	AssistantMessageEventStream: typeMarkerStub,
	AssistantRetryRecovery: typeMarkerStub,
	AssistantRetryRecoveryKind: typeMarkerStub,
	AuthCredential: typeMarkerStub,
	AuthCredentialSnapshotEntry: typeMarkerStub,
	AuthCredentialStore: typeMarkerStub,
	AuthStorage: typeMarkerStub,
	CodexCompactionContext: typeMarkerStub,
	CompletionProbe: typeMarkerStub,
	CompletionProbeInput: typeMarkerStub,
	ComputerSafetyCheck: typeMarkerStub,
	Context: typeMarkerStub,
	CredentialCompletionResult: typeMarkerStub,
	CredentialDisabledEvent: typeMarkerStub,
	CursorExecHandlers: typeMarkerStub,
	CursorMcpCall: typeMarkerStub,
	CursorMcpResource: typeMarkerStub,
	CursorMcpResourceContent: typeMarkerStub,
	CursorShellStreamCallbacks: typeMarkerStub,
	CursorTodoSnapshot: typeMarkerStub,
	DeveloperMessage: typeMarkerStub,
	DisabledCredentialSummary: typeMarkerStub,
	Effort: typeMarkerStub,
	EventStream: class {},
	FetchImpl: typeMarkerStub,
	ImageContent: typeMarkerStub,
	KnownProvider: typeMarkerStub,
	Message: typeMarkerStub,
	MessageAttribution: typeMarkerStub,
	Model: typeMarkerStub,
	ModelSpec: typeMarkerStub,
	ModelUsageHealth: typeMarkerStub,
	OAuthAccess: typeMarkerStub,
	OAuthAccessResolution: typeMarkerStub,
	OAuthAccountIdentity: typeMarkerStub,
	OAuthAccountSummary: typeMarkerStub,
	OAuthCredential: typeMarkerStub,
	OAuthProvider: typeMarkerStub,
	OAuthProviderInfo: typeMarkerStub,
	OpenAIResponsesHistoryPayload: typeMarkerStub,
	PASTE_CODE_LOGIN_PROVIDERS: [],
	PROVIDER_REGISTRY: typeMarkerStub,
	REMOTE_REFRESH_SENTINEL: "inert-sentinel",
	ProviderDetails: typeMarkerStub,
	ProviderPayload: typeMarkerStub,
	ProviderResponseMetadata: typeMarkerStub,
	ProviderSessionState: typeMarkerStub,
	RawSseEvent: typeMarkerStub,
	ResetCreditAccountStatus: typeMarkerStub,
	ResetCreditRedeemOutcome: typeMarkerStub,
	ResetCreditTarget: typeMarkerStub,
	ServiceTier: typeMarkerStub,
	ServiceTierByFamily: typeMarkerStub,
	SqliteAuthCredentialStore: class {},
	ServiceTierFamily: typeMarkerStub,
	SimpleStreamOptions: typeMarkerStub,
	Static: typeMarkerStub,
	StoredAuthCredential: typeMarkerStub,
	THINKING_EFFORTS: [],
	TSchema: typeMarkerStub,
	TextContent: typeMarkerStub,
	ThinkingContent: typeMarkerStub,
	Tool: typeMarkerStub,
	ToolCall: typeMarkerStub,
	ToolChoice: typeMarkerStub,
	ToolExample: typeMarkerStub,
	ToolResultMessage: typeMarkerStub,
	Usage: typeMarkerStub,
	UsageHistoryEntry: typeMarkerStub,
	UsageLimit: typeMarkerStub,
	UsageReport: typeMarkerStub,
	UsageResetCreditDetail: typeMarkerStub,
	UsageUnit: typeMarkerStub,
	UserMessage: typeMarkerStub,
	buildAnthropicAuthConfig: missingExportStub,
	buildAnthropicSearchHeaders: missingExportStub,
	buildAnthropicSystemBlocks: missingExportStub,
	buildAnthropicUrl: missingExportStub,
	calculateRateLimitBackoffMs: missingExportStub,
	clearAnthropicFastModeFallback: missingExportStub,
	coerceServiceTierByFamily: missingExportStub,
	// The host modules this suite loads (tools/bash, tools/shell-tokenize,
	// tools/path-utils) import `completeSimple` from the pi-ai barrel, so the
	// mock must carry the name or module resolution fails before any test runs.
	// Nothing here calls it: the judgement boundary is the HTTP request in the
	// fake Jev fetch, and the classification path no longer completes a chat.
	completeSimple: missingExportStub,
	deriveClaudeDeviceId: missingExportStub,
	getEnvApiKey: missingExportStub,
	getOAuthProviders: missingExportStub,
	getOpenRouterHeaders: missingExportStub,
	getProviderDetails: missingExportStub,
	isAnthropicFastModeFallbackDisabled: missingExportStub,
	isApiKeyResolver: missingExportStub,
	isAuthRetryableError: missingExportStub,
	isDefinitiveOAuthFailure: missingExportStub,
	isSqliteBusyError: missingExportStub,
	isUsageLimitOutcome: missingExportStub,
	jsonSchemaToTypeScript: missingExportStub,
	listProvidersWithEnvKey: missingExportStub,
	parseRateLimitReason: missingExportStub,
	realizesPriorityServiceTier: missingExportStub,
	resolveAnthropicMetadataUserId: missingExportStub,
	resolveApiKeyOnce: missingExportStub,
	resolveModelServiceTier: missingExportStub,
	resolveUsedFraction: missingExportStub,
	retryTransientCompletion: missingExportStub,
	seedApiKeyResolver: missingExportStub,
	shouldSendServiceTier: missingExportStub,
	serviceTierFamily: typeMarkerStub,
	streamSimple: missingExportStub,
	stripSchemaDescriptions: missingExportStub,
	stripClaudeToolPrefix: missingExportStub,
	toolWireSchema: typeMarkerStub,
	validateToolArguments: missingExportStub,
	validateToolCall: missingExportStub,
	withAuth: missingExportStub,
	withOAuthAccess: missingExportStub,
	wrapFetchForCch: missingExportStub,
}));

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
		// Mirrors the host resolver contract. The Jev gate judges with one
		// model id and has no role resolution of its own, so these exist only
		// so a host-shaped ctx stays honest about the surface it exposes.
		models: {
			resolve: (selector: string | undefined) => {
				const s = selector?.trim();
				if (!s || s === "@tiny") return options.tinyModel;
				return { id: s };
			},
		},
		// "model" in options distinguishes an explicit undefined (no model)
		// from an absent option (default test model).
		model: "model" in options ? options.model : { id: "test-model" },
		modelRegistry: { resolver: () => undefined },
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
		testLockPath = path.join(os.tmpdir(), `omp-jevens-test-lock-${process.pid}-${suffix}.json`);
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
			testConfigDir = fs.mkdtempSync(path.join(os.tmpdir(), `omp-jevens-test-${process.pid}-`));
		}
		testConfigPath = path.join(testConfigDir, "omp-jevens-classifier.json");
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
