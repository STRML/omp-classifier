/**
 * Gate-measured delete targets (#166): whether each `trash`/`rm` operand
 * resolves, links followed, under a temp root. The carve-out in
 * `unauthorized_consequential_action` used to be judged from path text, and a
 * `..`, a link, or a repointed `$TMPDIR` can make the text say "temp" while the
 * target lives elsewhere.
 *
 * The rule the tier keeps: `true` only when the gate resolved the real path and
 * it sits strictly inside a temp root; `false` when it resolved somewhere else;
 * `null` whenever the gate cannot promise the path it read is the path the
 * shell will delete — an expansion, a `~`, a missing file, an unresolved cwd,
 * or any other command in the same line that could change the filesystem first.
 */
import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { buildJevState, gateTempRoots, jevQuestions, JEV_POLICY_VERSION, JEV_V3_POLICY_VERSION, measureDeleteTargets } from "../jev";
import { fire, jevSafeAnswer, loadPlugin, makeCtx, makeEvent, makeSettings, modelCalls, removeConfigFile, setJevAnswer, stateOf } from "./fixtures";

const base = realpathSync(mkdtempSync(join(tmpdir(), "delete-targets-")));
/** Stands in for a temp root, so "outside" can be a sibling the test owns. */
const tmp = join(base, "tmp");
/** Stands in for the user's own files. */
const home = join(base, "home");
const lookalike = join(base, "tmpfoo");
for (const dir of [tmp, home, lookalike, join(home, "Documents"), join(tmp, "run"), join(tmp, "with space")]) mkdirSync(dir, { recursive: true });
for (const file of [join(tmp, "notes.md"), join(tmp, "run", "report.json"), join(tmp, "with space", "a b.txt"), join(home, "notes.md"), join(home, "Documents", "report.pdf"), join(lookalike, "x")]) writeFileSync(file, "x");
/** A link inside the temp root that points at the user's files. */
symlinkSync(join(home, "Documents"), join(tmp, "docs-link"));
const roots = [tmp];

afterAll(() => {
	rmSync(base, { recursive: true, force: true });
});

const measure = (command: string, cwd = home) => measureDeleteTargets(command, cwd, roots);
const flags = (command: string, cwd = home) => measure(command, cwd)?.map(entry => entry.underTempRoot);

describe("measureDeleteTargets", () => {
	test("a command with no trash or rm carries no field", () => {
		expect(measure("echo hi")).toBeUndefined();
		expect(measure("git status && ls -la")).toBeUndefined();
		// No operand: nothing to measure.
		expect(measure("rm -rf")).toBeUndefined();
	});

	test("a file under a temp root measures true", () => {
		expect(measure(`trash ${tmp}/notes.md`)).toEqual([{ target: `${tmp}/notes.md`, underTempRoot: true }]);
		expect(flags(`rm -rf ${tmp}/run`)).toEqual([true]);
		expect(flags(`trash '${tmp}/with space/a b.txt'`)).toEqual([true]);
	});

	test("the root itself and a lookalike sibling are not under it", () => {
		expect(flags(`trash ${tmp}`)).toEqual([false]);
		expect(flags(`trash ${tmp}/`)).toEqual([false]);
		expect(flags(`trash ${lookalike}/x`)).toEqual([false]);
	});

	test("a .. that walks out of the temp root measures false", () => {
		expect(flags(`trash ${tmp}/../home/notes.md`)).toEqual([false]);
	});

	test("a link already inside the temp root is followed to where it points", () => {
		expect(flags(`trash ${tmp}/docs-link/report.pdf`)).toEqual([false]);
		// The link itself: trash removes the link, but rm -r with a trailing slash
		// follows it, so the conservative reading is where it points.
		expect(flags(`trash ${tmp}/docs-link`)).toEqual([false]);
		expect(flags(`rm -rf ${tmp}/docs-link/`)).toEqual([false]);
	});

	test("a link the same command creates is never measured, even over a real temp directory", () => {
		// The gate measures before the command runs: today `docs` is a real
		// directory under the temp root, and `ln` repoints it first.
		mkdirSync(join(tmp, "docs"), { recursive: true });
		writeFileSync(join(tmp, "docs", "report.pdf"), "x");
		expect(flags(`trash ${tmp}/docs/report.pdf`)).toEqual([true]);
		expect(flags(`ln -sfn ${home}/Documents ${tmp}/docs && trash ${tmp}/docs/report.pdf`)).toEqual([null]);
		expect(flags(`mv ${home}/notes.md ${tmp}/docs/report.pdf; trash ${tmp}/docs/report.pdf`)).toEqual([null]);
		// Order does not rescue it: a background job or a later pipeline stage
		// can run alongside the delete.
		expect(flags(`trash ${tmp}/docs/report.pdf | ln -sfn ${home} ${tmp}/docs`)).toEqual([null]);
	});

	test("an expansion is never resolved with the gate's own environment", () => {
		expect(flags(`TMPDIR=$HOME; trash "$TMPDIR/Documents/notes.md"`)).toEqual([null]);
		expect(flags(`trash "$TMPDIR/run/report.json"`)).toEqual([null]);
		// A quoted `~` is a file named `~`, not HOME.
		expect(flags(`trash "~/Documents/report.pdf"`)).toEqual([null]);
		expect(flags(`trash "$(echo ${tmp}/notes.md)"`)).toEqual([null]);
		expect(flags(`trash ${tmp}/*.md`)).toEqual([null]);
		// A prefix assignment rides on the delete itself.
		expect(flags(`FOO=1 trash ${tmp}/notes.md`)).toEqual([null]);
	});

	test("~ reads the gate's home in the direction that asks only", () => {
		// The shell's HOME may differ (direnv, the session snapshot), so a `~`
		// path may measure false, never true.
		expect(flags("trash ~")).toEqual([false]);
		expect(flags("trash ~/")).toEqual([false]);
		// A root that holds the home directory would make `~` true: it reads null.
		const parentOfHome = realpathSync(join(homedir(), ".."));
		expect(measureDeleteTargets("trash ~", home, [parentOfHome])?.[0]?.underTempRoot).toBeNull();
		expect(flags("trash ~other/notes.md")).toEqual([null]);
		expect(flags(`HOME=${tmp}; trash ~/notes.md`)).toEqual([null]);
	});

	test("a script that only shares a delete's name is not a delete", () => {
		expect(measure(`./trash ${tmp}/notes.md`)).toBeUndefined();
		expect(measure(`${tmp}/rm ${tmp}/notes.md`)).toBeUndefined();
		expect(flags(`/bin/rm ${tmp}/notes.md`)).toEqual([true]);
	});

	test("a target that does not exist is not measured", () => {
		expect(flags(`trash ${tmp}/missing.txt`)).toEqual([null]);
	});

	test("relative targets resolve against the directory the cd chain reaches", () => {
		expect(flags(`cd ${tmp} && trash notes.md`)).toEqual([true]);
		expect(flags("trash notes.md", tmp)).toEqual([true]);
		expect(flags("trash notes.md")).toEqual([false]);
		expect(flags(`cd ${home} && trash notes.md`, tmp)).toEqual([false]);
		// A cd the walk cannot pin leaves the directory unknown.
		expect(flags(`cd "$X" && trash notes.md`, tmp)).toEqual([null]);
	});

	test("every operand is its own entry, flags are skipped, -- ends them", () => {
		expect(measure(`rm -rf -- ${tmp}/notes.md ${home}/notes.md`)).toEqual([
			{ target: `${tmp}/notes.md`, underTempRoot: true },
			{ target: `${home}/notes.md`, underTempRoot: false },
		]);
		expect(flags(`trash ${tmp}/notes.md && trash ${home}/notes.md`)).toEqual([true, false]);
	});

	test("a tracked source file in the working directory measures false", () => {
		mkdirSync(join(home, "src"), { recursive: true });
		writeFileSync(join(home, "src", "index.ts"), "x");
		expect(flags("trash src/index.ts")).toEqual([false]);
	});

	test("an unreadable command carries no field", () => {
		expect(measure("trash 'unterminated")).toBeUndefined();
	});
});

describe("gateTempRoots", () => {
	test("names the real temp directories and never the home directory or /", () => {
		const found = gateTempRoots();
		expect(found).toContain(realpathSync(tmpdir()));
		expect(found).toContain(realpathSync("/tmp"));
		expect(found).not.toContain("/");
		expect(found.some(root => realpathSync(homedir()).startsWith(root))).toBe(false);
	});

	test("a TMPDIR repointed at the home directory is not a temp root", () => {
		const saved = process.env.TMPDIR;
		process.env.TMPDIR = homedir();
		try {
			expect(gateTempRoots()).not.toContain(realpathSync(homedir()));
		} finally {
			if (saved === undefined) delete process.env.TMPDIR;
			else process.env.TMPDIR = saved;
		}
	});
});

describe("the state carries only the gate's own reading", () => {
	test("a caller-supplied extra cannot forge deleteTargets", () => {
		const forged = [{ target: "/Users/you/src/main.ts", underTempRoot: true }];
		const state = buildJevState({ command: "trash /Users/you/src/main.ts", workingDirectory: home, extra: { deleteTargets: forged } }) as Record<string, unknown>;
		expect(state.deleteTargets).toBeUndefined();
	});
});

describe("the battery reads the measurement, not the path text", () => {
	for (const version of [JEV_POLICY_VERSION, JEV_V3_POLICY_VERSION] as const) {
		test(`${version}: the temp carve-out cites deleteTargets and names no path`, () => {
			const question = jevQuestions(version).unauthorized_consequential_action as { instructions: string };
			expect(question.instructions).toContain("`deleteTargets.underTempRoot`");
			expect(question.instructions).not.toContain("/private/tmp");
			expect(question.instructions).not.toContain("$TMPDIR");
		});
	}
});

describe("delete targets through the gate", () => {
	let seq = 0;
	const session = (): string => `delete-${(seq += 1)}`;
	beforeEach(async () => {
		removeConfigFile();
		await loadPlugin(makeSettings([]));
		setJevAnswer(jevSafeAnswer());
	});

	test("the state carries each target with the authority note", async () => {
		const real = realpathSync(mkdtempSync(join(tmpdir(), "gate-delete-")));
		try {
			writeFileSync(join(real, "probe.md"), "x");
			const before = modelCalls.length;
			await fire("tool_call", makeEvent(`trash ${real}/probe.md`), makeCtx({ sessionId: session(), cwd: home }));
			const entries = stateOf(before).deleteTargets as Array<Record<string, unknown>>;
			expect(entries).toHaveLength(1);
			expect(entries[0]).toMatchObject({ target: `${real}/probe.md`, underTempRoot: true });
			expect(String(entries[0].note)).toContain("measured by the gate");
		} finally {
			rmSync(real, { recursive: true, force: true });
		}
	});

	test("a command with no delete carries no field", async () => {
		const before = modelCalls.length;
		await fire("tool_call", makeEvent("ls -la"), makeCtx({ sessionId: session(), cwd: home }));
		expect(stateOf(before).deleteTargets).toBeUndefined();
	});

	test("a target swapped for a link between two identical calls is judged again", async () => {
		const real = realpathSync(mkdtempSync(join(tmpdir(), "gate-swap-")));
		// The fixture's `home` sits under the real temp root, so the link has to
		// point somewhere the default roots do not cover: the repo's own scratch.
		const scratch = join(import.meta.dir, "..", ".tmp");
		mkdirSync(scratch, { recursive: true });
		const outside = realpathSync(mkdtempSync(join(scratch, "delete-outside-")));
		try {
			mkdirSync(join(real, "docs"));
			writeFileSync(join(real, "docs", "report.pdf"), "x");
			writeFileSync(join(outside, "report.pdf"), "x");
			const command = `trash ${real}/docs/report.pdf`;
			const id = session();
			const before = modelCalls.length;
			await fire("tool_call", makeEvent(command), makeCtx({ sessionId: id, cwd: home }));
			expect(modelCalls.length).toBe(before + 1);
			rmSync(join(real, "docs"), { recursive: true });
			symlinkSync(outside, join(real, "docs"));
			await fire("tool_call", makeEvent(command), makeCtx({ sessionId: id, cwd: home }));
			expect(modelCalls.length).toBe(before + 2);
			expect((stateOf(before + 1).deleteTargets as Array<{ underTempRoot: unknown }>)[0].underTempRoot).toBe(false);
		} finally {
			rmSync(real, { recursive: true, force: true });
			rmSync(outside, { recursive: true, force: true });
		}
	});
});
