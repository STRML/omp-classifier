/**
 * Persistent "Always allow" grants: the dialog's fourth option writes
 * {cmd, cwd, ts} to omp-classifier-grants.json (beside omp-classifier.json),
 * and a live entry lets that EXACT command text run in that directory across
 * every session for 30 days — no model call, no cache write, one audit line.
 *
 * The safety shape under test: exact text (compounds included, since host
 * static rules never match a multi-segment command) plus exact cwd; the
 * critical/env/static layers still rank above any grant; the kill-switch
 * (persistentGrants: false) disables reads, writes, and the dialog option; a
 * corrupt store reads as zero grants; the cap evicts oldest; TTL prunes.
 */
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { DecisionRecord } from "../index.ts";
import {
	ALWAYS_ALLOW,
	ALLOW_ONCE,
	ALLOW_SESSION,
	DENY,
	fire,
	fireCommand,
	loadPlugin,
	makeCtx,
	makeEvent,
	makeSettings,
	modelCalls,
	notifyCalls,
	refusalOf,
	resultText,
	selectCalls,
	setClassifierReply,
} from "./fixtures";

let dir = "";
let seq = 0;

const grantsPath = (): string => path.join(dir, "omp-classifier-grants.json");
const decisionsPath = (): string => path.join(dir, "decisions.jsonl");

interface GrantEntry {
	cmd: string;
	cwd: string;
	ts: number;
}
interface StoreFile {
	version: number;
	grants: GrantEntry[];
}

const readStore = (): StoreFile => JSON.parse(fs.readFileSync(grantsPath(), "utf8")) as StoreFile;

const readDecisions = (): DecisionRecord[] =>
	fs
		.readFileSync(decisionsPath(), "utf8")
		.split("\n")
		.filter(line => line.trim() !== "")
		.map(line => JSON.parse(line) as DecisionRecord);

let lastStoreMtimeMs = 0;

/** Seed the store directly (hand-written state: expired entries, caps,
 *  corruption). Forces a strictly increasing mtime so the gate's mtime cache
 *  can never serve a stale copy on coarse-granularity filesystems. */
function writeStore(raw: unknown): void {
	fs.writeFileSync(grantsPath(), typeof raw === "string" ? raw : JSON.stringify(raw));
	const mtimeMs = Math.max(Date.now(), lastStoreMtimeMs + 1);
	fs.utimesSync(grantsPath(), mtimeMs / 1000, mtimeMs / 1000);
	lastStoreMtimeMs = mtimeMs;
}

const DAY = 24 * 60 * 60 * 1000;

let lastConfigMtimeMs = 0;

/** Write the config file in THIS test's dir. Never fixtures.writeConfigFile:
 *  it repoints OMP_CLASSIFIER_CONFIG at a shared per-process temp dir, which
 *  would break the per-test decisions/grants paths below. Same
 *  strictly-increasing mtime trick to defeat coarse-granularity mtimes. */
function writeTestConfig(raw: Record<string, unknown>): void {
	const target = path.join(dir, "omp-classifier.json");
	fs.writeFileSync(target, JSON.stringify(raw));
	const mtimeMs = Math.max(Date.now(), lastConfigMtimeMs + 1);
	fs.utimesSync(target, mtimeMs / 1000, mtimeMs / 1000);
	lastConfigMtimeMs = mtimeMs;
}

beforeEach(async () => {
	dir = fs.mkdtempSync(path.join(os.tmpdir(), "omp-persistent-grants-"));
	process.env.OMP_CLASSIFIER_CONFIG = path.join(dir, "omp-classifier.json");
	await loadPlugin(makeSettings([]));
	setClassifierReply("UNSAFE | no");
});

afterEach(() => {
	fs.rmSync(dir, { recursive: true, force: true });
});

const nextSession = (): string => `pg-${(seq += 1)}`;

/** One UNSAFE dialog answered with `answer`, returning the gate result. */
const prompted = async (command: string, answer: string, sessionId: string, cwd?: string) => {
	const ctx = makeCtx({ sessionId, hasUI: true, selectResult: answer, cwd });
	const result = await fire("tool_call", makeEvent(command), ctx);
	return { ctx, result };
};

describe("persistent grants", () => {
	test("Always allow writes the store, allows this call, and shows the full option ladder", async () => {
		const sid = nextSession();
		const command = `git branch -D feature-${sid}`;
		const { ctx, result } = await prompted(command, ALWAYS_ALLOW, sid);
		expect(resultText(result)).toBe("ALLOWED");

		// The bash ladder, in escalating scope. The cursor stays on Allow once.
		const [, options] = selectCalls(ctx)[0];
		expect(options.map(option => option.label)).toEqual([ALLOW_ONCE, ALLOW_SESSION, ALWAYS_ALLOW, DENY]);

		const store = readStore();
		expect(store.version).toBe(1);
		expect(store.grants).toHaveLength(1);
		expect(store.grants[0].cmd).toBe(command);
		expect(store.grants[0].cwd).toBe("/workspace");
		expect(Math.abs(Date.now() - store.grants[0].ts)).toBeLessThan(10_000);

		// The dialog outcome names the persistent grant, mirroring the
		// session-grant wording convention.
		const lines = readDecisions();
		expect(lines[lines.length - 1].why).toBe("approved by user (persistent grant)");
	});

	test("a grant hit allows in a LATER session with no dialog, no model call, no cache write", async () => {
		const sid = nextSession();
		const command = `git branch -D feature-${sid}`;
		await prompted(command, ALWAYS_ALLOW, sid);
		expect(modelCalls.length).toBe(1);

		// A brand-new session id: the session grant store cannot answer here.
		const later = nextSession();
		const ctx = makeCtx({ sessionId: later, hasUI: true });
		const result = await fire("tool_call", makeEvent(command), ctx);
		expect(result).toBeUndefined();
		expect(selectCalls(ctx)).toHaveLength(0);
		expect(modelCalls.length).toBe(1);

		// The audit lines carry the same shape as a session-grant hit —
		// identical field ORDER (issue #33 contract) with only `why` changed.
		// One UNSAFE classify logs two lines (verdict block, then dialog
		// outcome), so hits are picked by `why`, not by index.
		await prompted(`git branch -D other-${sid}`, ALLOW_SESSION, later);
		await fire("tool_call", makeEvent(`git branch -D other-${sid}`), makeCtx({ sessionId: later, hasUI: true }));
		const persistentHits = readDecisions().filter(line => line.why === "persistent grant");
		const sessionHits = readDecisions().filter(line => line.why === "session grant");
		expect(persistentHits.length).toBeGreaterThan(0);
		expect(sessionHits.length).toBeGreaterThan(0);
		const persistentHit = persistentHits[persistentHits.length - 1];
		const sessionHit = sessionHits[sessionHits.length - 1];
		expect(persistentHit).toMatchObject({ decision: "allow", layer: "granted", why: "persistent grant", verdict: null, cached: 0, tool: "bash", cwd: "/workspace" });
		expect(Object.keys(persistentHit)).toEqual(Object.keys(sessionHit));
	});

	test("the key is the exact text: a different cwd classifies again", async () => {
		const sid = nextSession();
		await prompted(`git branch -D feature-${sid}`, ALWAYS_ALLOW, sid);
		expect(modelCalls.length).toBe(1);

		const elsewhere = makeCtx({ sessionId: sid, hasUI: true, cwd: "/elsewhere" });
		const result = await fire("tool_call", makeEvent(`git branch -D feature-${sid}`), elsewhere);
		expect(refusalOf(result).layer).toBe("dialog");
		expect(selectCalls(elsewhere)).toHaveLength(1);
		expect(modelCalls.length).toBe(2);
	});

	test("the key is the exact text: any edit to the command classifies again", async () => {
		const sid = nextSession();
		const original = `git push origin topic-${sid}`;
		await prompted(original, ALWAYS_ALLOW, sid);
		expect(modelCalls.length).toBe(1);

		const edited = makeCtx({ sessionId: sid, hasUI: true });
		const result = await fire("tool_call", makeEvent(`git push --force origin topic-${sid}`), edited);
		expect(refusalOf(result).layer).toBe("dialog");
		expect(modelCalls.length).toBe(2);
	});

	test("compound commands are grantable and match verbatim", async () => {
		const sid = nextSession();
		const compound = `cd /tmp && ./deploy-${sid}.sh --force`;
		const { ctx, result } = await prompted(compound, ALWAYS_ALLOW, sid);
		expect(resultText(result)).toBe("ALLOWED");

		// No strict session-grant key exists for a compound, so the session
		// option is hidden while Always allow is offered — the whole point of
		// exact-text grants.
		const [, options] = selectCalls(ctx)[0];
		expect(options.map(option => option.label)).toEqual([ALLOW_ONCE, ALWAYS_ALLOW, DENY]);

		// Identical text runs clean, cross-session, with no model call.
		const later = nextSession();
		const rerun = makeCtx({ sessionId: later, hasUI: true });
		expect(await fire("tool_call", makeEvent(compound), rerun)).toBeUndefined();
		expect(selectCalls(rerun)).toHaveLength(0);
		expect(modelCalls.length).toBe(1);

		// A rewording of the compound is a different key.
		const reworded = makeCtx({ sessionId: later, hasUI: true });
		const blocked = await fire("tool_call", makeEvent(`cd /tmp && ./${`deploy-${sid}`}.sh`), reworded);
		expect(refusalOf(blocked).layer).toBe("dialog");
		expect(modelCalls.length).toBe(2);
	});

	test("an env-override call still blocks at the env layer even with a live grant", async () => {
		const sid = nextSession();
		await prompted(`./scripts/build-${sid}.sh`, ALWAYS_ALLOW, sid);
		expect(modelCalls.length).toBe(1);

		const ctx = makeCtx({ sessionId: sid, hasUI: true });
		const result = await fire("tool_call", makeEvent(`./scripts/build-${sid}.sh`, { env: { PATH: "/evil" } }), ctx);
		expect(resultText(result)).toContain("environment override");
		expect(selectCalls(ctx)[0][0]).toContain("environment override");
		expect(modelCalls.length).toBe(1); // the grant path never classified
		expect(readStore().grants).toHaveLength(1); // and the grant was not touched
	});

	test("a critical pattern still outranks a persistent grant", async () => {
		await prompted("rm -rf x", ALWAYS_ALLOW, nextSession());
		const ctx = makeCtx({ sessionId: nextSession(), hasUI: true });
		await fire("tool_call", makeEvent("rm -rf /"), ctx);
		expect(selectCalls(ctx)[0][0]).toContain("critical pattern");
		expect(modelCalls.length).toBe(1);
	});

	test("entries expire after 30 days: an expired grant classifies again", async () => {
		const sid = nextSession();
		writeStore({ version: 1, grants: [{ cmd: `git branch -D stale-${sid}`, cwd: "/workspace", ts: Date.now() - 31 * DAY }] });

		const ctx = makeCtx({ sessionId: sid, hasUI: true });
		const result = await fire("tool_call", makeEvent(`git branch -D stale-${sid}`), ctx);
		expect(refusalOf(result).layer).toBe("dialog");
		expect(modelCalls.length).toBe(1);
	});

	test("a grant inside the TTL still matches at day 29", async () => {
		const sid = nextSession();
		writeStore({ version: 1, grants: [{ cmd: `git branch -D fresh-${sid}`, cwd: "/workspace", ts: Date.now() - 29 * DAY }] });

		const ctx = makeCtx({ sessionId: sid, hasUI: true });
		expect(await fire("tool_call", makeEvent(`git branch -D fresh-${sid}`), ctx)).toBeUndefined();
		expect(selectCalls(ctx)).toHaveLength(0);
		expect(modelCalls.length).toBe(0);
	});

	test("pruning happens on write: a dialog approval drops expired entries from the file", async () => {
		const sid = nextSession();
		writeStore({
			version: 1,
			grants: [
				{ cmd: "git branch -D ancient", cwd: "/workspace", ts: Date.now() - 31 * DAY },
				{ cmd: "git branch -D current", cwd: "/workspace", ts: Date.now() - 1 * DAY },
			],
		});

		await prompted(`git branch -D newcomer-${sid}`, ALWAYS_ALLOW, sid);
		const store = readStore();
		expect(store.grants.map(grant => grant.cmd)).toEqual(["git branch -D current", `git branch -D newcomer-${sid}`]);
	});

	test("the kill-switch disables reads, writes, and the dialog option", async () => {
		const sid = nextSession();
		writeTestConfig({ persistentGrants: false });
		// A live grant sits in the store, yet must never answer.
		writeStore({ version: 1, grants: [{ cmd: `git branch -D switched-${sid}`, cwd: "/workspace", ts: Date.now() }] });

		const ctx = makeCtx({ sessionId: sid, hasUI: true });
		const result = await fire("tool_call", makeEvent(`git branch -D switched-${sid}`), ctx);
		expect(refusalOf(result).layer).toBe("dialog");
		expect(modelCalls.length).toBe(1);
		expect(selectCalls(ctx)[0][1].map(option => option.label)).toEqual([ALLOW_ONCE, ALLOW_SESSION, DENY]);

		// Approving the session-scoped option must NOT create a persistent store.
		await prompted(`git branch -D another-${sid}`, ALLOW_SESSION, sid);
		// ...so the store file still holds exactly the seeded entry, nothing more.
		expect(readStore().grants.map(grant => grant.cmd)).toEqual([`git branch -D switched-${sid}`]);
	});

	test("re-enabling the kill-switch makes stored grants apply again", async () => {
		const sid = nextSession();
		writeTestConfig({ persistentGrants: false });
		writeStore({ version: 1, grants: [{ cmd: `git branch -D rearm-${sid}`, cwd: "/workspace", ts: Date.now() }] });
		await fire("tool_call", makeEvent(`git branch -D rearm-${sid}`), makeCtx({ sessionId: sid, hasUI: true }));
		expect(modelCalls.length).toBe(1);

		writeTestConfig({ persistentGrants: true });
		const ctx = makeCtx({ sessionId: sid, hasUI: true });
		expect(await fire("tool_call", makeEvent(`git branch -D rearm-${sid}`), ctx)).toBeUndefined();
		expect(modelCalls.length).toBe(1);
	});

	test("/classifier persistentGrants toggles the key and the bare config shows it", async () => {
		const ctx = makeCtx({ sessionId: nextSession() });
		await fireCommand("classifier", "persistentGrants false", ctx);
		expect(JSON.parse(fs.readFileSync(path.join(dir, "omp-classifier.json"), "utf8"))).toMatchObject({ persistentGrants: false });
		await fireCommand("classifier", "persistentGrants true", ctx);
		expect(JSON.parse(fs.readFileSync(path.join(dir, "omp-classifier.json"), "utf8"))).toMatchObject({ persistentGrants: true });

		const showCtx = makeCtx({ sessionId: nextSession() });
		await fireCommand("classifier", "", showCtx);
		expect(notifyCalls(showCtx)[0][0]).toContain("persistentGrants: true");

		const badCtx = makeCtx({ sessionId: nextSession() });
		await fireCommand("classifier", "persistentGrants maybe", badCtx);
		expect(notifyCalls(badCtx)[0][1]).toBe("error");
	});

	test("a corrupt store reads as zero grants and is rebuilt by the next approval", async () => {
		const sid = nextSession();
		writeStore("{version: 1, grants: [broken");

		const ctx = makeCtx({ sessionId: sid, hasUI: true });
		const result = await fire("tool_call", makeEvent("git branch -D corrupt"), ctx);
		expect(refusalOf(result).layer).toBe("dialog"); // classified normally, no crash
		expect(modelCalls.length).toBe(1);

		const answerCtx = makeCtx({ sessionId: sid, hasUI: true, selectResult: ALWAYS_ALLOW });
		expect(resultText(await fire("tool_call", makeEvent("git branch -D corrupt"), answerCtx))).toBe("ALLOWED");
		const store = readStore();
		expect(store.version).toBe(1);
		expect(store.grants.map(grant => grant.cmd)).toEqual(["git branch -D corrupt"]);
	});

	test("a wrong-version store is ignored wholesale", async () => {
		const sid = nextSession();
		writeStore({ version: 2, grants: [{ cmd: "git branch -D v2", cwd: "/workspace", ts: Date.now() }] });
		const ctx = makeCtx({ sessionId: sid, hasUI: true });
		const result = await fire("tool_call", makeEvent("git branch -D v2"), ctx);
		expect(refusalOf(result).layer).toBe("dialog");
		expect(modelCalls.length).toBe(1);
	});

	test("the store caps at 500 entries, evicting the oldest", async () => {
		const sid = nextSession();
		const now = Date.now();
		const grants: GrantEntry[] = [];
		for (let i = 0; i < 500; i += 1) {
			grants.push({ cmd: `echo fillER-${i}`, cwd: "/workspace", ts: now - (500 - i) });
		}
		writeStore({ version: 1, grants });

		await prompted(`echo newcomer-${sid}`, ALWAYS_ALLOW, sid);
		const store = readStore();
		expect(store.grants).toHaveLength(500);
		expect(store.grants[0].cmd).toBe("echo fillER-1"); // fillER-0 was the oldest, evicted
		expect(store.grants[store.grants.length - 1].cmd).toBe(`echo newcomer-${sid}`);
	});

	test("re-approving refreshes the existing entry instead of stacking duplicates", async () => {
		const sid = nextSession();
		const command = `git branch -D twice-${sid}`;
		await prompted(command, ALWAYS_ALLOW, sid);
		const first = readStore().grants[0].ts;
		await prompted(command, ALWAYS_ALLOW, nextSession());
		const store = readStore();
		expect(store.grants).toHaveLength(1);
		expect(store.grants[0].ts).toBeGreaterThanOrEqual(first);
	});

	test("Allow once never touches the store", async () => {
		const sid = nextSession();
		const { result } = await prompted(`git branch -D once-${sid}`, ALLOW_ONCE, sid);
		expect(resultText(result)).toBe("ALLOWED");
		expect(fs.existsSync(grantsPath())).toBe(false);
	});

	test("the eval dialog never offers Always allow (bash-only this wave)", async () => {
		const sid = nextSession();
		const ctx = makeCtx({ sessionId: sid, hasUI: true, selectResult: ALLOW_ONCE });
		await fire("tool_call", { toolName: "eval", input: { code: "import subprocess\nsubprocess.run(['ls'])", language: "py" } }, ctx);
		expect(selectCalls(ctx)).toHaveLength(1);
		expect(selectCalls(ctx)[0][1].map(option => option.label)).toEqual([ALLOW_ONCE, ALLOW_SESSION, DENY]);
	});
});
