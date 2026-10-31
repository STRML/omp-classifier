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
import { chmodSync, mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { buildJevState, gateTempRoots, jevQuestions, JEV_POLICY_VERSION, JEV_V3_POLICY_VERSION, measureDeleteTargets } from "../jev";
import { shellTmpdirFor, touchesShellEnv } from "../index";
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
		// Without a shell TMPDIR the caller vouches for, `$TMPDIR` stays unread.
		expect(flags(`trash "$TMPDIR/run/report.json"`)).toEqual([null]);
		// A quoted `~` is a file named `~`, not HOME.
		expect(flags(`trash "~/Documents/report.pdf"`)).toEqual([null]);
		expect(flags(`trash "$(echo ${tmp}/notes.md)"`)).toEqual([null]);
		expect(flags(`trash ${tmp}/*.md`)).toEqual([null]);
		// A prefix assignment rides on the delete itself.
		expect(flags(`FOO=1 trash ${tmp}/notes.md`)).toEqual([null]);
	});

	describe("$TMPDIR read with the shell's own value (#176)", () => {
		const withShell = (command: string, shellTmpdir: string | null = tmp, cwd = home) => measureDeleteTargets(command, cwd, roots, shellTmpdir)?.map(entry => entry.underTempRoot);

		test("a file under the shell's TMPDIR measures true, in each spelling", () => {
			expect(measureDeleteTargets(`trash "$TMPDIR/run/report.json"`, home, roots, tmp)).toEqual([{ target: "$TMPDIR/run/report.json", underTempRoot: true }]);
			expect(withShell(`trash "\${TMPDIR}/run/report.json"`)).toEqual([true]);
			expect(withShell("trash $TMPDIR/run/report.json")).toEqual([true]);
			expect(withShell("rm -rf $TMPDIR/run")).toEqual([true]);
			// A trailing slash on the value joins cleanly.
			expect(withShell(`trash "$TMPDIR/notes.md"`, `${tmp}/`)).toEqual([true]);
		});

		test("the expanded path is measured like any literal one", () => {
			expect(withShell(`trash "$TMPDIR"`)).toEqual([false]);
			expect(withShell(`trash "$TMPDIR/../home/notes.md"`)).toEqual([false]);
			expect(withShell(`trash "$TMPDIR/docs-link/report.pdf"`)).toEqual([false]);
			expect(withShell(`trash "$TMPDIR/missing.txt"`)).toEqual([null]);
			// A TMPDIR outside every temp root is no temp directory.
			expect(withShell(`trash "$TMPDIR/notes.md"`, home)).toEqual([false]);
		});

		test("an unknown shell TMPDIR leaves it unread", () => {
			expect(withShell(`trash "$TMPDIR/run/report.json"`, null)).toEqual([null]);
			expect(withShell(`trash "$TMPDIR/run/report.json"`, "relative/tmp")).toEqual([null]);
		});

		test("only a bare $TMPDIR with a plain path after it is read", () => {
			expect(withShell(`trash "\${TMPDIR:-/tmp}/run/report.json"`)).toEqual([null]);
			expect(withShell(`trash "$TMPDIRX/run/report.json"`)).toEqual([null]);
			expect(withShell(`trash "$TMPDIR/$NAME"`)).toEqual([null]);
			expect(withShell(`trash "$TMPDIR"/*.md`)).toEqual([null]);
			expect(withShell("trash $TMPDIR/*.md")).toEqual([null]);
			expect(withShell(`trash "$TMPDIR/$(echo run)"`)).toEqual([null]);
			expect(withShell(`trash x"$TMPDIR/notes.md"`)).toEqual([null]);
		});

		test("an unquoted $TMPDIR whose value would split or glob is not read", () => {
			const spaced = join(tmp, "with space");
			expect(withShell("trash $TMPDIR/a b.txt", spaced)).toEqual([null, null]);
			expect(withShell(`trash "$TMPDIR/a b.txt"`, spaced)).toEqual([true]);
			// An extglob pattern in the value expands to other names when the shell
			// has extglob on; quoted, it is a literal directory name.
			const pattern = join(tmp, "@(run|x)");
			mkdirSync(pattern, { recursive: true });
			writeFileSync(join(pattern, "f.txt"), "x");
			expect(withShell("trash $TMPDIR/f.txt", pattern)).toEqual([null]);
			expect(withShell(`trash "$TMPDIR/f.txt"`, pattern)).toEqual([true]);
		});

		test("anything on the line that could repoint TMPDIR or the path still unmeasures it", () => {
			expect(withShell(`TMPDIR=${home}; trash "$TMPDIR/notes.md"`)).toEqual([null]);
			expect(withShell(`TMPDIR=${home} trash "$TMPDIR/notes.md"`)).toEqual([null]);
			expect(withShell(`export TMPDIR=${home}; trash "$TMPDIR/notes.md"`)).toEqual([null]);
			expect(withShell(`ln -sfn ${home} ${tmp}/run && trash "$TMPDIR/run/report.json"`)).toEqual([null]);
		});
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
		expect(flags("cd ./run && trash report.json", tmp)).toEqual([true]);
		expect(flags(`cd ../tmp && trash notes.md`, home)).toEqual([true]);
		// A cd the walk cannot pin leaves the directory unknown.
		expect(flags(`cd "$X" && trash notes.md`, tmp)).toEqual([null]);
	});

	test("a cd the shell may resolve differently from the gate leaves the line unmeasured", () => {
		// `~` is the shell's HOME, which may not be the gate's.
		expect(flags("cd ~/x && trash y", tmp)).toEqual([null]);
		expect(flags("cd ~ && trash notes.md", tmp)).toEqual([null]);
		expect(flags("HOME=/tmp; cd ~/x && trash y", tmp)).toEqual([null]);
		expect(flags("export HOME=/tmp; cd ~/x && trash y", tmp)).toEqual([null]);
		// A bare name is searched in CDPATH first.
		expect(flags("cd run && trash report.json", tmp)).toEqual([null]);
		// HOME, OLDPWD, the directory stack: all the shell's.
		expect(flags("cd && trash notes.md", tmp)).toEqual([null]);
		expect(flags("cd - && trash notes.md", tmp)).toEqual([null]);
		expect(flags("popd; trash notes.md", tmp)).toEqual([null]);
		// The walk does not follow pushd, so its directory stays unknown.
		expect(flags(`pushd ${tmp} && trash notes.md`, home)).toEqual([null]);
	});

	test("every operand is its own entry, flags are skipped, -- ends them", () => {
		expect(measure(`rm -rf -- ${tmp}/notes.md ${home}/notes.md`)).toEqual([
			{ target: `${tmp}/notes.md`, underTempRoot: true },
			{ target: `${home}/notes.md`, underTempRoot: false },
		]);
		expect(flags(`trash ${tmp}/notes.md && trash ${home}/notes.md`)).toEqual([true, false]);
	});

	test("a line with more operands than the state carries is measured null throughout", () => {
		const sixteen = Array.from({ length: 16 }, () => `${tmp}/notes.md`).join(" ");
		expect(flags(`rm -rf ${sixteen}`)).toEqual(new Array(16).fill(true));
		const entries = measure(`rm -rf ${sixteen} ${home}/notes.md`);
		expect(entries).toHaveLength(16);
		expect(entries?.every(entry => entry.underTempRoot === null)).toBe(true);
		// Split across two deletes, the count is the line's, not one command's.
		expect(flags(`trash ${sixteen}; trash ${home}/notes.md`)?.every(flag => flag === null)).toBe(true);
	});

	test("a tracked source file in the working directory measures false", () => {
		mkdirSync(join(home, "src"), { recursive: true });
		writeFileSync(join(home, "src", "index.ts"), "x");
		expect(flags("trash src/index.ts")).toEqual([false]);
	});

	test("an unreadable command carries no field", () => {
		expect(measure("trash 'unterminated")).toBeUndefined();
	});

	test("a word the shell may glob or brace-expand leaves the whole line unmeasured", () => {
		// `-[a]` reads as a flag here, but the shell globs it: a file named `-a`
		// in the cwd becomes an operand the gate never saw.
		expect(flags(`trash -[a] ${tmp}/notes.md`)).toEqual([null]);
		// `-{f,/Users/x}` expands to `-f /Users/x`: a second target.
		expect(flags(`trash -{f,${home}/notes.md} ${tmp}/notes.md`)).toEqual([null]);
		// An expansion anywhere on a delete may split into more words.
		expect(flags(`trash $FLAGS ${tmp}/notes.md`)).toEqual([null, null]);
		// A `~` word stays measurable: it expands to one word, toward false only.
		expect(flags(`trash ${tmp}/notes.md ~`)).toEqual([true, false]);
	});

	test("a cd counts only when the shell is certain to have made it", () => {
		// `;` runs the delete even when the cd failed, from the old directory.
		expect(flags(`cd ${tmp}/missing; trash notes.md`)).toEqual([null]);
		expect(flags(`cd ${tmp}; trash notes.md`)).toEqual([null]);
		expect(flags(`cd ${tmp} || trash notes.md`)).toEqual([null]);
		// A later `;` or `||` after a cd runs whether or not the cd held.
		expect(flags(`cd ${tmp} && trash notes.md; trash notes.md`)).toEqual([null, null]);
		expect(flags(`cd ${tmp} && trash notes.md || trash notes.md`)).toEqual([null, null]);
		// `a || cd x && b` is `(a || cd x) && b`: when `a` succeeds the cd is
		// skipped and `b` still runs, from the old directory.
		expect(flags(`trash ${home}/missing || cd ${tmp} && trash notes.md`)).toEqual([null, null]);
		// The cd target has to exist as a directory.
		expect(flags(`cd ${tmp}/missing && trash notes.md`)).toEqual([null]);
		expect(flags(`cd ${tmp}/notes.md && trash notes.md`)).toEqual([null]);
		expect(flags(`cd ${tmp} && trash notes.md`)).toEqual([true]);
	});

	test("a negated statement or an unsearchable cd target leaves the line unmeasured", () => {
		// `!` turns a failed cd into success, so `&&` runs the delete from the
		// old directory.
		expect(flags(`! cd ${tmp} && trash notes.md`)).toEqual([null]);
		expect(flags(`cd ${tmp} && ! trash notes.md && trash notes.md`)).toEqual([null, null]);
		// The directory exists but isn't searchable: cd fails.
		const noperm = join(tmp, "noperm");
		mkdirSync(noperm, { recursive: true });
		writeFileSync(join(noperm, "notes.md"), "x");
		chmodSync(noperm, 0o600);
		try {
			expect(flags(`cd ${noperm} && trash notes.md`)).toEqual([null]);
			// `../notes.md` resolves without searching `noperm` itself, so only
			// the cd check stands between it and a measurement.
			expect(flags(`cd ${noperm} && trash ../notes.md`)).toEqual([null]);
		} finally {
			chmodSync(noperm, 0o755);
		}
		expect(flags(`cd ${noperm} && trash notes.md`)).toEqual([true]);
	});

	test("a cd whose .. resolves differently lexically and physically is not followed", () => {
		// bash's `cd -L` drops `link/..` by name and lands in `tmp`; the
		// filesystem walks the link and lands in `home`'s parent.
		symlinkSync(join(home, "Documents"), join(tmp, "link-to-docs"));
		expect(flags(`cd ${tmp}/link-to-docs/.. && trash notes.md`)).toEqual([null]);
		// A `..` with no link in the way agrees both ways.
		expect(flags(`cd ${tmp}/run/.. && trash notes.md`)).toEqual([true]);
		// An operand's `..` is walked the way the kernel walks it: through the
		// link first. Node's realpath alone reads it by name and says temp.
		expect(flags(`trash ${tmp}/link-to-docs/../notes.md`)).toEqual([false]);
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

	/** Runs `command` with the process TMPDIR pointed at `shellTmp`, from `cwd`. */
	const stateWithTmpdir = async (shellTmp: string, command: string, cwd: string): Promise<Array<Record<string, unknown>>> => {
		const saved = process.env.TMPDIR;
		process.env.TMPDIR = shellTmp;
		try {
			const before = modelCalls.length;
			await fire("tool_call", makeEvent(command), makeCtx({ sessionId: session(), cwd }));
			return stateOf(before).deleteTargets as Array<Record<string, unknown>>;
		} finally {
			if (saved === undefined) delete process.env.TMPDIR;
			else process.env.TMPDIR = saved;
		}
	};

	test("a $TMPDIR operand is read with the gate's TMPDIR when nothing can rewrite it", async () => {
		const real = realpathSync(mkdtempSync(join(tmpdir(), "gate-tmpdir-")));
		try {
			mkdirSync(join(real, "x"));
			writeFileSync(join(real, "x", "probe.md"), "x");
			const entries = await stateWithTmpdir(real, 'trash "$TMPDIR/x/probe.md"', home);
			expect(entries).toHaveLength(1);
			expect(entries[0]).toMatchObject({ target: '$TMPDIR/x/probe.md', underTempRoot: true });
		} finally {
			rmSync(real, { recursive: true, force: true });
		}
	});

	test("a $TMPDIR operand stays unmeasured after an earlier call in the session may have changed the shell", async () => {
		const real = realpathSync(mkdtempSync(join(tmpdir(), "gate-tmpdir-touched-")));
		const saved = process.env.TMPDIR;
		process.env.TMPDIR = real;
		try {
			mkdirSync(join(real, "x"));
			writeFileSync(join(real, "x", "probe.md"), "x");
			const command = 'trash "$TMPDIR/x/probe.md"';
			const flagFor = async (id: string, line: string): Promise<unknown> => {
				const before = modelCalls.length;
				await fire("tool_call", makeEvent(line), makeCtx({ sessionId: id, cwd: home }));
				return (stateOf(before).deleteTargets as Array<Record<string, unknown>> | undefined)?.[0]?.underTempRoot;
			};
			const touched = session();
			const clean = session();
			expect(await flagFor(touched, "export IFS=/")).toBeUndefined();
			expect(await flagFor(touched, command)).toBeNull();
			// The persistent shell is per session: another one is unaffected.
			expect(await flagFor(clean, "ls -la")).toBeUndefined();
			expect(await flagFor(clean, command)).toBe(true);
		} finally {
			if (saved === undefined) delete process.env.TMPDIR;
			else process.env.TMPDIR = saved;
			rmSync(real, { recursive: true, force: true });
		}
	});

	test("a $TMPDIR operand stays unmeasured when an .envrc sits in the working directory", async () => {
		const real = realpathSync(mkdtempSync(join(tmpdir(), "gate-tmpdir-envrc-")));
		try {
			mkdirSync(join(real, "x"));
			writeFileSync(join(real, "x", "probe.md"), "x");
			writeFileSync(join(real, ".envrc"), "export TMPDIR=$HOME\n");
			const entries = await stateWithTmpdir(real, 'trash "$TMPDIR/x/probe.md"', real);
			expect(entries).toHaveLength(1);
			expect(entries[0].underTempRoot).toBeNull();
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

describe("shellTmpdirFor", () => {
	const cwd = mkdtempSync(join(base, "shell-tmpdir-"));
	const nested = join(cwd, "a", "b");
	mkdirSync(nested, { recursive: true });

	test("returns the process TMPDIR when no .envrc is above the working directories", () => {
		expect(shellTmpdirFor([cwd], { TMPDIR: "/var/folders/zz/T" })).toBe("/var/folders/zz/T");
	});

	test("is null when TMPDIR is unset or empty", () => {
		expect(shellTmpdirFor([cwd], {})).toBeNull();
		expect(shellTmpdirFor([cwd], { TMPDIR: "" })).toBeNull();
	});

	test("is null when an .envrc sits at or above any of the working directories", () => {
		writeFileSync(join(cwd, ".envrc"), "export TMPDIR=/x\n");
		try {
			expect(shellTmpdirFor([cwd], { TMPDIR: "/var/folders/zz/T" })).toBeNull();
			expect(shellTmpdirFor([nested], { TMPDIR: "/var/folders/zz/T" })).toBeNull();
			expect(shellTmpdirFor([home, nested], { TMPDIR: "/var/folders/zz/T" })).toBeNull();
		} finally {
			rmSync(join(cwd, ".envrc"), { force: true });
		}
		expect(shellTmpdirFor([nested], { TMPDIR: "/var/folders/zz/T" })).toBe("/var/folders/zz/T");
	});

	test("is null once an earlier command in the shell may have changed it", () => {
		expect(shellTmpdirFor([cwd], { TMPDIR: "/var/folders/zz/T" }, true)).toBeNull();
	});

	test("reads process.env by default", () => {
		const saved = process.env.TMPDIR;
		process.env.TMPDIR = "/var/folders/yy/T";
		try {
			expect(shellTmpdirFor([cwd])).toBe("/var/folders/yy/T");
		} finally {
			if (saved === undefined) delete process.env.TMPDIR;
			else process.env.TMPDIR = saved;
		}
	});
});

describe("touchesShellEnv", () => {
	test("names that can change TMPDIR or IFS in the persistent shell", () => {
		for (const command of ["export TMPDIR=/Users", "TMPDIR=/x", "unset TMPDIR", "IFS=/", "export IFS=:", "echo ${TMPDIR:=/x}", "eval \"$setup\"", "source ./env.sh", ". ./env.sh", "ls && . ./env.sh", "shopt -s extglob", "declare -x TMPDIR=/y"]) {
			expect([command, touchesShellEnv(command)]).toEqual([command, true]);
		}
	});

	test("plain reads and unrelated commands leave it alone", () => {
		for (const command of ['trash "$TMPDIR/x"', "ls $TMPDIR", "echo ${TMPDIR}/a", "echo $IFS", "ls . src", "cat file.txt", "git status", "bun run evaluate", "export PATH=$PATH:/x", "echo sourcemap"]) {
			expect([command, touchesShellEnv(command)]).toEqual([command, false]);
		}
	});
});
