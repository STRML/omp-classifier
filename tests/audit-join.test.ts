/**
 * Spec step 0b. An ask joins to what a human did next by id, and a judged
 * state can be replayed by a probe. Both are tested through the plugin.
 */
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { DecisionRecord, JudgedStateRecord } from "../index";
import {
	DENY,
	fire,
	fireCommand,
	jevSafeAnswer,
	jevUnsafeAnswer,
	jevUnsureAnswer,
	loadPlugin,
	loggerWarnings,
	makeCtx,
	makeEvent,
	makeSettings,
	modelCalls,
	notifyCalls,
	removeConfigFile,
	setJevAnswer,
	useTempConfigFile,
} from "./fixtures";

let dir = "";
let seq = 0;
let configMtime = Date.now();
const session = (): string => `join-${++seq}`;
const readLines = <T>(file: string): T[] =>
	fs.existsSync(file)
		? fs
				.readFileSync(file, "utf8")
				.split("\n")
				.filter(line => line.trim() !== "")
				.map(line => JSON.parse(line) as T)
		: [];
const decisions = (): DecisionRecord[] => readLines<DecisionRecord>(path.join(dir, "decisions.jsonl"));
const states = (): JudgedStateRecord[] => readLines<JudgedStateRecord>(path.join(dir, "judged-states.jsonl"));
/** The plugin caches its config by mtime, so every write moves it forward. */
const writeConfig = (raw: Record<string, unknown>): void => {
	const file = path.join(dir, "omp-classifier.json");
	fs.writeFileSync(file, JSON.stringify(raw));
	configMtime = Math.max(Date.now(), configMtime + 1_000);
	fs.utimesSync(file, configMtime / 1_000, configMtime / 1_000);
};

beforeEach(async () => {
	removeConfigFile();
	dir = fs.mkdtempSync(path.join(os.tmpdir(), "omp-join-"));
	process.env.OMP_JEV_CONFIG = path.join(dir, "omp-classifier.json");
	await loadPlugin(makeSettings([]));
	setJevAnswer(jevSafeAnswer());
});

afterEach(() => {
	process.env.OMP_JEV_CONFIG = useTempConfigFile();
	fs.rmSync(dir, { recursive: true, force: true });
});

describe("an ask joins to its outcome by id", () => {
	test("a headless line carries the decisionId of the verdict line it follows", async () => {
		setJevAnswer(jevUnsureAnswer());
		await fire("tool_call", makeEvent("echo join-unsure"), makeCtx({ sessionId: session() }));
		const [verdict, headless] = decisions();
		expect(verdict).toMatchObject({ layer: "verdict", verdict: "UNSURE" });
		expect(headless).toMatchObject({ layer: "headless", followsDecisionId: verdict.decisionId });
		expect(headless.decisionId).not.toBe(verdict.decisionId);
	});

	test("a dialog answer carries it too", async () => {
		setJevAnswer(jevUnsureAnswer());
		await fire("tool_call", makeEvent("echo join-dialog"), makeCtx({ sessionId: session(), hasUI: true, selectResult: DENY }));
		const [verdict, dialog] = decisions();
		expect(dialog).toMatchObject({ layer: "dialog", approval: "deny", followsDecisionId: verdict.decisionId });
	});

	test("a critical lead and an eval cwd lead join the same way", async () => {
		await fire("tool_call", makeEvent("rm -rf /"), makeCtx({ sessionId: session() }));
		const eval_ = { toolName: "eval", input: { code: `const cp = require("child_process");\ncp.exec("ls", { cwd: process.env.T });`, language: "js" } };
		await fire("tool_call", eval_, makeCtx({ sessionId: session() }));
		const [critical, criticalOutcome, cwd, cwdOutcome] = decisions();
		expect(critical.layer).toBe("critical");
		expect(criticalOutcome.followsDecisionId).toBe(critical.decisionId);
		expect(cwd.layer).toBe("cwd");
		expect(cwdOutcome.followsDecisionId).toBe(cwd.decisionId);
	});

	test("an allowed verdict line has no follower and no followsDecisionId", async () => {
		await fire("tool_call", makeEvent("echo join-safe"), makeCtx({ sessionId: session() }));
		const lines = decisions();
		expect(lines).toHaveLength(1);
		expect(lines[0].followsDecisionId).toBeUndefined();
	});
});

describe("logJudgedStates", () => {
	test("no states file by default", async () => {
		await fire("tool_call", makeEvent("echo states-off"), makeCtx({ sessionId: session() }));
		expect(fs.existsSync(path.join(dir, "judged-states.jsonl"))).toBe(false);
	});

	test("the states file is keyed by the verdict line and redacted", async () => {
		writeConfig({ logJudgedStates: true });
		await fire("tool_call", makeEvent("mysql --password hunter2-secret -e 'select 1'"), makeCtx({ sessionId: session() }));
		const [verdict] = decisions();
		const [record] = states();
		expect(record.decisionId).toBe(verdict.decisionId ?? "");
		expect(record).toMatchObject({ tool: "bash", policyVersion: verdict.policyVersion, policyHash: verdict.policyHash });
		const text = fs.readFileSync(path.join(dir, "judged-states.jsonl"), "utf8");
		expect(text).not.toContain("hunter2-secret");
		expect((record.states.risk as { command: string }).command).toContain("[redacted]");
		expect(fs.statSync(path.join(dir, "judged-states.jsonl")).mode & 0o777).toBe(0o600);
	});

	test("a prior refusal's target is redacted in the states file", async () => {
		writeConfig({ logJudgedStates: true });
		const sid = session();
		setJevAnswer(jevUnsafeAnswer());
		await fire("tool_call", makeEvent("mysql --password hunter2-secret -e 'drop table t'"), makeCtx({ sessionId: sid }));
		setJevAnswer(jevSafeAnswer());
		// Reworded (two spaces), so the cache misses and the refusal rides in the state.
		await fire("tool_call", makeEvent("mysql  --password hunter2-secret -e 'drop table t'"), makeCtx({ sessionId: sid }));
		const second = states()[1];
		expect(JSON.stringify(second.states.risk)).toContain("priorRefusal");
		expect(fs.readFileSync(path.join(dir, "judged-states.jsonl"), "utf8")).not.toContain("hunter2-secret");
	});

	test("an unwritable states file warns once and decides normally", async () => {
		writeConfig({ logJudgedStates: true });
		fs.mkdirSync(path.join(dir, "judged-states.jsonl"));
		expect(await fire("tool_call", makeEvent("echo states-a"), makeCtx({ sessionId: session() }))).toBeUndefined();
		expect(await fire("tool_call", makeEvent("echo states-b"), makeCtx({ sessionId: session() }))).toBeUndefined();
		expect(loggerWarnings.filter(message => message.includes("judged-state log unwritable"))).toHaveLength(1);
	});

	test("turning state logging on does not flush the cache", async () => {
		const ctx = makeCtx({ sessionId: session() });
		await fire("tool_call", makeEvent("echo states-cached"), ctx);
		writeConfig({ logJudgedStates: true });
		await fire("tool_call", makeEvent("echo states-cached"), ctx);
		expect(modelCalls).toHaveLength(1);
		expect(decisions()[1]).toMatchObject({ layer: "cached" });
	});

	test("/classifier logJudgedStates sets the key and names the file", async () => {
		const ctx = makeCtx({ sessionId: session(), hasUI: true });
		await fireCommand("classifier", "logJudgedStates true", ctx);
		expect(JSON.parse(fs.readFileSync(path.join(dir, "omp-classifier.json"), "utf8")).logJudgedStates).toBe(true);
		expect(notifyCalls(ctx).at(-1)?.[0]).toContain("judged-states.jsonl");
		await fireCommand("classifier", "logJudgedStates maybe", ctx);
		expect(notifyCalls(ctx).at(-1)).toEqual(["usage: /classifier logJudgedStates true|false", "error"]);
	});
});
