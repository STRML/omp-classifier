/**
 * The pluggable judge backend (issue #84).
 *
 * The gate's transport used to be hardwired: `judgeForClassification` resolved
 * the host's TypeSafe judge and nothing else. `judgeBackend` now selects it —
 * `{kind:"typesafe"}` is the host path unchanged (the default, and the only
 * kind that reads `settings`/`context`), and `{kind:"endpoint", baseUrl, model,
 * apiKeyEnv}` points the gate at any endpoint that speaks the System One wire
 * contract (`POST {state, model, questions}` -> `{answers, model}`), with the
 * credential read from a NAMED environment variable.
 *
 * What has to hold, and is asserted here:
 *   - No `judgeBackend` key: the host path, unchanged — the seam is a no-op,
 *     and the plugin's own transport opens no socket at all.
 *   - Endpoint kind: `TypeSafeJudge` built from the config's baseUrl/model, the
 *     bearer from the named env var, the request at that baseUrl, and a verdict
 *     still derived from returned probabilities (not one-hot).
 *   - Fail closed: a missing env var is `JevUnavailableError` -> permission
 *     request, with no request attempted and nothing cached — never a verdict.
 *   - Backend identity: the id joins the config signature and the cache key, so
 *     a verdict earned under one backend is not served under another. The
 *     dry-run probe is the sharpest way to see it: it reads the cache while the
 *     config signature is deliberately left stale, so only the KEY can tell the
 *     two backends apart (the same shape as the evidence-off/on test in
 *     session-grants.test.ts).
 *   - The redirect is a closed door (review gate P0 on #84, issue #124): the
 *     endpoint transport forces the runtime fetch's redirect policy to
 *     `"manual"`, so a 3xx comes back as the response and the host client fails
 *     on it. Measured against two real local servers: the second one receives
 *     zero requests for a 302 and for the 307 (the status that replays the
 *     body), and the gate reports an outage rather than judging the target.
 *   - The credential value never reaches the audit log, the config banner, or
 *     the status report.
 */
import * as fs from "node:fs";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { TypeSafeJudge } from "@oh-my-pi/pi-ai";
import { buildStatusReport, decisionsLogPath, formatClassifierConfig, readClassifierConfig } from "../index";
import { DEFAULT_JUDGE_BACKEND, judgeBackendFor, noFollowFetch, parseJudgeBackend } from "../jev-judge";
import {
	fire,
	fireCommand,
	JEV_FIXTURE_HAZARDS,
	JEV_FIXTURE_MODEL,
	jevSafeAnswer,
	loadPlugin,
	loggerInfos,
	makeCtx,
	makeEvent,
	makeSettings,
	modelCalls,
	notifyCalls,
	questionsOf,
	refusalOf,
	removeConfigFile,
	resolvedJudgeDeps,
	resultText,
	setJevAnswer,
	stateOf,
	writeConfigFile,
} from "./fixtures";

let seq = 0;
const nextSession = (): string => `backend-${(seq += 1)}-${Math.random().toString(36).slice(2, 8)}`;

/** One gate run in a fresh session: every test's verdict is its own cache entry. */
const gate = async (command: string, opts: Parameters<typeof makeCtx>[0] = {}): Promise<string> =>
	resultText(await fire("tool_call", makeEvent(command), makeCtx({ sessionId: nextSession(), ...opts })));

/** The dry-run preview, exactly as `/classifier dry-run <command>` reports it. */
const dryRunReport = async (command: string, sessionId: string): Promise<Record<string, unknown>> => {
	const ctx = makeCtx({ sessionId });
	await fireCommand("classifier", `dry-run ${command}`, ctx);
	const calls = notifyCalls(ctx);
	expect(calls.length).toBeGreaterThan(0);
	return JSON.parse(calls[calls.length - 1][0]) as Record<string, unknown>;
};

/** The endpoint every endpoint test points at. Nothing listens there: the
 *  suite's firewall answers `globalThis.fetch`, and this file only wraps it to
 *  record the URL the production transport actually built. */
const ENDPOINT = {
	kind: "endpoint",
	baseUrl: "http://127.0.0.1:8765",
	model: "local-decide",
	apiKeyEnv: "LOCAL_JUDGE_KEY",
} as const;

const KEY_VALUE = "local-judge-secret-value";

const firewallFetch = globalThis.fetch;
const requestedUrls: string[] = [];

beforeEach(async () => {
	removeConfigFile();
	requestedUrls.length = 0;
	// Wrapping the suite's firewall rather than replacing it keeps the socket
	// firewall intact: this only records the URL, so a wire assertion is about
	// the transport this plugin built, not about a stub of our own.
	globalThis.fetch = ((url: unknown, init?: unknown) => {
		requestedUrls.push(String(url));
		return (firewallFetch as (u: unknown, i?: unknown) => Promise<Response>)(url, init);
	}) as unknown as typeof fetch;
	await loadPlugin(makeSettings([]));
	setJevAnswer(jevSafeAnswer());
});

afterEach(() => {
	globalThis.fetch = firewallFetch;
	delete process.env.LOCAL_JUDGE_KEY;
	delete process.env.TYPESAFE_DEFAULT_MODEL;
	// Drop this file's config file — an endpoint override must never leak into
	// a sibling file — and put the shared suite config path back, since the
	// audit log resolves to dirname(OMP_JEV_CONFIG).
	removeConfigFile();
});

describe("the default backend", () => {
	test("with no judgeBackend key the host judge path is the one asked", async () => {
		// No config file at all: the shipped default is the host path.
		const result = await gate("git status");
		expect(result).toBe("ALLOWED");
		// The host resolver got the deps, exactly as before the seam existed
		// (once for the live classification, once for the shadow, which is on by
		// default).
		expect(resolvedJudgeDeps.length).toBeGreaterThan(0);
		expect(modelCalls.length).toBe(1);
		// And the plugin's own transport opened no socket: the default kind is
		// the host path, not a second copy of it.
		expect(requestedUrls).toEqual([]);
	});

	test("with the shadow off the default still resolves exactly one host judge", async () => {
		writeConfigFile({ shadowV3: false });
		expect(await gate("git status")).toBe("ALLOWED");
		expect(resolvedJudgeDeps.length).toBe(1);
		expect(modelCalls.length).toBe(1);
		expect(requestedUrls).toEqual([]);
	});

	test("its id is the host model pin, so the cache identity is unchanged", () => {
		process.env.TYPESAFE_DEFAULT_MODEL = "jev-pinned";
		expect(judgeBackendFor(DEFAULT_JUDGE_BACKEND).id).toBe("typesafe/jev-pinned");
		expect(formatClassifierConfig(readClassifierConfig())).toContain("judgeBackend: typesafe/jev-pinned");
	});

	test("a garbage judgeBackend keeps the default, like every other key", async () => {
		writeConfigFile({ judgeBackend: "local" });
		expect(readClassifierConfig().judgeBackend).toEqual({ kind: "typesafe" });

		writeConfigFile({ judgeBackend: { kind: "endpoint", baseUrl: ENDPOINT.baseUrl } });
		expect(readClassifierConfig().judgeBackend).toEqual({ kind: "typesafe" });

		writeConfigFile({ judgeBackend: { kind: "endpoint", baseUrl: "not a url", model: "m", apiKeyEnv: "K" } });
		expect(readClassifierConfig().judgeBackend).toEqual({ kind: "typesafe" });

		// The half-written key must not change the transport either: the command
		// still classifies through the host judge.
		writeConfigFile({ shadowV3: false, judgeBackend: { kind: "endpoint", baseUrl: "not a url", model: "m", apiKeyEnv: "K" } });
		const result = await gate("git status");
		expect(result).toBe("ALLOWED");
		expect(resolvedJudgeDeps.length).toBe(1);
		expect(requestedUrls).toEqual([]);
	});
});

describe("judgeBackend parsing", () => {
	test("rejects every shape that cannot name a judge", () => {
		expect(parseJudgeBackend(undefined)).toBeUndefined();
		expect(parseJudgeBackend("endpoint")).toBeUndefined();
		expect(parseJudgeBackend(["endpoint"])).toBeUndefined();
		expect(parseJudgeBackend({})).toBeUndefined();
		expect(parseJudgeBackend({ kind: "local" })).toBeUndefined();
		expect(parseJudgeBackend({ kind: "typesafe", baseUrl: ENDPOINT.baseUrl })).toEqual({ kind: "typesafe" });

		countRejections([
			{ kind: "endpoint" },
			{ kind: "endpoint", baseUrl: "", model: "m", apiKeyEnv: "K" },
			{ kind: "endpoint", baseUrl: "not a url", model: "m", apiKeyEnv: "K" },
			{ kind: "endpoint", baseUrl: "ftp://127.0.0.1", model: "m", apiKeyEnv: "K" },
			{ kind: "endpoint", baseUrl: ENDPOINT.baseUrl, model: "", apiKeyEnv: "K" },
			{ kind: "endpoint", baseUrl: ENDPOINT.baseUrl, apiKeyEnv: "K" },
			{ kind: "endpoint", baseUrl: ENDPOINT.baseUrl, model: "m", apiKeyEnv: "" },
			{ kind: "endpoint", baseUrl: ENDPOINT.baseUrl, model: "m", apiKeyEnv: "not a name" },
		]);
	});

	test("accepts the documented shape, canonicalizing the base URL", () => {
		expect(parseJudgeBackend(ENDPOINT)).toEqual(ENDPOINT);
		// A trailing slash is the same endpoint, so it must be the same identity:
		// otherwise editing it would flush a cache for no reason.
		const slash = parseJudgeBackend({ ...ENDPOINT, baseUrl: `${ENDPOINT.baseUrl}/` });
		expect(slash).toEqual(ENDPOINT);
		expect(judgeBackendFor(slash!).id).toBe(judgeBackendFor(parseJudgeBackend(ENDPOINT)!).id);
	});
});

describe("the endpoint backend", () => {
	test("is built from the config's baseUrl/model with the key from the named env var", () => {
		process.env.LOCAL_JUDGE_KEY = KEY_VALUE;
		const backend = judgeBackendFor(parseJudgeBackend(ENDPOINT)!);
		const judge = backend.judge({ state: {} });
		expect(judge).toBeInstanceOf(TypeSafeJudge);
		// The host's own wire client: no transport code of ours.
		expect((judge as TypeSafeJudge).baseUrl).toBe(ENDPOINT.baseUrl);
		expect((judge as TypeSafeJudge).model).toBe(ENDPOINT.model);
		expect(backend.id).toBe(`endpoint/${ENDPOINT.baseUrl}#${ENDPOINT.model}`);
	});

	test("classifies one command through the endpoint, never the host path", async () => {
		process.env.LOCAL_JUDGE_KEY = KEY_VALUE;
		writeConfigFile({ shadowV3: false, judgeBackend: ENDPOINT });

		const result = await gate("git status");
		// The endpoint's probability answer decided: safe answers default, so
		// reaching ALLOWED means the whole answer path ran on the response.
		expect(result).toBe("ALLOWED");
		expect(resolvedJudgeDeps.length).toBe(0);
		expect(requestedUrls).toEqual([`${ENDPOINT.baseUrl}/v1/systemone`]);
		expect(modelCalls.length).toBe(1);
		expect(modelCalls[0].model).toBe(ENDPOINT.model);
		expect(modelCalls[0].headers?.authorization).toBe(`Bearer ${KEY_VALUE}`);
		// Same state, same battery, same contract — only the transport moved.
		expect(JSON.stringify(stateOf(0))).toContain("git status");
		expect(Object.keys(questionsOf(0))).toEqual(
			expect.arrayContaining(["verdict", "blast_radius", ...JEV_FIXTURE_HAZARDS]),
		);
	});

	test("the shadow asks the configured backend too", async () => {
		process.env.LOCAL_JUDGE_KEY = KEY_VALUE;
		// shadowV3 defaults on: the shadow must measure the judge that decided.
		writeConfigFile({ judgeBackend: ENDPOINT });
		await gate("git status");
		// The live risk battery, then the shadow's risk and authorization
		// questions — all three at the configured endpoint.
		expect(requestedUrls.length).toBe(3);
		expect(requestedUrls.every(url => url === `${ENDPOINT.baseUrl}/v1/systemone`)).toBe(true);
		expect(modelCalls.every(call => call.model === ENDPOINT.model)).toBe(true);
		expect(resolvedJudgeDeps.length).toBe(0);
	});

	test("a missing env var fails closed: no request, no verdict, nothing cached", async () => {
		delete process.env.LOCAL_JUDGE_KEY;
		writeConfigFile({ shadowV3: false, judgeBackend: ENDPOINT });
		const sid = nextSession();
		const blocked = await fire("tool_call", makeEvent("git status"), makeCtx({ sessionId: sid }));
		const payload = refusalOf(blocked);
		expect(payload.layer).toBe("headless");
		// The message names the variable to set — the same fail-closed shape as a
		// missing TypeSafe credential — and never carries a value.
		expect(payload.why).toContain("classifier unavailable");
		expect(payload.why).toContain(ENDPOINT.apiKeyEnv);
		// Nothing was attempted: an unconfigured gate must not open a socket.
		expect(requestedUrls).toEqual([]);
		expect(modelCalls.length).toBe(0);
		// And nothing was cached, so the next call judges for real.
		expect(buildStatusReport().cacheSizes[sid]).toBe(0);

		process.env.LOCAL_JUDGE_KEY = KEY_VALUE;
		expect(await gate("git status")).toBe("ALLOWED");
		expect(requestedUrls).toEqual([`${ENDPOINT.baseUrl}/v1/systemone`]);
	});

	test("with a UI the missing key raises a dialog instead of a silent run", async () => {
		delete process.env.LOCAL_JUDGE_KEY;
		writeConfigFile({ shadowV3: false, judgeBackend: ENDPOINT });
		const ctx = makeCtx({ sessionId: nextSession(), hasUI: true });
		const blocked = await fire("tool_call", makeEvent("git status"), ctx);
		expect(refusalOf(blocked).layer).toBe("dialog");
		expect(requestedUrls).toEqual([]);
	});

	test("the credential value never reaches the audit log, banner, or status", async () => {
		process.env.LOCAL_JUDGE_KEY = KEY_VALUE;
		writeConfigFile({ shadowV3: false, judgeBackend: ENDPOINT });
		expect(await gate("git status")).toBe("ALLOWED");

		expect(fs.readFileSync(decisionsLogPath(), "utf8")).not.toContain(KEY_VALUE);
		expect(loggerInfos.join("\n")).not.toContain(KEY_VALUE);
		expect(JSON.stringify(buildStatusReport())).not.toContain(KEY_VALUE);
		// The config banner shows the backend identity and never a secret; the
		// env var NAME is the only credential fact that is config.
		const banner = formatClassifierConfig(readClassifierConfig());
		expect(banner).toContain(`judgeBackend: endpoint/${ENDPOINT.baseUrl}#${ENDPOINT.model}`);
		expect(banner).not.toContain(KEY_VALUE);
	});
});

describe("backend identity in the trust state", () => {
	test("a verdict cached under one backend is not served under another", async () => {
		// The dry-run probe is the one cache read the config signature does not
		// precede: it deliberately leaves the signature stale, so only the cache
		// KEY can tell the two backends apart. Without the backend id in the key,
		// the probe would report the host judge's cached SAFE as if the endpoint
		// had produced it.
		writeConfigFile({ shadowV3: false });
		const sid = nextSession();
		const command = "git status";
		await fire("tool_call", makeEvent(command), makeCtx({ sessionId: sid }));
		expect(resolvedJudgeDeps.length).toBe(1);
		expect(buildStatusReport().cacheSizes[sid]).toBe(1);

		process.env.LOCAL_JUDGE_KEY = KEY_VALUE;
		writeConfigFile({ shadowV3: false, judgeBackend: ENDPOINT });
		const report = await dryRunReport(command, sid);
		expect(report).toMatchObject({ would: "classify", layer: "classifier" });
	});

	test("a live switch reclassifies through the new backend", async () => {
		writeConfigFile({ shadowV3: false });
		const sid = nextSession();
		const command = "git status";
		expect(await fire("tool_call", makeEvent(command), makeCtx({ sessionId: sid }))).toBeUndefined();
		expect(modelCalls.length).toBe(1);

		process.env.LOCAL_JUDGE_KEY = KEY_VALUE;
		writeConfigFile({ shadowV3: false, judgeBackend: ENDPOINT });
		expect(await fire("tool_call", makeEvent(command), makeCtx({ sessionId: sid }))).toBeUndefined();
		expect(resolvedJudgeDeps.length).toBe(1);
		expect(requestedUrls).toEqual([`${ENDPOINT.baseUrl}/v1/systemone`]);
	});

	test("the endpoint id separates endpoints that differ only by base URL", () => {
		const a = judgeBackendFor(parseJudgeBackend({ ...ENDPOINT, baseUrl: "http://127.0.0.1:8765" })!);
		const b = judgeBackendFor(parseJudgeBackend({ ...ENDPOINT, baseUrl: "http://127.0.0.1:9999" })!);
		const c = judgeBackendFor(parseJudgeBackend({ ...ENDPOINT, model: "other-model" })!);
		expect(a.id).not.toBe(b.id);
		expect(a.id).not.toBe(c.id);
		expect(a.id).not.toBe(judgeBackendFor(DEFAULT_JUDGE_BACKEND).id);
	});

	test("/classifier status reports the active backend", async () => {
		expect(buildStatusReport().backendId).toBe(judgeBackendFor(DEFAULT_JUDGE_BACKEND).id);
		writeConfigFile({ shadowV3: false, judgeBackend: ENDPOINT });
		expect(buildStatusReport().backendId).toBe(`endpoint/${ENDPOINT.baseUrl}#${ENDPOINT.model}`);
		expect(buildStatusReport().config.judgeBackend).toEqual(ENDPOINT);
	});
});

/** Assert every value in `shapes` is rejected by the parser, and report which
 *  one was not: a bare `toBeUndefined()` loop hides the offending shape. */
function countRejections(shapes: unknown[]): void {
	const accepted = shapes.filter(shape => parseJudgeBackend(shape) !== undefined);
	expect(accepted).toEqual([]);
}

/**
 * The transport's trust boundary (review gate on #84, P0). The request carries
 * the judged state and the bearer key, so what the endpoint is allowed to be is
 * a security decision, not a convenience one.
 */
describe("the endpoint transport refuses cleartext and redirects", () => {
	test("a plaintext endpoint on another host keeps the default backend", () => {
		countRejections([
			{ kind: "endpoint", baseUrl: "http://judge.example", model: "m", apiKeyEnv: "K" },
			{ kind: "endpoint", baseUrl: "http://10.0.0.5:9000", model: "m", apiKeyEnv: "K" },
			{ kind: "endpoint", baseUrl: "http://judge.example:8765/v1", model: "m", apiKeyEnv: "K" },
		]);
	});

	test("a loopback http endpoint is accepted: that is a judge on this machine", () => {
		for (const baseUrl of ["http://127.0.0.1:8765", "http://localhost:8765", "http://[::1]:8765"]) {
			expect(parseJudgeBackend({ kind: "endpoint", baseUrl, model: "m", apiKeyEnv: "K" })).toEqual({
				kind: "endpoint",
				baseUrl,
				model: "m",
				apiKeyEnv: "K",
			});
		}
	});

	test("a credential inside the URL is refused", () => {
		// The id is built from this URL and the id is printed by `/classifier`
		// and written into the status report, so a secret in it would be shown.
		countRejections([
			{ kind: "endpoint", baseUrl: "https://user:secret@judge.example", model: "m", apiKeyEnv: "K" },
			{ kind: "endpoint", baseUrl: "https://:secret@judge.example", model: "m", apiKeyEnv: "K" },
		]);
	});
});

/** What one wire reply carries: a status, and optionally a body and headers. */
interface WireReply {
	status: number;
	body?: string;
	headers?: Record<string, string>;
}

/** One request a wire server received, in the contract's own shape. */
interface WireRequest {
	url: string;
	method: string;
	headers: Record<string, string>;
	state: unknown;
	model: unknown;
	questions: Record<string, unknown>;
}

interface WireServer {
	readonly baseUrl: string;
	readonly calls: WireRequest[];
	stop(): Promise<void>;
}

/** The envelope the redirect target answers with: the fixture's safe answers, so
 *  a transport that DID follow would hand the gate a verdict instead of an
 *  outage and the failure would be loud (528/126 are the fixture's usage). */
function safeEnvelope(): string {
	return JSON.stringify({
		model: JEV_FIXTURE_MODEL,
		answers: jevSafeAnswer(),
		usage: { input_tokens: 528, output_tokens: 126 },
	});
}

/**
 * A real System One endpoint on 127.0.0.1. The redirect tests need the wire
 * itself: a stub cannot show whether a request ARRIVED at a second server, and
 * that arrival is the property under test.
 */
function startWireServer(respond: () => WireReply = () => ({ status: 200, body: safeEnvelope() })): WireServer {
	const calls: WireRequest[] = [];
	const server = Bun.serve({
		hostname: "127.0.0.1",
		port: 0,
		async fetch(request): Promise<Response> {
			const raw = await request.text();
			const body = raw === "" ? {} : (JSON.parse(raw) as Record<string, unknown>);
			const url = new URL(request.url);
			calls.push({
				url: `${url.origin}${url.pathname}`,
				method: request.method,
				headers: Object.fromEntries(request.headers.entries()),
				state: body.state,
				model: body.model,
				questions: (body.questions ?? {}) as Record<string, unknown>,
			});
			const reply = respond();
			return new Response(reply.body ?? "", {
				status: reply.status,
				headers: { "content-type": "application/json", ...reply.headers },
			});
		},
	});
	return {
		baseUrl: `http://127.0.0.1:${server.port}`,
		calls,
		stop: async () => {
			await server.stop();
		},
	};
}

/**
 * A redirect answered by the endpoint itself (review gate P0 on #84, issue
 * #124). The suite's firewall answers every `fetch` without opening a socket, so
 * these tests install the RUNTIME's fetch for the length of one call and run two
 * real servers: the endpoint that answers 3xx, and the server it points at. The
 * second must receive nothing, and the call must fail closed instead of judging
 * whatever the target answers — the two are asserted together, because zero hits
 * alone would also pass if the endpoint had never been asked, and an outage
 * alone would also pass if the transport had followed and the target had
 * answered nothing.
 *
 * The transport-level tests call `noFollowFetch` with `redirect: "follow"` in
 * the init on purpose: the policy belongs to the boundary, so a caller cannot
 * opt back into following.
 */
describe("the endpoint transport cannot follow a redirect", () => {
	const runtimeFetch = Bun.fetch;
	const started: WireServer[] = [];
	const start = (respond?: () => WireReply): WireServer => {
		const server = startWireServer(respond);
		started.push(server);
		return server;
	};

	afterEach(async () => {
		globalThis.fetch = firewallFetch;
		while (started.length > 0) await started.pop()?.stop();
	});

	for (const status of [302, 307]) {
		test(`a ${status} comes back as the ${status} and never reaches the target`, async () => {
			// 307 is the one that would replay the POST body — the judged state.
			// 302 rewrites the method and drops it; neither may reach the target.
			const target = start();
			const endpoint = start(() => ({ status, headers: { location: `${target.baseUrl}/v1/systemone` } }));
			globalThis.fetch = runtimeFetch;
			const response = await noFollowFetch(`${endpoint.baseUrl}/v1/systemone`, {
				method: "POST",
				headers: { authorization: `Bearer ${KEY_VALUE}`, "content-type": "application/json" },
				body: JSON.stringify({ state: { command: "git status" }, model: ENDPOINT.model, questions: {} }),
				redirect: "follow",
			});
			expect(response.status).toBe(status);
			expect(response.redirected).toBe(false);
			expect(endpoint.calls.length).toBe(1);
			expect(endpoint.calls[0].method).toBe("POST");
			expect(endpoint.calls[0].headers.authorization).toBe(`Bearer ${KEY_VALUE}`);
			expect(target.calls).toEqual([]);
		});

		test(`a ${status} fails the gate closed instead of judging the target`, async () => {
			const target = start();
			const endpoint = start(() => ({ status, headers: { location: `${target.baseUrl}/v1/systemone` } }));
			process.env.LOCAL_JUDGE_KEY = KEY_VALUE;
			writeConfigFile({ shadowV3: false, judgeBackend: { ...ENDPOINT, baseUrl: endpoint.baseUrl } });
			const blocked = await (async () => {
				globalThis.fetch = runtimeFetch;
				try {
					return await fire("tool_call", makeEvent("git status"), makeCtx({ sessionId: nextSession() }));
				} finally {
					globalThis.fetch = firewallFetch;
				}
			})();
			// The target answers the fixture's safe set, so a transport that
			// followed would arrive here as ALLOWED; `refusalOf` throws on that.
			const payload = refusalOf(blocked);
			expect(payload.layer).toBe("headless");
			expect(payload.why).toContain("classifier unavailable");
			// And the status the endpoint answered is what failed the call.
			expect(payload.why).toContain(`TypeSafe API error (${status})`);
			expect(endpoint.calls.length).toBe(1);
			expect(target.calls).toEqual([]);
		});
	}

	test("a reply the runtime reports as redirected is refused rather than judged", async () => {
		// The backstop for a runtime that ignored the policy: `redirected` is the
		// platform's own report that it followed, so that body came from somewhere
		// else. Stubbed because this runtime honors `manual` and the branch cannot
		// otherwise be reached here.
		const following = globalThis.fetch;
		let sawRedirect: unknown;
		globalThis.fetch = (async (_input: unknown, init?: RequestInit) => {
			sawRedirect = init?.redirect;
			return { redirected: true, status: 200 } as unknown as Response;
		}) as unknown as typeof fetch;
		try {
			await expect(noFollowFetch(`${ENDPOINT.baseUrl}/v1/systemone`)).rejects.toThrow(/followed a redirect/u);
			expect(sawRedirect).toBe("manual");
		} finally {
			globalThis.fetch = following;
		}
	});
});
