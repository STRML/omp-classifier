/**
 * The plugin's own config (OMP's /settings has no extension hook, so this is a
 * small JSON file + the /classifier command). Tests cover defaults, garbage
 * tolerance, the enabled=false semantics (classification off, critical/env/static
 * checks still on), the host-resolved model id, timeout, and the command-length bound.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
	fire,
	jevSafeAnswer,
	loadPlugin,
	makeCtx,
	makeEvent,
	makeSettings,
	modelCalls,
	removeConfigFile,
	refusalOf,
	resultText,
	setJevAnswer,
	setJevDelay,
	writeConfigFile,
} from "./fixtures";

beforeEach(async () => {
	removeConfigFile();
	setJevDelay(5);
	await loadPlugin(makeSettings([]));
});

// The judge's model id is a derived identity now (`TYPESAFE_DEFAULT_MODEL`, else
// the vendor alias), read from the host rather than from the config file — so a
// test that pins it sets the env var, and this keeps that pin from leaking into
// a sibling file that expects the default.
afterEach(() => {
	delete process.env.TYPESAFE_DEFAULT_MODEL;
});

const gate = async (
	command: string,
	opts: { hasUI?: boolean; sessionId?: string } = {},
	input: Record<string, unknown> = {},
) =>
	resultText(
		await fire("tool_call", makeEvent(command, input), makeCtx({ sessionId: `config-${Math.random().toString(36).slice(2)}`, ...opts })),
	);

describe("defaults with no config file", () => {
	test("classifier runs, 8000-char bound, 15s timeout, default model", async () => {
		const ctx = makeCtx({});
		await fire("tool_call", makeEvent("git status"), ctx);
		expect(modelCalls.length).toBe(1);

		const long = "echo " + "x".repeat(8_050);
		const blocked = await gate(long);
		expect(blocked).toContain("review limit");
		expect(modelCalls.length).toBe(1); // no model call for the over-length command
	});
});

describe("enabled=false", () => {
	test("classification is skipped; command passes to the host gate", async () => {
		writeConfigFile({ enabled: false });
		expect(await gate("make build")).toBe("ALLOWED");
		expect(modelCalls.length).toBe(0);
	});

	test("critical patterns still block", async () => {
		writeConfigFile({ enabled: false });
		const result = await gate("rm -rf /");
		expect(result).toContain("critical pattern");
		expect(refusalOf(result).layer).toBe("headless");
		expect(modelCalls.length).toBe(0);
	});

	test("env overrides still prompt", async () => {
		writeConfigFile({ enabled: false });
		const result = await gate("echo hi", {}, { env: { PATH: "/evil" } });
		expect(result).toContain("environment override");
		expect(modelCalls.length).toBe(0);
	});

	test("static deny rule still passes through to the host", async () => {
		writeConfigFile({ enabled: false });
		await loadPlugin(makeSettings([{ match: "rm -rf *", approval: "deny" }]));
		expect(await gate("rm -rf build")).toBe("ALLOWED");
		expect(modelCalls.length).toBe(0);
	});
});

describe("typesafeModel", () => {
	test("TYPESAFE_DEFAULT_MODEL is the model the judgement asks for", async () => {
		// The judge resolves its own model from the host (`TYPESAFE_DEFAULT_MODEL`
		// wins, the vendor alias otherwise); a config file's `typesafeModel` key is
		// deliberately not a knob any more, and the garbage-config test below
		// covers that it is tolerated rather than honored.
		process.env.TYPESAFE_DEFAULT_MODEL = "jev-pinned";
		await gate("make build");
		expect(modelCalls.length).toBe(1);
		// One model id, resolved by the client itself: the gate has no role
		// resolution (@tiny, session model) of its own to fall back through.
		expect(modelCalls[0].model).toBe("jev-pinned");
	});

	test("with no model pinned the judgement asks for the default jev-latest", async () => {
		delete process.env.TYPESAFE_DEFAULT_MODEL;
		await gate("make build");
		expect(modelCalls.length).toBe(1);
		// The vendor alias, resolved server-side — never a pinned version.
		expect(modelCalls[0].model).toBe("jev-latest");
	});

	test("changing classifier config invalidates cached verdicts", async () => {
		setJevAnswer(jevSafeAnswer());
		await gate("git status", { sessionId: "sig-session" });
		expect(modelCalls.length).toBe(1);
		// Same session + command + cwd: without a config change this is cached.
		await gate("git status", { sessionId: "sig-session" });
		expect(modelCalls.length).toBe(1);

		// Toggling enabled (or typesafeModel/timeout) is a trust-state change:
		// the old SAFE verdict must not survive it.
		writeConfigFile({ enabled: false });
		await gate("git status", { sessionId: "sig-session" });
		expect(modelCalls.length).toBe(1); // no classify at all now
	});
});

describe("bounds and garbage", () => {
	test("maxCommandLength from config", async () => {
		writeConfigFile({ maxCommandLength: 100 });
		const blocked = await gate("echo " + "y".repeat(120));
		expect(blocked).toContain("100-character review limit");
		expect(modelCalls.length).toBe(0);
	});

	test("maxCommandLength above the 100k ceiling falls back to default", async () => {
		// A typo'd huge value must not push multi-MB commands into the
		// classifier prompt and confirm dialog.
		writeConfigFile({ maxCommandLength: 5_000_000 });
		const blocked = await gate("echo " + "z".repeat(8_050));
		expect(blocked).toContain("8000-character review limit");
		expect(modelCalls.length).toBe(0);
	});

	test("timeoutMs from config aborts a slow judgement", async () => {
		// bun's AbortSignal.timeout exposes no duration, so the configurable
		// timeout is proven behaviorally: a 20ms limit aborts the request
		// before the fake Jev answers, and the gate fails closed instead of
		// running the command on a judgement that never arrived.
		setJevDelay(10_000); // the fake answer is 10s away; the 20ms timeout aborts first
		writeConfigFile({ timeoutMs: 20 });
		const result = await gate("git status");
		expect(result).toContain("classifier unavailable");
		expect(refusalOf(result).layer).toBe("headless");
		// The request WAS sent: the fake captures it on arrival, before the
		// delay. The old expectation of 0 here was an artifact of recording
		// only completions that finished.
		expect(modelCalls.length).toBe(1);
	});

	test("garbage config falls back to defaults", async () => {
		// `typesafeModel: 7` is doubly inert now: the key is no longer read at all
		// (the model comes from the host), and a non-string would have been ignored
		// even when it was — so the file must not be able to choose a model.
		writeConfigFile({ enabled: "banana", typesafeModel: 7, timeoutMs: -1, maxCommandLength: 0 });
		const result = await gate("git status");
		expect(result).toBe("ALLOWED"); // default enabled, SAFE -> through
		expect(modelCalls.length).toBe(1);
		expect(modelCalls[0].model).toBe("jev-latest");
	});
});
