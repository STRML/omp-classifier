/**
 * Persistent grants are gone (https://github.com/STRML/omp-classifier/issues/184).
 * A leftover omp-classifier-grants.json is never read, a leftover
 * `persistentGrants` key is an unknown key, and the dialog offers no
 * "Always allow".
 */
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { readClassifierConfig } from "../index.ts";
import {
	fire,
	fireCommand,
	jevUnsafeAnswer,
	loadPlugin,
	makeCtx,
	makeEvent,
	makeSettings,
	modelCalls,
	notifyCalls,
	removeConfigFile,
	resultText,
	selectCalls,
	setJevAnswer,
} from "./fixtures";

let dir = "";
let seq = 0;
const nextSession = (): string => `npg-${(seq += 1)}`;

beforeEach(async () => {
	removeConfigFile();
	dir = fs.mkdtempSync(path.join(os.tmpdir(), "omp-no-persistent-grants-"));
	process.env.OMP_JEV_CONFIG = path.join(dir, "omp-classifier.json");
	await loadPlugin(makeSettings([]));
	setJevAnswer(jevUnsafeAnswer());
});

afterEach(() => {
	fs.rmSync(dir, { recursive: true, force: true });
});

describe("no persistent grants", () => {
	test("a leftover grants file with the exact command does not skip judgment", async () => {
		const command = "git branch -D feature-leftover";
		fs.writeFileSync(
			path.join(dir, "omp-classifier-grants.json"),
			JSON.stringify({ version: 1, grants: [{ cmd: command, cwd: "/workspace", ts: Date.now() }] }),
		);
		const before = modelCalls.length;
		const result = await fire("tool_call", makeEvent(command), makeCtx({ sessionId: nextSession() }));
		expect(resultText(result)).not.toBe("ALLOWED");
		expect(modelCalls.length).toBe(before + 1);
	});

	test("a leftover persistentGrants key loads and is not a config key", async () => {
		fs.writeFileSync(path.join(dir, "omp-classifier.json"), JSON.stringify({ persistentGrants: false }));
		const config = readClassifierConfig() as unknown as Record<string, unknown>;
		expect("persistentGrants" in config).toBe(false);
		const ctx = makeCtx({ sessionId: nextSession(), hasUI: true });
		await fireCommand("classifier", "persistentGrants true", ctx);
		expect(notifyCalls(ctx).some(([message]) => message.includes('unknown key "persistentGrants"'))).toBe(true);
	});

	test("the dialog offers no Always allow", async () => {
		const ctx = makeCtx({ sessionId: nextSession(), hasUI: true, selectResult: "Deny" });
		await fire("tool_call", makeEvent("git branch -D feature-dialog"), ctx);
		const labels = selectCalls(ctx)[0]?.[1].map(option => option.label);
		expect(labels).not.toContain("Always allow");
	});
});
