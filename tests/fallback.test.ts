/**
 * The Jev availability path. Every way a judgement can fail to arrive —
 * missing API key, non-2xx, unreachable network, timeout/abort, malformed
 * body — produces UNAVAILABLE, and UNAVAILABLE is never a silent allow: the
 * command still needs a human (dialog when a UI exists, block without one) and
 * nothing is cached, so a recovered endpoint judges the next identical command
 * for real instead of inheriting a stale outage.
 *
 * There is no fallback chain any more. Jev is one endpoint behind one model
 * id, so "primary, then config.fallbackModels" has no successor: an outage is
 * an outage, and the gate says so rather than reaching for a weaker judge.
 * config.fallbackModels is gone; its replacement key (jevPolicy) tunes the
 * boundaries, not the transport.
 */
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { DecisionRecord } from "../index";
import {
	ALLOW_ONCE,
	clearJevApiKey,
	fire,
	loadPlugin,
	makeCtx,
	makeEvent,
	makeSettings,
	modelCalls,
	refusalOf,
	removeConfigFile,
	restoreJevApiKey,
	resultText,
	selectCalls,
	setJevAnswer,
	setJevDelay,
	setJevFailures,
	setJevRawResponses,
	setJevUnavailable,
	useTempConfigFile,
	jevSafeAnswer,
	jevUnsafeAnswer,
	writeConfigFile,
} from "./fixtures";

let dir = "";
let seq = 0;

const decisionsPath = (): string => path.join(dir, "decisions.jsonl");

const readDecisions = (): DecisionRecord[] =>
	fs
		.readFileSync(decisionsPath(), "utf8")
		.split("\n")
		.filter(line => line.trim() !== "")
		.map(line => JSON.parse(line) as DecisionRecord);

beforeEach(async () => {
	// removeConfigFile() repoints OMP_JEV_CONFIG at the fixture's own temp file,
	// so it must run BEFORE pointing at this test's dir, or dirname(env) — the
	// decisions.jsonl location — lands in the fixture dir and the audit tests
	// read an empty log.
	removeConfigFile();
	dir = fs.mkdtempSync(path.join(os.tmpdir(), "omp-classifier-outage-"));
	process.env.OMP_JEV_CONFIG = path.join(dir, "omp-classifier.json");
	await loadPlugin(makeSettings([]));
	// The default fixture answer is safe; every test that wants a verdict
	// scripts its own, so a passing test never depends on a leftover.
	setJevAnswer(jevSafeAnswer());
});

afterEach(() => {
	// Restore the key and PATH immediately: clearJevApiKey scrubs PATH so the
	// keychain fallback cannot find the developer's real key, and a file that
	// ends on that state must not leave the next test file spawning into it.
	restoreJevApiKey();
	// Restore the shared suite config path and drop this test's artifacts.
	process.env.OMP_JEV_CONFIG = useTempConfigFile();
	fs.rmSync(dir, { recursive: true, force: true });
});
// Producer-side cleanup (issue #107): this file writes the config file, so it
// removes it after itself instead of relying on the next consumer's reset.
afterEach(removeConfigFile);

/** One gate run in a fresh session; unique commands where re-judging matters. */
const gate = async (command: string, opts: Parameters<typeof makeCtx>[0] = {}): Promise<string> => {
	seq += 1;
	return resultText(await fire("tool_call", makeEvent(command), makeCtx({ sessionId: `outage-${seq}`, ...opts })));
};

describe("every unavailability reaches UNAVAILABLE", () => {
	test("missing API key: no request is sent, and the command is not allowed", async () => {
		clearJevApiKey();
		const blocked = await gate("make build");
		expect(blocked).toContain("classifier unavailable");
		expect(refusalOf(blocked).layer).toBe("headless");
		// The key is resolved before the request is built, so an unconfigured
		// gate must not even open a socket — a request here would mean the gate
		// tried to authenticate with something it did not have.
		expect(modelCalls).toHaveLength(0);
	});

	test("missing API key writes no cache entry: supplying it judges the same command", async () => {
		const command = "make build";
		clearJevApiKey();
		expect(await gate(command)).toContain("classifier unavailable");
		restoreJevApiKey();
		setJevAnswer(jevSafeAnswer());
		// Same command, same session-less identity, and the gate classifies:
		// had the outage been cached, this would have answered from it.
		expect(await gate(command)).toBe("ALLOWED");
		expect(modelCalls).toHaveLength(1);
	});

	test("non-2xx: 503 is an outage, not a verdict", async () => {
		setJevFailures(1);
		expect(await gate("make build")).toContain("classifier unavailable");
		// The endpoint recovers: the next judgement is a real request, because
		// the failed one was never cached.
		setJevAnswer(jevSafeAnswer());
		expect(await gate("make build")).toBe("ALLOWED");
		expect(modelCalls).toHaveLength(2);
	});

	test("unreachable endpoint: the rejection is an outage", async () => {
		setJevUnavailable();
		expect(await gate("make build")).toContain("classifier unavailable");
		expect(modelCalls).toHaveLength(1);
		setJevUnavailable(false);
		expect(await gate("make build")).toBe("ALLOWED");
		expect(modelCalls).toHaveLength(2);
	});

	test("timeout: the request was sent, and aborting it is an outage", async () => {
		// The fake never answers inside the 20ms budget; the gate's own
		// AbortSignal fires. Capturing on arrival is what makes the attempt
		// visible at all — nothing completes, so nothing would record it.
		writeConfigFile({ timeoutMs: 20 });
		setJevDelay(10_000);
		const blocked = await gate("git status");
		expect(blocked).toContain("classifier unavailable");
		expect(refusalOf(blocked).layer).toBe("headless");
		expect(modelCalls).toHaveLength(1);
	});

	test("malformed bodies: unparseable, and JSON without answers", async () => {
		setJevRawResponses([{ body: "this is not json" }, { body: '{"model":"jev-1.13.0"}' }]);
		expect(await gate("make build")).toContain("classifier unavailable");
		expect(await gate("make clean")).toContain("classifier unavailable");
		expect(modelCalls).toHaveLength(2);
		// Still not cached: a well-formed answer decides the third attempt.
		setJevAnswer(jevSafeAnswer());
		expect(await gate("make build")).toBe("ALLOWED");
		expect(modelCalls).toHaveLength(3);
	});

	test("an answer with a mistyped field is an outage, not a guess", async () => {
		// The contract's answer shapes are the parser's input: a `verdict`
		// answer carrying no probabilities cannot be turned into a decision,
		// and the gate must not invent one from the missing data.
		setJevRawResponses([{ body: JSON.stringify({ model: "jev-1.13.0", answers: { verdict: { type: "choice", choice: "safe" } } }) }]);
		expect(await gate("make build")).toContain("classifier unavailable");
	});
});

describe("UNAVAILABLE is never a silent allow", () => {
	test("headless blocks: nothing runs on a judgement that never arrived", async () => {
		setJevUnavailable();
		const blocked = await gate("git status");
		const payload = refusalOf(blocked);
		expect(payload.layer).toBe("headless");
		expect(payload.why).toContain("classifier unavailable");
		expect(payload.notThis.length).toBeGreaterThan(0);
	});

	test("with a UI the gate raises a dialog and runs nothing unless a human says so", async () => {
		setJevUnavailable();
		const ctx = makeCtx({ sessionId: "outage-dialog", hasUI: true });
		const blocked = await fire("tool_call", makeEvent("git status"), ctx);
		expect(selectCalls(ctx)).toHaveLength(1);
		expect(selectCalls(ctx)[0][0]).toContain("classifier unavailable");
		// The dialog was not answered, which the host reports as undefined —
		// the gate must read that as denial, not as "no objection".
		expect(refusalOf(blocked).layer).toBe("dialog");
	});

	test("a dialog approval is an explicit human decision, and it runs", async () => {
		setJevUnavailable();
		const ctx = makeCtx({ sessionId: "outage-approve", hasUI: true, selectResult: ALLOW_ONCE });
		expect(await fire("tool_call", makeEvent("git status"), ctx)).toBeUndefined();
	});

	test("a canceled dialog denies, as any unanswered permission request does", async () => {
		setJevUnavailable();
		const ctx = makeCtx({ sessionId: "outage-cancel", hasUI: true });
		const result = await fire("tool_call", makeEvent("git status"), ctx);
		expect(refusalOf(result).layer).toBe("dialog");
	});
});

describe("the outage is visible in the audit trail", () => {
	test("one verdict line, marked UNAVAILABLE, uncached", async () => {
		setJevUnavailable();
		await gate("make build");
		const lines = readDecisions();
		// Headless denial is the documented two-line pair ("Two lines on
		// purpose"): the verdict line, then requestPermission's outcome line.
		expect(lines).toHaveLength(2);
		expect(lines[0]).toMatchObject({ tool: "bash", decision: "block", layer: "verdict", verdict: "UNAVAILABLE", cached: 0 });
		expect(lines[0].why).toContain("classifier unavailable");
		expect(lines[1]).toMatchObject({ tool: "bash", decision: "block", layer: "headless", verdict: null });
		expect(lines[1].why).toContain("classifier unavailable");
		// The verdict line names the rejection (reviewer-visible), the outcome
		// line keeps the empty-`jev` contract; asserting the outcome's layer
		// rather than its absence keeps the headless path observable.
		expect(lines[1].jev).toBeUndefined();
	});

	test("a real verdict after the outage carries the same shape, with telemetry", async () => {
		const session = "outage-recovered";
		const command = "make clean";
		setJevUnavailable();
		await fire("tool_call", makeEvent(command), makeCtx({ sessionId: session }));
		setJevUnavailable(false);
		setJevAnswer(jevUnsafeAnswer());
		await fire("tool_call", makeEvent(command), makeCtx({ sessionId: session }));
		const lines = readDecisions();
		// Two decisions, each the documented headless pair: verdict line, then
		// requestPermission's outcome line. The first pair is the outage, the
		// second the recovered verdict.
		expect(lines).toHaveLength(4);
		expect(lines[0].verdict).toBe("UNAVAILABLE");
		// Nothing arrived, so there is no telemetry to report — an outage line
		// claiming probabilities would be inventing them.
		expect(lines[0].jev).toBeUndefined();
		expect(lines[1]).toMatchObject({ decision: "block", layer: "headless", verdict: null });
		expect(lines[2].verdict).toBe("UNSAFE");
		expect(lines[2].reasonCode).toMatch(/^jev:/u);
		expect(lines[2].jev?.model).toBeTruthy();
		expect(lines[2].jev?.hazards).toBeDefined();
		// The recovered decision's outcome line heads the same way.
		expect(lines[3]).toMatchObject({ decision: "block", layer: "headless", verdict: null });
		expect(lines[3].jev).toBeUndefined();
	});
});
