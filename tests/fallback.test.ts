/**
 * Runtime model fallback chain: normalization/dedupe/cap of
 * config.fallbackModels, chain building (unresolvable, duplicate, and
 * primary-equal entries drop), retry rules (advance on empty reply and
 * provider error, STOP on timeout), tried-ids in failure reasons, and chain
 * identity in both cache keys and the config signature.
 */
import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import type { Model } from "@oh-my-pi/pi-ai";
import { buildClassifierChain } from "../index";
import {
	classifierAttemptCount,
	fire,
	fireCommand,
	loadPlugin,
	loggerInfos,
	makeCtx,
	makeEvent,
	makeSettings,
	modelCalls,
	notifyCalls,
	refusalOf,
	removeConfigFile,
	resultText,
	setClassifierDelay,
	setClassifierFailures,
	setClassifierReplies,
	setClassifierReply,
	writeConfigFile,
} from "./fixtures";

beforeEach(async () => {
	removeConfigFile();
	setClassifierDelay(5);
	await loadPlugin(makeSettings([]));
	setClassifierReply("UNSAFE");
});

// Bun runs every file in one process: leave the stub exactly as found, or
// the UNSAFE default this file arms leaks into later files that trust it.
afterAll(() => {
	setClassifierReply("SAFE");
	setClassifierReplies([]);
	setClassifierFailures(0);
});

let seq = 0;

/** Primary is always the @tiny role resolved to { id: "tiny" } unless said otherwise. */
const gate = async (command: string, opts: { sessionId?: string; tinyModel?: unknown } = {}) => {
	seq += 1;
	return resultText(
		await fire(
			"tool_call",
			makeEvent(command),
			makeCtx({ sessionId: opts.sessionId ?? `fallback-${seq}`, tinyModel: opts.tinyModel ?? { id: "tiny" } }),
		),
	);
};

const chainIds = (): string[] => modelCalls.map(call => (call.model as { id: string }).id);

const showConfig = async (): Promise<string> => {
	const ctx = makeCtx({ sessionId: `fallback-config-${(seq += 1)}` });
	await fireCommand("classifier", "", ctx);
	return notifyCalls(ctx)[0][0];
};

describe("fallbackModels config key", () => {
	test("trims, drops empties and non-strings, dedupes case-insensitively, caps at 3", async () => {
		writeConfigFile({
			fallbackModels: ["  deepseek ", "", "DEEPSEEK", "glm", 7, ["nested"], "four", "five"],
		});
		expect(await showConfig()).toContain("fallbackModels: deepseek, glm, four");
	});

	test("a non-array keeps the default (none)", async () => {
		writeConfigFile({ fallbackModels: "deepseek" });
		expect(await showConfig()).toContain("fallbackModels: (none)");
	});

	test("setter takes comma-separated ids; bare key clears the chain", async () => {
		const ctx = makeCtx({ sessionId: "fallback-setter" });
		await fireCommand("classifier", "fallbackModels deepseek, glm", ctx);
		expect(notifyCalls(ctx)[0][0]).toContain("fallbackModels=deepseek, glm");
		await fireCommand("classifier", "fallbackModels", ctx);
		expect(notifyCalls(ctx)[1][0]).toContain("fallbackModels=(none)");
		// The clear persisted to the config file.
		await fireCommand("classifier", "", ctx);
		expect(notifyCalls(ctx)[2][0]).toContain("fallbackModels: (none)");
	});

	test("reset restores the defaults: empty chain, evidenceUserMessages 3", async () => {
		writeConfigFile({ fallbackModels: ["deepseek"], evidenceUserMessages: 0 });
		const ctx = makeCtx({ sessionId: "fallback-reset" });
		await fireCommand("classifier", "reset", ctx);
		const text = await showConfig();
		expect(text).toContain("fallbackModels: (none)");
		expect(text).toContain("evidenceUserMessages: 3");
	});
});

describe("chain building", () => {
	const fakeModel = (id: string): Model => ({ id }) as Model;
	const resolver = (table: Record<string, Model | undefined>) => (selector: string) => table[selector];

	test("primary first; unresolvable, duplicate, and primary-equal fallbacks drop", () => {
		const primary = fakeModel("tiny");
		const chain = buildClassifierChain(
			primary,
			["missing", "deepseek", "deepseek-alias", "tiny", "glm"],
			resolver({
				missing: undefined,
				deepseek: fakeModel("deepseek"),
				"deepseek-alias": fakeModel("deepseek"),
				tiny: primary,
				glm: fakeModel("glm"),
			}),
		);
		expect(chain.map(entry => entry.id)).toEqual(["tiny", "deepseek", "glm"]);
	});

	test("no primary leaves the resolvable fallbacks", () => {
		const chain = buildClassifierChain(undefined, ["a", "gone", "b"], resolver({ a: fakeModel("a"), gone: undefined, b: fakeModel("b") }));
		expect(chain.map(entry => entry.id)).toEqual(["a", "b"]);
	});
});

describe("retry rules through the gate", () => {
	test("empty reply on the primary: the fallback verdict wins", async () => {
		writeConfigFile({ fallbackModels: ["deepseek"] });
		setClassifierReplies(["", "SAFE | fallback answered"]);
		expect(await gate("make build")).toBe("ALLOWED");
		expect(chainIds()).toEqual(["tiny", "deepseek"]);
		// One classification = one judgement = one decision log line.
		expect(loggerInfos.filter(line => line.startsWith("classifier: verdict="))).toHaveLength(1);
	});

	test("provider exception on the primary: the fallback verdict wins", async () => {
		writeConfigFile({ fallbackModels: ["deepseek"] });
		setClassifierFailures(1);
		setClassifierReply("SAFE");
		expect(await gate("make clean")).toBe("ALLOWED");
		// The stub records only completions; the throw never lands in
		// modelCalls, so the attempt counter is the evidence for the primary.
		expect(classifierAttemptCount()).toBe(2);
		expect(chainIds()).toEqual(["deepseek"]);
	});

	test("a malformed non-empty reply gets one bounded repair review", async () => {
		writeConfigFile({ fallbackModels: ["deepseek"] });
		setClassifierReplies(["this is not a verdict at all", "SAFE"]);
		const result = await gate("make build");
		expect(result).toBe("ALLOWED");
		expect(classifierAttemptCount()).toBe(2);
		expect(chainIds()).toEqual(["tiny", "tiny"]);
	});

	test("timeout on the primary stops the chain: no second attempt", async () => {
		writeConfigFile({ timeoutMs: 20, fallbackModels: ["deepseek"] });
		setClassifierDelay(10_000);
		const result = await gate("git status");
		expect(result).toContain("unclassified");
		// The abort fires before the stub completes, so neither attempt lands in
		// modelCalls; the invocation counter is the only witness.
		expect(classifierAttemptCount()).toBe(1);
	});
});

describe("failure reasons", () => {
	test("all-empty chain keeps the outage reason and appends the tried ids", async () => {
		writeConfigFile({ fallbackModels: ["deepseek", "glm"] });
		setClassifierReplies(["", "", ""]);
		const result = await gate("make build");
		expect(result).toContain("classifier model returned no content — check the model's provider credits/quota");
		expect(result).toContain("(tried: tiny, deepseek, glm)");
		expect(refusalOf(result).layer).toBe("headless");
	});

	test("a single-model chain keeps the legacy reason byte-for-byte", async () => {
		setClassifierReplies([""]);
		const result = await gate("make build");
		expect(result).toContain("classifier model returned no content — check the model's provider credits/quota");
		expect(result).not.toContain("(tried:");
	});
});

describe("chain identity in caches", () => {
	test("bash: changing the chain reclassifies the same command", async () => {
		const session = "fallback-bash-key";
		await gate("npm publish", { sessionId: session });
		await gate("npm publish", { sessionId: session });
		expect(chainIds()).toEqual(["tiny"]);
		writeConfigFile({ fallbackModels: ["deepseek"] });
		await gate("npm publish", { sessionId: session });
		expect(modelCalls.length).toBe(2);
	});

	test("bash: reverting the chain still reclassifies — the config signature flushed the old verdict", async () => {
		const session = "fallback-signature";
		const cmd = "npm publish";
		await gate(cmd, { sessionId: session }); // no config file: chain []
		writeConfigFile({ fallbackModels: ["deepseek"] });
		await gate(cmd, { sessionId: session });
		writeConfigFile({ fallbackModels: ["glm"] });
		await gate(cmd, { sessionId: session });
		// Back to the starting chain: the per-session cache key matches the
		// first verdict again, but the signature change wiped the store.
		writeConfigFile({ fallbackModels: [] });
		await gate(cmd, { sessionId: session });
		expect(modelCalls.length).toBe(4);
	});

	test("eval: the payload key includes the chain too", async () => {
		const session = "fallback-eval-key";
		const code = "import subprocess; subprocess.run(['ls'])";
		const evalFire = () =>
			fire("tool_call", { toolName: "eval", input: { code, language: "py" } }, makeCtx({ sessionId: session, tinyModel: { id: "tiny" } }));
		await evalFire();
		await evalFire();
		expect(chainIds()).toEqual(["tiny"]);
		writeConfigFile({ fallbackModels: ["deepseek"] });
		await evalFire();
		expect(modelCalls.length).toBe(2);
	});
});
