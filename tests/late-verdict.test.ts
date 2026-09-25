/**
 * A judgment that answers after its deadline (issue #62).
 *
 * The deadline is the gate's own, so missing it opens a permission dialog
 * immediately — but the request is kept alive for `min(2 x timeoutMs, 30s)`
 * past the deadline, and the verdict that lands inside that window still gets
 * to say something about the dialog the human is reading: a late SAFE dismisses
 * it, a late UNSAFE backs it with a real reason, a late UNSURE goes on the
 * record. A human who answers first ends the race: the request is cancelled and
 * the late answer has no side effect at all. An answer that misses the window
 * too is dead — the dialog simply stays.
 *
 * Everything here is driven by fake timers, never by sleeping on real ones: the
 * deadline, the fixture judge's answer delay and the listen window are all
 * `setTimeout`s, so the test owns exactly when each one fires. The gate also
 * awaits real I/O (the lockfile read) on its way to the dialog, so `until()`
 * yields to the real event loop between advances — a microtask-only flush would
 * never let that callback run.
 *
 * The clock is the subject, so the numbers are picked to be unambiguous: a 20ms
 * deadline (window closes at 60ms), an answer 25ms after the deadline (45ms), and
 * an answer far outside the window (5s) for the cap.
 */
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, jest, test } from "bun:test";
import type { ExtensionContext } from "@oh-my-pi/pi-coding-agent";
import {
	ALLOW_ONCE,
	DENY,
	type JevFixtureAnswers,
	dialogText,
	fire,
	jevSafeAnswer,
	jevUnsureAnswer,
	jevUnsafeAnswer,
	loadPlugin,
	makeCtx,
	makeEvent,
	makeSettings,
	modelCalls,
	notifyCalls,
	refusalOf,
	removeConfigFile,
	resultText,
	selectCalls,
	setJevAnswer,
	setJevAnswers,
	setJevDelay,
	signalOf,
	useTempConfigFile,
} from "./fixtures";
import type { DecisionRecord } from "../index";

/** The real macrotask hop, captured before any test fakes the timers: it is the
 *  only way to let pending I/O callbacks run while `setTimeout` is frozen. */
const realImmediate = globalThis.setImmediate;

/** The gate's deadline for every run in this file, and the two moments that
 *  matter against it: the answer's delay, and the end of the listen window. */
const DEADLINE_MS = 20;
const LATE_ANSWER_MS = 45;
const WINDOW_CLOSES_MS = DEADLINE_MS + 2 * DEADLINE_MS;

let dir = "";
let seq = 0;
/** The same monotonic bump the fixture's writer uses: the plugin's config cache
 *  is keyed on mtimeMs, and a coarse filesystem can stamp two writes alike. */
let lastConfigMtimeMs = 0;

const decisionsPath = (): string => path.join(dir, "decisions.jsonl");

/** The log so far; no file yet reads as no lines, which is what a poll wants. */
function readDecisions(): DecisionRecord[] {
	try {
		return fs
			.readFileSync(decisionsPath(), "utf8")
			.split("\n")
			.filter(line => line.trim() !== "")
			.map(line => JSON.parse(line) as DecisionRecord);
	} catch {
		return [];
	}
}

const lateLines = (): DecisionRecord[] => readDecisions().filter(line => line.layer === "late-verdict");

/** This test's config, written at THIS test's path. The fixture's
 *  `writeConfigFile` repoints OMP_JEV_CONFIG at the suite's shared dir, which
 *  would send decisions.jsonl there too — and these tests assert on a log of
 *  their own. */
function writeConfig(raw: Record<string, unknown>): void {
	const target = process.env.OMP_JEV_CONFIG;
	if (target === undefined) throw new Error("OMP_JEV_CONFIG was not pointed at this test's dir");
	fs.writeFileSync(target, JSON.stringify(raw));
	const mtimeMs = Math.max(Date.now(), lastConfigMtimeMs + 1);
	fs.utimesSync(target, mtimeMs / 1000, mtimeMs / 1000);
	lastConfigMtimeMs = mtimeMs;
}

/** Yield to the real event loop until `ready` holds (or the bound runs out). */
async function until(ready: () => boolean, turns = 400): Promise<void> {
	for (let turn = 0; turn < turns && !ready(); turn += 1) {
		await new Promise<void>(resolve => realImmediate(resolve));
	}
}

interface DeferredDialog {
	ctx: ExtensionContext;
	/** How many dialogs were presented. */
	opened: () => number;
	/** "idle" until presented; "open" while the human could still answer;
	 *  "dismissed" when the gate aborted it; "answered" when the test did. */
	state: () => "idle" | "open" | "dismissed" | "answered";
	/** Answer the open dialog the way a click does. */
	answer: (label: string) => void;
}

/**
 * A ctx whose dialog stays open until the test answers it or the gate dismisses
 * it, which is the whole subject of this file. The fake host honors
 * `dialogOptions.signal` exactly as extension-ui-controller.ts does: aborting
 * hides the dialog and resolves `undefined`, and an already-aborted signal
 * never presents one.
 */
function deferredCtx(sessionId: string): DeferredDialog {
	const ctx = makeCtx({ sessionId, hasUI: true });
	const calls = selectCalls(ctx);
	let presented = 0;
	let state: "idle" | "open" | "dismissed" | "answered" = "idle";
	let answer = (value: string | undefined): void => {
		void value;
	};
	const ui = ctx.ui as unknown as {
		select: (
			title: string,
			items: Array<{ label: string; description?: string }>,
			dialogOptions?: { signal?: AbortSignal },
		) => Promise<string | undefined>;
	};
	ui.select = (title, items, dialogOptions) => {
		presented += 1;
		// The same two arguments the plugin passed, in the shape dialogText reads.
		calls.push([title, items]);
		state = "open";
		const { promise, resolve } = Promise.withResolvers<string | undefined>();
		answer = value => {
			state = "answered";
			resolve(value);
		};
		const signal = dialogOptions?.signal;
		if (signal?.aborted) {
			state = "dismissed";
			return Promise.resolve(undefined);
		}
		signal?.addEventListener(
			"abort",
			() => {
				state = "dismissed";
				resolve(undefined);
			},
			{ once: true },
		);
		return promise;
	};
	return {
		ctx,
		opened: () => presented,
		state: () => state,
		answer: label => answer(label),
	};
}

interface LateRun {
	dialog: DeferredDialog;
	tool: Promise<unknown>;
}

/** Start a run whose judgment cannot answer inside the deadline. `payload` is
 *  the bash command, or the code cell of an `eval` run. `answerMs` is the
 *  fixture judge's delay, so the caller decides whether the answer lands inside
 *  the listen window (`LATE_ANSWER_MS`) or outside it (5s). Returns at the
 *  point the deadline has fired: the dialog is up, the answer is still owed,
 *  and the listen window is open. */
async function timeoutRun(
	payload: string,
	sessionId: string,
	answers: JevFixtureAnswers[],
	answerMs: number,
	toolName: "bash" | "eval" = "bash",
): Promise<LateRun> {
	writeConfig({ timeoutMs: DEADLINE_MS });
	jest.useFakeTimers();
	await loadPlugin(makeSettings([]));
	// After loadPlugin, which resets every stub knob.
	setJevDelay(answerMs);
	setJevAnswers(answers);
	const dialog = deferredCtx(sessionId);
	const event = toolName === "eval" ? { toolName, input: { code: payload, language: "js" } } : makeEvent(payload);
	const tool = fire("tool_call", event, dialog.ctx);
	await until(() => modelCalls.length > 0);
	jest.advanceTimersByTime(DEADLINE_MS + 5);
	await until(() => dialog.opened() > 0);
	// The precondition every test below rests on: the deadline opened the dialog
	// and the request it was waiting on is STILL RUNNING. Before issue #62 the
	// deadline's own signal had aborted it by now, which is exactly why the late
	// answer could never be used.
	expect(signalOf()?.aborted).toBe(false);
	return { dialog, tool };
}

beforeEach(() => {
	removeConfigFile();
	dir = fs.mkdtempSync(path.join(os.tmpdir(), "omp-late-"));
	// After removeConfigFile, which repoints the env at the suite's shared
	// config file — the decisions path follows the env, so this has to be last.
	process.env.OMP_JEV_CONFIG = path.join(dir, "omp-classifier.json");
});

afterEach(() => {
	jest.useRealTimers();
	// Restore the shared suite config path so later test files never see this
	// dir, then remove it.
	process.env.OMP_JEV_CONFIG = useTempConfigFile();
	fs.rmSync(dir, { recursive: true, force: true });
});

describe("a judgment that answers after its deadline (issue #62)", () => {
	test("late SAFE dismisses the dialog and the command runs", async () => {
		seq += 1;
		const { dialog, tool } = await timeoutRun(`git status --late-safe-${seq}`, `late-safe-${seq}`, [jevSafeAnswer()], LATE_ANSWER_MS);

		// The deadline opened the dialog and stated what is actually happening.
		expect(dialog.state()).toBe("open");
		expect(dialogText(dialog.ctx)).toContain("classifier unavailable");
		expect(dialogText(dialog.ctx)).toContain("judgment timed out after 20ms");
		expect(dialogText(dialog.ctx)).toContain("it may dismiss this dialog before you answer it");
		expect(lateLines()).toHaveLength(0);

		// The answer lands inside the window, the dialog dismisses itself, and
		// the command runs on the judgment the deadline interrupted.
		jest.advanceTimersByTime(20);
		await until(() => dialog.state() === "dismissed");
		expect(dialog.state()).toBe("dismissed");
		expect(await tool).toBeUndefined();

		const lines = readDecisions();
		expect(lines).toHaveLength(2);
		expect(lines[0]).toMatchObject({ decision: "block", layer: "verdict", verdict: "UNAVAILABLE" });
		expect(lines[0].why).toContain("judgment timed out after 20ms");
		expect(lines[1]).toMatchObject({
			decision: "allow",
			layer: "late-verdict",
			verdict: "SAFE",
			why: "unavailable → late SAFE: dialog dismissed, command allowed",
			cached: 0,
		});
		// The late line carries the judgment it dismissed on, exactly as an
		// on-time allow line would: same reason code, same telemetry.
		expect(lines[1].reasonCode).toBe("jev:safe");
		expect(lines[1].jev?.probabilities?.safe).toBeGreaterThan(0.9);
	});

	test("late UNSAFE keeps the dialog open with the real reason, and an allow stands", async () => {
		seq += 1;
		const { dialog, tool } = await timeoutRun(
			`git push --force origin late-unsafe-${seq}`,
			`late-unsafe-${seq}`,
			[jevUnsafeAnswer()],
			LATE_ANSWER_MS,
		);

		jest.advanceTimersByTime(20);
		await until(() => lateLines().length > 0);

		// Kept open: the human still owns the decision, now with the reason.
		expect(dialog.state()).toBe("open");
		expect(notifyCalls(dialog.ctx)).toHaveLength(1);
		expect(notifyCalls(dialog.ctx)[0][1]).toBe("warning");
		expect(notifyCalls(dialog.ctx)[0][0]).toContain("judgment answered late");
		expect(notifyCalls(dialog.ctx)[0][0]).toContain("unsafe 0.96");

		// The human allows what the refined dialog described: it runs, and the
		// late answer is recorded next to their choice, never as a re-block.
		dialog.answer(ALLOW_ONCE);
		expect(await tool).toBeUndefined();

		const lines = readDecisions();
		expect(lines.map(line => line.layer)).toEqual(["verdict", "late-verdict", "dialog"]);
		expect(lines[1]).toMatchObject({
			decision: "block",
			layer: "late-verdict",
			verdict: "UNSAFE",
			why: "unavailable → late UNSAFE: dialog kept open with the judgment's reason",
		});
		expect(lines[2]).toMatchObject({ decision: "allow", layer: "dialog", approval: "allow-once" });
		expect(lines[2].why).toBe("approved by user (unavailable → late UNSAFE)");
	});

	test("late UNSURE leaves the dialog alone and records the answer", async () => {
		seq += 1;
		const { dialog, tool } = await timeoutRun(`git status --late-unsure-${seq}`, `late-unsure-${seq}`, [jevUnsureAnswer()], LATE_ANSWER_MS);

		jest.advanceTimersByTime(20);
		await until(() => lateLines().length > 0);

		// Nothing changes for the human: no dismissal, no warning, one record.
		expect(dialog.state()).toBe("open");
		expect(notifyCalls(dialog.ctx)).toHaveLength(0);
		expect(dialogText(dialog.ctx)).toContain("classifier unavailable");

		dialog.answer(DENY);
		const blocked = await tool;
		expect(refusalOf(resultText(blocked)).layer).toBe("dialog");

		const lines = readDecisions();
		expect(lines.map(line => line.layer)).toEqual(["verdict", "late-verdict", "dialog"]);
		expect(lines[1]).toMatchObject({
			decision: "block",
			layer: "late-verdict",
			verdict: "UNSURE",
			why: "unavailable → late UNSURE: answer attached to this dialog's record",
		});
		expect(lines[2]).toMatchObject({ decision: "block", layer: "dialog", approval: "deny" });
		expect(lines[2].why).toContain("(unavailable → late UNSURE)");
	});

	test("the human answering first cancels the request and the late answer does nothing", async () => {
		seq += 1;
		const { dialog, tool } = await timeoutRun(`git status --late-human-${seq}`, `late-human-${seq}`, [jevUnsafeAnswer()], LATE_ANSWER_MS);

		dialog.answer(ALLOW_ONCE);
		expect(await tool).toBeUndefined();
		// Cancelled on the way out: the request that still owed an answer is
		// aborted rather than left running for the rest of the window.
		expect(signalOf()?.aborted).toBe(true);

		// Nothing is left listening: the answer that was 45ms away has no dialog
		// to refine and no line to write.
		jest.advanceTimersByTime(10_000);
		await until(() => false, 20);
		expect(readDecisions().map(line => line.layer)).toEqual(["verdict", "dialog"]);
		expect(notifyCalls(dialog.ctx)).toHaveLength(0);
	});

	test("an answer that misses the listen window is dropped and the dialog stays", async () => {
		seq += 1;
		const { dialog, tool } = await timeoutRun(`git status --late-cap-${seq}`, `late-cap-${seq}`, [jevSafeAnswer()], 5_000);

		// The window closes at deadline + 2 x timeoutMs: the request is aborted,
		// and a SAFE that never made it inside cannot dismiss anything.
		jest.advanceTimersByTime(WINDOW_CLOSES_MS);
		await until(() => signalOf()?.aborted === true);
		expect(signalOf()?.aborted).toBe(true);
		expect(dialog.state()).toBe("open");
		expect(lateLines()).toHaveLength(0);

		// The answer arrives long after, to nobody: the dialog is still the
		// human's, and the only verdict on record is UNAVAILABLE.
		jest.advanceTimersByTime(10_000);
		await until(() => false, 20);
		expect(lateLines()).toHaveLength(0);
		expect(dialog.state()).toBe("open");

		dialog.answer(DENY);
		expect(refusalOf(resultText(await tool)).layer).toBe("dialog");
		expect(readDecisions().map(line => line.layer)).toEqual(["verdict", "dialog"]);
	});

	test("a late SAFE cannot dismiss a dialog the on-time path would still ask about", async () => {
		seq += 1;
		// A recursive rm is flagged by the moderate-risk overlay, not by the
		// builtin critical list: an on-time SAFE on it still raises the dialog
		// ("flagged for approval"), so a late SAFE must not wave it through.
		const command = `rm -rf ./late-flag-${seq}`;
		const { dialog, tool } = await timeoutRun(command, `late-guard-${seq}`, [jevSafeAnswer()], LATE_ANSWER_MS);

		jest.advanceTimersByTime(20);
		await until(() => lateLines().length > 0);

		expect(dialog.state()).toBe("open");
		expect(lateLines()[0]).toMatchObject({
			decision: "block",
			layer: "late-verdict",
			verdict: "SAFE",
			why: 'unavailable → late SAFE: dialog kept open — classifier-safe but flags: rm',
		});
		expect(notifyCalls(dialog.ctx)).toHaveLength(1);
		expect(notifyCalls(dialog.ctx)[0][1]).toBe("warning");

		// The human still decides, and their allow is the allow.
		dialog.answer(ALLOW_ONCE);
		expect(await tool).toBeUndefined();
		const lines = readDecisions();
		expect(lines.map(line => line.layer)).toEqual(["verdict", "late-verdict", "dialog"]);
		expect(lines[2].why).toBe("approved by user (unavailable → late SAFE)");
	});

	test("a late SAFE cannot dismiss a dialog for a target this session refused", async () => {
		seq += 1;
		const sessionId = `late-refusal-${seq}`;
		const command = `git branch -D late-refusal-${seq}`;
		// First run: the deadline opens the dialog and the human denies, which is
		// what puts the target in this session's refusal memory.
		const first = await timeoutRun(command, sessionId, [jevUnsureAnswer()], LATE_ANSWER_MS);
		first.dialog.answer(DENY);
		expect(refusalOf(resultText(await first.tool)).layer).toBe("dialog");
		jest.useRealTimers();

		// Second run on the SAME command and session, this time with a SAFE that
		// lands late: the refusal rode into the judge state, so an on-time SAFE
		// would still have asked ("classifier-safe despite prior refusal").
		const second = await timeoutRun(command, sessionId, [jevSafeAnswer()], LATE_ANSWER_MS);
		jest.advanceTimersByTime(20);
		await until(() => lateLines().length > 0);

		expect(second.dialog.state()).toBe("open");
		const guardLine = lateLines().at(-1);
		expect(guardLine).toMatchObject({ decision: "block", layer: "late-verdict", verdict: "SAFE" });
		// The refusal's own normalized target, not the text as typed: the store
		// normalizes `git branch -D x` to its target.
		expect(guardLine?.why).toContain("dialog kept open — classifier-safe despite prior refusal of");
		expect(guardLine?.why).toContain(`late-refusal-${seq}"`);

		second.dialog.answer(DENY);
		expect(refusalOf(resultText(await second.tool)).layer).toBe("dialog");
	});

	test("a verdict inside the deadline opens no dialog and arms no race", async () => {
		seq += 1;
		writeConfig({ timeoutMs: 5_000 });
		setJevAnswer(jevSafeAnswer());
		setJevDelay(5);
		jest.useFakeTimers();
		await loadPlugin(makeSettings([]));
		const dialog = deferredCtx(`late-in-time-${seq}`);
		const tool = fire("tool_call", makeEvent(`git status --late-in-time-${seq}`), dialog.ctx);
		await until(() => modelCalls.length > 0);
		jest.advanceTimersByTime(10);

		expect(await tool).toBeUndefined();
		expect(dialog.opened()).toBe(0);
		expect(signalOf()?.aborted).toBe(false);
		expect(readDecisions().map(line => line.layer)).toEqual(["verdict"]);
	});

	test("a late verdict on an eval payload carries the payload's spawn directory", async () => {
		seq += 1;
		const code = `const cp = require("child_process");\ncp.exec("rm -rf .", { cwd: "/tmp/late-spawn" });`;
		const { dialog, tool } = await timeoutRun(code, `late-eval-${seq}`, [jevUnsafeAnswer()], LATE_ANSWER_MS, "eval");

		jest.advanceTimersByTime(20);
		await until(() => lateLines().length > 0);

		// The late line is this dialog's record of the answer that arrived
		// behind the deadline, and the verdict line above it already says which
		// directory the payload declared. A late line without it makes the pair
		// disagree about the directory the gate judged, which is exactly what an
		// audit reader reads them for.
		const lines = readDecisions();
		expect(lines.map(line => line.layer)).toEqual(["verdict", "late-verdict"]);
		expect(lines[0]).toMatchObject({
			decision: "block",
			layer: "verdict",
			verdict: "UNAVAILABLE",
			cwd: "/tmp/late-spawn",
			spawnCwd: "/tmp/late-spawn",
		});
		expect(lines[1]).toMatchObject({
			decision: "block",
			layer: "late-verdict",
			verdict: "UNSAFE",
			cwd: "/tmp/late-spawn",
			spawnCwd: "/tmp/late-spawn",
		});

		dialog.answer(DENY);
		expect(refusalOf(resultText(await tool)).layer).toBe("dialog");
	});

	test("a canceled late judgment disarms the listen window's timer", async () => {
		seq += 1;
		const sessionId = `late-window-${seq}`;
		writeConfig({ timeoutMs: DEADLINE_MS });
		jest.useFakeTimers();
		await loadPlugin(makeSettings([]));
		setJevDelay(LATE_ANSWER_MS);
		setJevAnswers([jevUnsafeAnswer()]);
		// Installed after the fake timers, so calls still reach the clock this
		// file drives; the wrapper only remembers the handles and whether a
		// clear ever reached one. The listen window is armed at the deadline for
		// `min(2 x timeoutMs, 30s)`, and it is a resource the gate owns: a cancel
		// that leaves it armed keeps the process's event loop busy for the rest
		// of the window with nothing left to say.
		const armed: Array<{ handle: unknown; cleared: boolean }> = [];
		const fakeSetTimeout = globalThis.setTimeout;
		const fakeClearTimeout = globalThis.clearTimeout;
		globalThis.setTimeout = ((callback: () => void, ms?: number) => {
			const handle: unknown = fakeSetTimeout(callback, ms);
			armed.push({ handle, cleared: false });
			return handle;
		}) as typeof setTimeout;
		globalThis.clearTimeout = ((handle?: number) => {
			for (const entry of armed) {
				if (entry.handle === handle) entry.cleared = true;
			}
			fakeClearTimeout(handle);
		}) as typeof clearTimeout;
		try {
			const dialog = deferredCtx(sessionId);
			const tool = fire("tool_call", makeEvent(`git status --late-window-${seq}`), dialog.ctx);
			await until(() => modelCalls.length > 0);
			jest.advanceTimersByTime(DEADLINE_MS + 5);
			await until(() => dialog.opened() > 0);
			const windowTimer = armed.at(-1);
			expect(windowTimer).toBeDefined();

			dialog.answer(ALLOW_ONCE);
			expect(await tool).toBeUndefined();
			expect(windowTimer?.cleared).toBe(true);
		} finally {
			globalThis.setTimeout = fakeSetTimeout;
			globalThis.clearTimeout = fakeClearTimeout;
		}
	});
});
