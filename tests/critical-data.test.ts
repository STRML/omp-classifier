/**
 * The built-in critical patterns read what a command RUNS, not the data it
 * carries.
 *
 * Two production false blocks, both permanent for the session because a
 * critical refusal never yields:
 *
 * 1. A commit whose message says "reboot" matched the host-control pattern,
 *    which wants the word at command position and found it after a space
 *    inside the `-m` text.
 * 2. `bun test <file>` spliced the test file's body into the scanned text, and
 *    a fixture string shaped like `rm -rf /` matched the recursive-delete
 *    pattern.
 *
 * The fix blanks only parser-identified data operands out of the raw command
 * (a `git commit` message, a `gh pr|issue` body or title) and scans each
 * spliced body on its own: a shell body keeps the critical refusal, while a
 * hit in a JavaScript or Python body goes to the judge with the hit named in
 * its state, with no refusal record. The fail-closed half of this file holds
 * every shape that executes the same text to the critical layer.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { criticalScanText } from "../critical-scan";
import {
	fire,
	jevSafeAnswer,
	jevUnsafeAnswer,
	loadPlugin,
	makeCtx,
	makeEvent,
	makeSessionId,
	makeSettings,
	modelCalls,
	refusalOf,
	removeConfigFile,
	resultText,
	setJevAnswer,
	stateOf,
	writeConfigFile,
} from "./fixtures";

let root: string;

const fresh = () => makeCtx({ sessionId: makeSessionId("critical-data"), cwd: root });
const gate = async (command: string, ctx = fresh()) => resultText(await fire("tool_call", makeEvent(command), ctx));
const layerOf = async (command: string, ctx = fresh()) => {
	const text = await gate(command, ctx);
	return text === "ALLOWED" ? "ALLOWED" : refusalOf(text).layer;
};

beforeEach(async () => {
	removeConfigFile();
	await loadPlugin(makeSettings([]));
	setJevAnswer(jevSafeAnswer());
	modelCalls.length = 0;
	root = fs.mkdtempSync(path.join(os.tmpdir(), "omp-critical-data-"));
});

afterEach(() => {
	fs.rmSync(root, { recursive: true, force: true });
});

/** The production commit, anonymized: "reboot" sits inside the message. */
const REBOOT_COMMIT =
	'git add HANDOFF.md && git commit -q -m "handoff: root is per-boot and currently absent after a spontaneous reboot\n\nmore prose" && git log --oneline -2';

describe("data operands do not match the critical patterns", () => {
	test("a commit message that says reboot reaches the judge and runs", async () => {
		const ctx = fresh();
		expect(await gate(REBOOT_COMMIT, ctx)).toBe("ALLOWED");
		expect(modelCalls.length).toBe(1);
		// No refusal record: the same call in the same session still runs.
		expect(await gate(REBOOT_COMMIT, ctx)).toBe("ALLOWED");
	});

	test.each([
		["-m with a destructive phrase", `git commit -m "docs: never run rm -rf / on the host"`],
		["--message=", `git commit --message="note: reboot required"`],
		["--message as its own word", `git commit --message "note: reboot required"`],
		["-m attached", `git commit "-mnote: reboot required"`],
		["a short cluster ending in m", `git commit -am "note: reboot required"`],
		["-C before the subcommand", `git -C /Users/you/repo commit -m "note: reboot required"`],
		["a message with non-ASCII text before the match", `git commit -m "café 漢字 🚀: a reboot now" && git log -1`],
		["stderr joined to stdout", `git commit -m "note: reboot required" 2>&1 && git status -s`],
		["several -m paragraphs", `git commit -m "fix: survive a reboot" -m "after a reboot the root is gone"`],
	])("%s", async (_name, command) => {
		expect(await gate(command)).toBe("ALLOWED");
		expect(modelCalls.length).toBe(1);
	});
});

describe("anything that executes the same text stays critical", () => {
	test.each([
		// Shapes the narrowed blanking no longer reads: scanned in full.
		["a heredoc fed to cat inside -m", `git commit -m "$(cat <<'EOF'\nfix: survive a reboot\nEOF\n)"`],
		["a quoted substitution with a glob part", `git commit -m "$(cat <<'EOF'\na reboot now\nEOF\n)"*`],
		["a heredoc on -F -", `git commit -F - <<'EOF'\nfix: a reboot now\nEOF`],
		["a commit piped to tail", `git commit -m "note: reboot required" 2>&1 | tail -5`],
		["gh pr create --body", `gh pr create --title x --body "Never rm -rf / here."`],
		["echo after the commit", `git commit -m "note: reboot required" && echo done`],
		["a bare rm -rf /", "rm -rf /"],
		["bash -c", `bash -c "rm -rf /"`],
		["sh -c", `sh -c 'rm -rf /'`],
		["eval", `eval "rm -rf /"`],
		["a command substitution", "echo $(rm -rf /)"],
		["backticks", "echo `rm -rf /`"],
		["xargs", "echo / | xargs rm -rf /"],
		["find -exec", "find . -exec rm -rf / \\;"],
		["a substitution inside -m", `git commit -m "$(rm -rf /)"`],
		["backticks inside -m", 'git commit -m "`rm -rf /`"'],
		["a parameter with a substituted default inside -m", 'git commit -m "${X:-$(rm -rf /)}"'],
		["an unquoted heredoc that substitutes", `git commit -F - <<EOF\n$(rm -rf /)\nEOF`],
		["a cat heredoc that runs a substitution", `git commit -m "$(cat <<EOF\n$(rm -rf /)\nEOF\n)"`],
		["cat with an argument inside -m", `git commit -m "$(cat notes.txt <<'EOF'\nreboot\nEOF\n)"`],
		["a git -c value", `git -c core.editor='rm -rf /' commit -m x`],
		["a git -c hooksPath whose commit-msg hook reads the message", `git -c core.hooksPath=.hooks commit -m 'rm -rf /'`],
		["a git -c editor that runs the message file", `git -c core.editor='sh .git/COMMIT_EDITMSG' commit -e -m 'rm -rf /'`],
		["a sequence after the commit", `git commit -m x; reboot`],
		["the last argument handed to eval", `git commit -m 'rm -rf /'; eval "$_"`],
		["the message read back into sh", `git commit -m 'rm -rf /' && git log -1 --format=%B | sh`],
		["the message written into a hook", `git commit -m 'rm -rf /' && git log -1 --format=%B > .git/hooks/pre-push && git push`],
		["git log --output writing a hook", `git commit -m 'rm -rf /' && git log -1 --format=%B --output=.git/hooks/pre-push && git push`],
		["git push --receive-pack naming a program", `git commit -m 'rm -rf /' && git push --receive-pack='sh .git/COMMIT_EDITMSG' ./mirror`],
		["git diff --ext-diff", `git commit -m 'rm -rf /' && git diff --ext-diff HEAD~1`],
		["git commit -e opening the editor", `git commit -e -m 'rm -rf /'`],
		["a duplicate onto descriptor 3", `git commit -m 'rm -rf /' && git log -1 --format=%B >&3`],
		["gh pr create --editor", `gh pr create --title x --body 'rm -rf /' --editor`],
		["gh pr create --web", `gh pr create --title x --body 'rm -rf /' --web`],
		["printf -v keeping the message in the session shell", `git commit -m 'rm -rf /' && printf -v X '%s' "$(git log -1 --format=%B)"`],
		["an env prefix on the commit",`GIT_EDITOR=sh git commit -m 'rm -rf /'`],
		["a backgrounded commit", `git commit -m 'a reboot now' & git status`],
		["a function named git", `git() { sh -c "$*"; }; git commit -m 'rm -rf /'`],
		["a git alias subcommand", `git ship -m 'rm -rf /'`],
		["a verb spelled as a variable", `$G commit -m 'rm -rf /'`],
		["echo stays scanned", `echo "rm -rf /"`],
		["a commit inside a substitution", `bash -c "$(git commit -m 'rm -rf /')"`],
	])("%s", async (_name, command) => {
		expect(await layerOf(command)).toBe("critical");
		expect(modelCalls.length).toBe(0);
	});
});

describe("words the shell rewrites, and a shell an earlier call changed", () => {
	test.each([
		["a brace-expanded --output", `git commit -m 'rm -rf /' && git log -1 --format=%B {--output=.git/hooks/pre-push,-1} && git push`],
		["a globbed flag", `git commit -m 'rm -rf /' && git log -1 --format=%B --outp*=x`],
		["a brace in the message flag's value", `git commit -m {'rm -rf /',x}`],
		["an unquoted expansion as a value", `git commit -m $MSG -m 'rm -rf /'`],
	])("%s scans the whole text", async (_name, command) => {
		expect(await layerOf(command)).toBe("critical");
	});

	test.each([
		["a git function", `git() { sh -c "$*"; }`],
		["a function keyword definition", "function git { sh; }"],
		["an alias", "alias git='sh -c'"],
		["a hashed path", "hash -p /tmp/x/git git"],
	])("after %s earlier in the session, a commit message is scanned in full", async (_name, earlier) => {
		const ctx = fresh();
		await gate(earlier, ctx);
		modelCalls.length = 0;
		expect(await layerOf(`git commit -m "note: a reboot now"`, ctx)).toBe("critical");
		// A fresh session is not latched.
		expect(await gate(`git commit -m "note: a reboot now"`)).toBe("ALLOWED");
	});
});

describe("criticalScanText", () => {
	test("blanks the message in place and keeps every other byte", () => {
		const command = `git commit -m "say reboot" && git log`;
		const scanned = criticalScanText(command);
		expect(scanned.length).toBe(command.length);
		expect(scanned).not.toContain("reboot");
		expect(scanned.startsWith("git commit -m ")).toBe(true);
		expect(scanned.endsWith(" && git log")).toBe(true);
	});

	test("returns the text unchanged when the parser rejects it", () => {
		const command = `git commit -m "unterminated reboot`;
		expect(criticalScanText(command)).toBe(command);
	});
});

describe("spliced script bodies", () => {
	/** A test file carrying a fixture shaped like a recursive delete. */
	const FIXTURE_BODY = 'import { test, expect } from "bun:test";\ntest("refuses", () => {\n\texpect(gate("rm -rf /")).toBe("critical");\n});\n';

	beforeEach(() => {
		writeConfigFile({ maxCommandLength: 20000 });
	});

	test("a bun test file whose fixtures look destructive is judged, flagged on a SAFE, and not recorded", async () => {
		fs.mkdirSync(path.join(root, "tests"));
		fs.writeFileSync(path.join(root, "tests", "gate.test.ts"), FIXTURE_BODY);
		const ctx = fresh();
		const command = "bun test tests/gate.test.ts 2>&1 | tail -40";
		const first = refusalOf(await gate(command, ctx));
		// A SAFE alone cannot release it: no process API found by name is not
		// proof that none is reached.
		expect(first.layer).toBe("flagged");
		expect(first.why).toContain("critical pattern in bun runs tests/gate.test.ts");
		expect(modelCalls.length).toBe(1);
		// The judge is told a critical pattern matched inside the body.
		expect(stateOf(0).criticalPatternInScriptBody).toEqual({
			bodies: ["bun runs tests/gate.test.ts"],
			note: expect.any(String),
		});
		// Not remembered as a refusal: once the fixture is gone, the call runs.
		fs.writeFileSync(path.join(root, "tests", "gate.test.ts"), 'import { test } from "bun:test";\ntest("ok", () => {});\n');
		expect(await gate(command, ctx)).toBe("ALLOWED");
	});

	test.each([
		["Bun.$", "wipe.js", "await Bun.$`rm -rf /`;\n"],
		["a template-tagged $", "wipe.mjs", 'import { $ } from "zx";\nawait $`rm -rf /`;\n'],
		["child_process", "wipe.js", 'require("child_process").execSync("rm -rf /");\n'],
		["Deno.Command", "wipe.ts", 'new Deno.Command("sh", { args: ["-c", "rm -rf /"] }).spawn();\n'],
		["os.system", "wipe.py", 'import os\nos.system("rm -rf /")\n'],
		["subprocess", "wipe.py", 'import subprocess\nsubprocess.run("rm -rf /", shell=True)\n'],
		["eval of built text", "wipe.js", 'const cmd = "rm -rf /";\neval(build(cmd));\n'],
	])("a non-shell body that names %s refuses at the critical layer, unrecorded", async (_name, file, body) => {
		const verb = file.endsWith(".py") ? "python3" : file.endsWith(".ts") ? "deno run" : "node";
		fs.writeFileSync(path.join(root, file), body);
		const ctx = fresh();
		expect(await layerOf(`${verb} ${file}`, ctx)).toBe("critical");
		expect(modelCalls.length).toBe(0);
		// No refusal record: once the file no longer matches, the same call is judged.
		fs.writeFileSync(path.join(root, file), file.endsWith(".py") ? 'print("ok")\n' : 'console.log("ok");\n');
		expect(await gate(`${verb} ${file}`, ctx)).toBe("ALLOWED");
		expect(modelCalls.length).toBe(1);
	});

	test("a body hit the judge calls unsafe stays refused when a retry draws SAFE", async () => {
		fs.writeFileSync(path.join(root, "notes.js"), 'const doc = "never run rm -rf / here";\nconsole.log(doc);\n');
		const ctx = fresh();
		setJevAnswer(jevUnsafeAnswer());
		expect(refusalOf(await gate("node notes.js", ctx)).layer).toBe("unsafe");
		expect(stateOf(0).criticalPatternInScriptBody).toEqual({ bodies: ["node runs notes.js"], note: expect.any(String) });
		// A fresh SAFE (the cache is per text, so reword the call) meets the model refusal.
		setJevAnswer(jevSafeAnswer());
		expect(await gate("node ./notes.js", ctx)).not.toBe("ALLOWED");
	});

	/** A body whose hit would go to the judge: it names no process API. */
	const JUDGED_BODY = 'const doc = "never run rm -rf / here";\nconsole.log(doc);\n';

	test("with classification disabled, a judged body hit refuses at the critical layer", async () => {
		writeConfigFile({ maxCommandLength: 20000, enabled: false });
		fs.writeFileSync(path.join(root, "notes.js"), JUDGED_BODY);
		expect(await layerOf("node notes.js")).toBe("critical");
		expect(modelCalls.length).toBe(0);
	});

	test.each([
		["a static prompt rule", [{ match: "node notes.js", approval: "prompt" }], undefined],
		["tools.approval.bash: prompt with no rule", [], "prompt"],
	])("under %s, a judged body hit refuses at the critical layer", async (_name, patterns, bashPolicy) => {
		await loadPlugin(makeSettings(patterns, bashPolicy));
		fs.writeFileSync(path.join(root, "notes.js"), JUDGED_BODY);
		expect(await layerOf("node notes.js")).toBe("critical");
		expect(modelCalls.length).toBe(0);
	});

	test.each([
		["a shell script", "bash wipe.sh", "wipe.sh", "#!/bin/bash\nrm -rf /\n"],
		["a shell script run by bun", "bun run wipe.sh", "wipe.sh", "rm -rf /\n"],
		["a JavaScript-named file with a shell shebang", "bun wipe.js", "wipe.js", "#!/bin/sh\nrm -rf /\n"],
	])("%s keeps the critical refusal", async (_name, command, file, body) => {
		fs.writeFileSync(path.join(root, file), body);
		expect(await layerOf(command)).toBe("critical");
		expect(modelCalls.length).toBe(0);
	});
});
