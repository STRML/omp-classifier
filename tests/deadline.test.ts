/**
 * The judgment deadline (https://github.com/STRML/omp-classifier/issues/184).
 *
 * The gate waits for the verdict up to `timeoutMs`, then aborts the request and
 * treats the call as unavailable. Nothing is kept listening behind the
 * deadline: an answer that would have landed later is never read, and no
 * `late-verdict` line is written.
 *
 * Driven by fake timers. The gate awaits real I/O (the lockfile read) on its
 * way to the judge, so `until()` yields to the real event loop between
 * advances.
 */
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, jest, test } from "bun:test";
import type { DecisionRecord } from "../index";
import {
	fire,
	jevSafeAnswer,
	loadPlugin,
	makeCtx,
	makeEvent,
	makeSettings,
	modelCalls,
	notifyCalls,
	refusalOf,
	resultText,
	removeConfigFile,
	setJevAnswer,
	setJevDelay,
	signalOf,
	useTempConfigFile,
} from "./fixtures";

const realImmediate = globalThis.setImmediate;
const realNow = performance.now.bind(performance);

const DEADLINE_MS = 20;
const LATE_ANSWER_MS = 45;

let dir = "";
let seq = 0;
let lastConfigMtimeMs = 0;

function readDecisions(): DecisionRecord[] {
	try {
		return fs
			.readFileSync(path.join(dir, "decisions.jsonl"), "utf8")
			.split("\n")
			.filter(line => line.trim() !== "")
			.map(line => JSON.parse(line) as DecisionRecord);
	} catch {
		return [];
	}
}

function writeConfig(raw: Record<string, unknown>): void {
	const target = process.env.OMP_JEV_CONFIG;
	if (target === undefined) throw new Error("OMP_JEV_CONFIG was not pointed at this test's dir");
	fs.writeFileSync(target, JSON.stringify(raw));
	const mtimeMs = Math.max(Date.now(), lastConfigMtimeMs + 1);
	fs.utimesSync(target, mtimeMs / 1000, mtimeMs / 1000);
	lastConfigMtimeMs = mtimeMs;
}

async function until(ready: () => boolean, timeoutMs = 10_000): Promise<void> {
	const deadline = realNow() + timeoutMs;
	while (!ready()) {
		if (realNow() > deadline) throw new Error(`until: the condition did not hold within ${timeoutMs} ms`);
		await new Promise<void>(resolve => realImmediate(resolve));
	}
}

async function settle(turns = 20): Promise<void> {
	for (let turn = 0; turn < turns; turn += 1) await new Promise<void>(resolve => realImmediate(resolve));
}

/** Track every timer armed while `body` runs and whether a clear reached it. */
async function withTimerRecord(body: (armed: Array<{ handle: unknown; ms: number | undefined; cleared: boolean }>) => Promise<void>): Promise<void> {
	const armed: Array<{ handle: unknown; ms: number | undefined; cleared: boolean }> = [];
	const fakeSetTimeout = globalThis.setTimeout;
	const fakeClearTimeout = globalThis.clearTimeout;
	globalThis.setTimeout = ((callback: () => void, ms?: number) => {
		const handle: unknown = fakeSetTimeout(callback, ms);
		armed.push({ handle, ms, cleared: false });
		return handle;
	}) as typeof setTimeout;
	globalThis.clearTimeout = ((handle?: number) => {
		for (const entry of armed) {
			if (entry.handle === handle) entry.cleared = true;
		}
		fakeClearTimeout(handle);
	}) as typeof clearTimeout;
	try {
		await body(armed);
	} finally {
		globalThis.setTimeout = fakeSetTimeout;
		globalThis.clearTimeout = fakeClearTimeout;
	}
}

beforeEach(() => {
	removeConfigFile();
	dir = fs.mkdtempSync(path.join(os.tmpdir(), "omp-deadline-"));
	process.env.OMP_JEV_CONFIG = path.join(dir, "omp-classifier.json");
});

afterEach(() => {
	jest.useRealTimers();
	process.env.OMP_JEV_CONFIG = useTempConfigFile();
	fs.rmSync(dir, { recursive: true, force: true });
});

describe("the judgment deadline", () => {
	test("the deadline aborts the request, and an answer behind it is never read", async () => {
		seq += 1;
		writeConfig({ timeoutMs: DEADLINE_MS });
		jest.useFakeTimers();
		await loadPlugin(makeSettings([]));
		setJevDelay(LATE_ANSWER_MS);
		setJevAnswer(jevSafeAnswer());
		const ctx = makeCtx({ sessionId: `deadline-${seq}`, hasUI: true, selectResult: "Deny" });
		// Whether the request was still running when the dialog opened.
		let abortedWhenAsked: boolean | undefined;
		const ui = ctx.ui as unknown as { select: (...args: unknown[]) => Promise<string | undefined> };
		const select = ui.select;
		ui.select = (...args: unknown[]) => {
			abortedWhenAsked = signalOf()?.aborted;
			return select(...args);
		};
		const tool = fire("tool_call", makeEvent(`git status --deadline-${seq}`), ctx);
		await until(() => modelCalls.length > 0);
		jest.advanceTimersByTime(DEADLINE_MS + 5);
		const result = await tool;

		expect(abortedWhenAsked).toBe(true);
		expect(signalOf()?.aborted).toBe(true);
		expect(refusalOf(resultText(result)).why).toContain(`timed out after ${DEADLINE_MS}ms`);

		// Past the moment the fixture judge would have answered: nothing moves.
		jest.advanceTimersByTime(LATE_ANSWER_MS);
		await settle();
		const layers = readDecisions().map(line => line.layer);
		expect(layers).not.toContain("late-verdict");
		expect(readDecisions().filter(line => line.decision === "allow")).toHaveLength(0);
		expect(notifyCalls(ctx)).toHaveLength(0);
	});

	test("a verdict inside the deadline clears the deadline timer", async () => {
		seq += 1;
		writeConfig({ timeoutMs: 5_000 });
		jest.useFakeTimers();
		await loadPlugin(makeSettings([]));
		setJevDelay(5);
		setJevAnswer(jevSafeAnswer());
		await withTimerRecord(async armed => {
			const tool = fire("tool_call", makeEvent(`git status --in-time-${seq}`), makeCtx({ sessionId: `in-time-${seq}` }));
			await until(() => modelCalls.length > 0);
			jest.advanceTimersByTime(10);
			expect(await tool).toBeUndefined();
			const deadlineTimer = armed.find(entry => entry.ms === 5_000);
			expect(deadlineTimer).toBeDefined();
			expect(deadlineTimer?.cleared).toBe(true);
		});
		expect(signalOf()?.aborted).toBe(false);
	});

	test("no timer outlives a deadline", async () => {
		seq += 1;
		writeConfig({ timeoutMs: DEADLINE_MS });
		jest.useFakeTimers();
		await loadPlugin(makeSettings([]));
		setJevDelay(LATE_ANSWER_MS);
		setJevAnswer(jevSafeAnswer());
		await withTimerRecord(async armed => {
			const tool = fire("tool_call", makeEvent(`git status --no-window-${seq}`), makeCtx({ sessionId: `no-window-${seq}` }));
			await until(() => modelCalls.length > 0);
			jest.advanceTimersByTime(DEADLINE_MS + 5);
			await tool;
			// The gate arms the deadline and nothing after it: no listen window.
			expect(armed.filter(entry => entry.ms !== undefined && entry.ms > DEADLINE_MS && entry.ms !== LATE_ANSWER_MS)).toHaveLength(0);
		});
	});
});
