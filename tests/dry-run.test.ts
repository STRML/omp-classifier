/**
 * The /classifier dry-run preview (issue #32), the dialog's audit lines, and
 * the action identity refusal memory keys on.
 *
 * Dry-run: /classifier dry-run <command> fires the real gate once with all
 * side effects off and reports the first decision it reaches.
 *
 * Each test points OMP_JEV_CONFIG at a fresh temp dir, so decisions.jsonl and
 * the config file are per-test (same convention as audit-log.test.ts). Fresh
 * sessions per test: the plugin's stores are module-level.
 */
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { buildStatusReport, normalizeActionTarget, type DecisionRecord } from "../index";
import {
	ALLOW_ONCE,
	DENY,
	fire,
	fireCommand,
	jevSafeAnswer,
	jevUnsafeAnswer,
	loadPlugin,
	makeCtx,
	makeEvent,
	makeSettings,
	modelCalls,
	notifyCalls,
	refusalOf,
	resultText,
	selectCalls,
	setJevAnswer,
	writeConfigFile,
	removeConfigFile,
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
	removeConfigFile();
	dir = fs.mkdtempSync(path.join(os.tmpdir(), "omp-dry-run-"));
	process.env.OMP_JEV_CONFIG = path.join(dir, "omp-classifier.json");
	await loadPlugin(makeSettings([]));
	setJevAnswer(jevUnsafeAnswer());
});

afterEach(() => {
	fs.rmSync(dir, { recursive: true, force: true });
});
// Producer-side cleanup (issue #107): this file writes the config file, so it
// removes it after itself instead of relying on the next consumer's reset.
afterEach(removeConfigFile);

const nextSession = (): string => `dry-run-${(seq += 1)}`;

/** Parse the JSON the dry-run command toasted. */
const dryRunReport = async (command: string, sessionId: string, cwd?: string): Promise<Record<string, unknown>> => {
	const ctx = makeCtx({ sessionId, cwd });
	await fireCommand("classifier", `dry-run ${command}`, ctx);
	const calls = notifyCalls(ctx);
	expect(calls.length).toBeGreaterThan(0);
	return JSON.parse(calls[calls.length - 1][0]) as Record<string, unknown>;
};

/** One UNSAFE dialog answered with `answer`, returning the gate result. */
const prompted = async (command: string, answer: string, sessionId: string) => {
	const ctx = makeCtx({ sessionId, hasUI: true, selectResult: answer });
	const result = await fire("tool_call", makeEvent(command), ctx);
	return { ctx, result };
};

describe("dialog outcomes", () => {
	test("Allow once does not outlive the call: the same command prompts again", async () => {
		const sid = nextSession();
		const first = await prompted(`git branch -D feature-${sid}`, ALLOW_ONCE, sid);
		expect(resultText(first.result)).toBe("ALLOWED");

		const secondCtx = makeCtx({ sessionId: sid, hasUI: true });
		const second = await fire("tool_call", makeEvent(`git branch -D feature-${sid}`), secondCtx);
		expect(refusalOf(second).layer).toBe("dialog");
		expect(selectCalls(secondCtx)).toHaveLength(1);
	});

	test("a canceled dialog (undefined) denies, and the audit line says so", async () => {
		const sid = nextSession();
		const ctx = makeCtx({ sessionId: sid, hasUI: true });
		const result = await fire("tool_call", makeEvent(`git branch -D feature-${sid}`), ctx);
		expect(refusalOf(result).layer).toBe("dialog");
		const lines = readDecisions();
		expect(lines[lines.length - 1].why.startsWith("prompt canceled")).toBe(true);
	});

	test("explicit Deny keeps the old audit why", async () => {
		const sid = nextSession();
		await prompted(`git branch -D feature-${sid}`, DENY, sid);
		const lines = readDecisions();
		expect(lines[lines.length - 1]).toMatchObject({ decision: "block", layer: "dialog" });
		expect(lines[lines.length - 1].why.startsWith("follows verdict")).toBe(true);
	});
});

describe("/classifier dry-run", () => {
	test("over-cap command reports would block at the cap and writes no audit line", async () => {
		const sid = nextSession();
		const long = `echo ${"x".repeat(9000)}`;
		// One live decision first, so the log exists and its length is known.
		const live = await fire("tool_call", makeEvent(long), makeCtx({ sessionId: sid }));
		expect(refusalOf(live).layer).toBe("cap");
		expect(readDecisions()).toHaveLength(1);

		const report = await dryRunReport(long, sid);
		expect(report).toMatchObject({ would: "block", layer: "cap" });
		expect(readDecisions()).toHaveLength(1);
	});

	test("a rule-allowed command reports would allow at the rule layer", async () => {
		await loadPlugin(makeSettings([{ match: "git status", approval: "allow" }]));
		const report = await dryRunReport("git status", nextSession());
		expect(report).toMatchObject({ would: "allow", layer: "rule" });
		expect(modelCalls.length).toBe(0);
	});

	test("an undecided command reports would classify and skips the model call", async () => {
		setJevAnswer(jevSafeAnswer());
		const sid = nextSession();
		const report = await dryRunReport(`git branch -D feature-${sid}`, sid);
		expect(report).toMatchObject({ would: "classify", layer: "classifier" });
		expect(modelCalls.length).toBe(0);
		// No cached verdict was fabricated by the probe: the session's cache
		// exists (the gate allocates it on entry) but holds zero entries.
		expect(buildStatusReport().cacheSizes[sid]).toBe(0);
	});

	test("a SAFE cached with evidence off is not followed once evidence is on and empty", async () => {
		// A live call clears the cache on a config change and a dry-run probe does not, so
		// the key itself must tell "evidence off" from "on, but no user wrote anything".
		writeConfigFile({ evidenceUserMessages: 0 });
		setJevAnswer(jevSafeAnswer());
		const sid = nextSession();
		const command = `echo evidence-flip-${sid}`;
		await fire("tool_call", makeEvent(command), makeCtx({ sessionId: sid }));
		expect(buildStatusReport().cacheSizes[sid]).toBe(1);

		writeConfigFile({ evidenceUserMessages: 3 });
		const report = await dryRunReport(command, sid);
		expect(report).toMatchObject({ would: "classify", layer: "classifier" });
	});

	test("a cached verdict is followed without a model call, mutating nothing", async () => {
		setJevAnswer(jevSafeAnswer());
		const sid = nextSession();
		const command = `echo cached-dry-${sid}`;
		await fire("tool_call", makeEvent(command), makeCtx({ sessionId: sid }));
		expect(modelCalls.length).toBe(1);
		expect(buildStatusReport().cacheSizes[sid]).toBe(1);
		const auditLines = readDecisions().length;

		const report = await dryRunReport(command, sid);
		expect(report).toMatchObject({ would: "allow", layer: "cached" });
		expect(modelCalls.length).toBe(1);
		expect(buildStatusReport().cacheSizes[sid]).toBe(1);
		expect(readDecisions()).toHaveLength(auditLines);
	});
});

describe("action identity", () => {
	test("normalizeActionTarget unit table", () => {
		expect(normalizeActionTarget("git push origin main")).toBe("git push origin");
		expect(normalizeActionTarget("git push --force origin main")).toBe("git push --force origin");
		expect(normalizeActionTarget("GIT   PUSH --Force ORIGIN main")).toBe("git push --force origin");
		expect(normalizeActionTarget("pkill -f MyApp")).toBe("pkill -f myapp");
		expect(normalizeActionTarget("rm -rf x")).toBe(normalizeActionTarget("rm -r -f x"));
		expect(normalizeActionTarget("rm x")).not.toBe(normalizeActionTarget("rm -rf x"));
		expect(normalizeActionTarget("cd /tmp && rm -rf x")).toBe(normalizeActionTarget("rm -rf x"));
		expect(normalizeActionTarget("rm -rf ./x")).toBe(normalizeActionTarget("rm -rf x"));
		expect(normalizeActionTarget("echo hello")).toBe("echo hello");
		expect(normalizeActionTarget("git status")).toBe("git status");
		expect(normalizeActionTarget("")).toBe("");
	});
});
