/**
 * The script-body reader (issue #67) finds interpreter invocations by reading
 * the command as text: a masker blanks heredoc bodies and quote spans, the
 * host tokenizer splits segments, and a text walk follows `cd`. Each of the
 * three lost its place on shapes the shell reads differently, and when it did
 * the reader read nothing, or the wrong file, and refused nothing:
 *
 * - a quote inside a `#` comment opened a quote the masker blanked to EOF;
 * - every `<<` opened a heredoc, including `<<<`, `$((1<<3))` and quoted or
 *   commented text, and a delimiter it could not read blanked to EOF;
 * - the walk read `# ; cd dir` in a comment as a real `cd`;
 * - a `cd` the walk could not pin (a target that does not exist yet, CDPATH, a
 *   brace or variable verb, a function body) counted as a no-op or as a move;
 * - an interpreter the tokenizer did not see as a segment's verb (`then
 *   python3`, `time python3`, `"$(python3 …)"`, a brace-spelled name) was not
 *   an interpreter at all.
 *
 * Everything runs through the interceptor against real files: what matters is
 * which file the gate reads off disk.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fire, jevSafeAnswer, loadPlugin, makeCtx, makeEvent, makeSettings, refusalOf, removeConfigFile, resultText, setJevAnswer, stateOf } from "./fixtures";

/** A body a SAFE cannot release: `subprocess` is an interpreter-code marker. */
const HARMFUL = 'import subprocess\nsubprocess.run(["rm", "-rf", "x"])\n';
const BENIGN = 'print("scratch probe ok")\n';

/** The temp root: `start/` is the session's directory, `safe/` a sibling. */
let root: string;
let start: string;
let seq = 0;

const write = (file: string, body: string): void => {
	fs.mkdirSync(path.dirname(file), { recursive: true });
	fs.writeFileSync(file, body);
};

const gate = async (command: string) => {
	seq += 1;
	return resultText(await fire("tool_call", makeEvent(command), makeCtx({ sessionId: `script-body-parse-${seq}`, cwd: start })));
};

beforeEach(async () => {
	removeConfigFile();
	await loadPlugin(makeSettings([]));
	setJevAnswer(jevSafeAnswer());
	root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "omp-script-body-parse-")));
	start = path.join(root, "start");
	fs.mkdirSync(start);
});

afterEach(() => {
	fs.rmSync(root, { recursive: true, force: true });
});

describe("text the masker used to blank to EOF does not hide the program after it", () => {
	test.each([
		["an apostrophe in a comment", "echo hi # it's\npython3 p.py"],
		["a comment line with an apostrophe", "# don't\npython3 p.py"],
		["a double quote in a comment", 'echo hi # "\npython3 p.py'],
		["an arithmetic shift", "echo $((1<<3))\npython3 p.py"],
		["a spaced arithmetic shift in an assignment", "x=$((1 << 3))\npython3 p.py"],
		["a here-string", "cat <<< hi\npython3 p.py"],
		["a quoted <<", "echo '<<' x\npython3 p.py"],
		["a << in a comment", "echo a # <<EOF\npython3 p.py"],
	])("%s", async (_name, command) => {
		write(path.join(start, "p.py"), HARMFUL);
		const payload = refusalOf(await gate(command));
		expect(payload.layer).toBe("flagged");
		expect(payload.why).toContain("python3 runs p.py");
		expect(String(stateOf(0).command)).toContain("subprocess.run(");
	});
});

describe("a comment does not move the shell", () => {
	test("a cd inside a comment is not followed", async () => {
		write(path.join(start, "p.py"), HARMFUL);
		write(path.join(root, "safe", "p.py"), BENIGN);
		const payload = refusalOf(await gate("echo hi # ; cd ../safe\npython3 p.py"));
		// bash runs start/p.py: the comment is inert.
		expect(payload.layer).toBe("flagged");
		expect(String(stateOf(0).command)).not.toContain("scratch probe ok");
	});
});

describe("a cd the walk cannot pin refuses rather than guessing", () => {
	const cases: Array<[string, string]> = [
		["a target the command creates first", "mkdir -p nd && cd nd && python3 p.py"],
		["a cd inside a function that is called", "function f { cd ../safe; }; f; python3 p.py"],
		["a cd inside a function that is never called", "function f {\ncd ../safe\n}\npython3 p.py"],
		["a cd inside a loop", "for d in ../safe; do cd ../safe; done; python3 p.py"],
	];
	test.each(cases)("%s", async (_name, command) => {
		write(path.join(start, "p.py"), HARMFUL);
		write(path.join(root, "safe", "p.py"), BENIGN);
		write(path.join(start, "nd", "p.py"), BENIGN.replace("ok", "nd"));
		fs.rmSync(path.join(start, "nd"), { recursive: true });
		const result = await gate(command);
		expect(result).not.toBe("ALLOWED");
		expect(refusalOf(result).layer).toBe("script-body");
		expect(refusalOf(result).why).toContain("working directory");
	});

	test("a function body called after a cd has no directory of its own", async () => {
		// bash runs the body where `f` is called: in safe/, after the cd.
		write(path.join(start, "p.py"), BENIGN);
		write(path.join(root, "safe", "p.py"), HARMFUL);
		const result = await gate("f() { python3 p.py; }; cd ../safe; f");
		expect(refusalOf(result).layer).toBe("script-body");
	});

	test.each([
		["a function with no cd", "f() { python3 p.py; }; f"],
		["a function that wraps the interpreter", "python3() { command python3 ../safe/p.py; }; python3 p.py"],
	])("a program in a command that defines a function refuses: %s", async (_name, command) => {
		write(path.join(start, "p.py"), HARMFUL);
		write(path.join(root, "safe", "p.py"), BENIGN);
		const result = await gate(command);
		expect(refusalOf(result).layer).toBe("script-body");
		expect(refusalOf(result).why).toContain("shell function");
	});

	test("an expanded verb before the program in the text still refuses", async () => {
		// `$X` may call a function or a `cd` that runs before python3 does.
		write(path.join(start, "p.py"), HARMFUL);
		write(path.join(root, "safe", "p.py"), BENIGN);
		const result = await gate("python3 p.py; $X");
		expect(refusalOf(result).layer).toBe("script-body");
		expect(refusalOf(result).why).toContain("expands the command name");
	});

	test("a wrapper's own directory change is part of which file was read", async () => {
		// The parse pass must not pass over ./p.py because the text pass read
		// ../safe/p.py under the same operand name.
		write(path.join(start, "p.py"), HARMFUL);
		write(path.join(root, "safe", "p.py"), BENIGN);
		const payload = refusalOf(await gate("if true; then python3 p.py; fi; env -C ../safe python3 p.py"));
		expect(payload.layer).toBe("flagged");
		expect(String(stateOf(0).command)).toContain("subprocess.run(");
	});

	test.each([
		["function cd { :; }; cd ../safe; python3 p.py"],
		["function cd () { :; }; cd ../safe; python3 p.py"],
		["cd() { :; }; cd ../safe; python3 p.py"],
	])("a function that shadows cd: %s", async command => {
		// bash calls the no-op function, so python3 runs ./p.py.
		write(path.join(start, "p.py"), HARMFUL);
		write(path.join(root, "safe", "p.py"), BENIGN);
		const result = await gate(command);
		expect(refusalOf(result).layer).toBe("script-body");
	});

	test("a bare cd target while the command sets CDPATH", async () => {
		// bash searches CDPATH first: `cd safe` lands in root/safe, not start/safe.
		write(path.join(root, "safe", "p.py"), HARMFUL);
		write(path.join(start, "safe", "p.py"), BENIGN);
		const result = await gate(`CDPATH=${root}; cd safe; python3 p.py`);
		expect(refusalOf(result).layer).toBe("script-body");
		expect(refusalOf(result).why).toContain("working directory");
	});
});

describe("a verb the shell expands is not an interpreter the reader can name", () => {
	test.each([
		["a brace-expanded interpreter", "pyth{on3,} p.py"],
		["a variable interpreter", "$PY p.py"],
		["a substituted interpreter", "$(command -v python3) p.py"],
		["a brace-expanded cd", "{cd,../safe}; python3 p.py"],
		["a brace in the cd verb", "c{d,} ../safe; python3 p.py"],
		["an expansion glued to the cd verb", "cd${x} ../safe; python3 p.py"],
		["a variable verb", "c=cd; $c ../safe; python3 p.py"],
		["a brace-expanded interpreter with an extensionless operand", "pyth{on3,} payload"],
		["a variable interpreter with an extensionless file operand", "$PY payload"],
		["a variable interpreter with an expanded operand", "$PY $SCRIPT"],
		["a variable interpreter with a directory operand", "$PY pkgdir"],
		["a variable verb reading a redirected file", "$X < p.py"],
		["a variable verb reading a here-string", "$X <<< \"$code\""],
		["a variable verb reading a heredoc", "$X <<'EOF'\nimport os\nEOF"],
		["a variable verb fed by a pipe", "cat p.py | $X"],
		["a variable verb reading stdin by -", "$X -"],
		["a path verb whose last component is built", "\"$D/py\"$V p.py"],
		["a path verb whose last component is an arithmetic expansion", "$D/$((1)) p.py"],
	])("%s refuses", async (_name, command) => {
		write(path.join(start, "payload"), HARMFUL);
		write(path.join(start, "pkgdir", "__main__.py"), HARMFUL);
		write(path.join(start, "p.py"), HARMFUL);
		write(path.join(root, "safe", "p.py"), BENIGN);
		const result = await gate(command);
		expect(refusalOf(result).layer).toBe("script-body");
		expect(refusalOf(result).why).toContain("expands the command name");
	});

	test.each([
		["builtin alias", "builtin alias run=python3; run p.py"],
		["command alias", "command alias run=python3; run p.py"],
		["a backslashed alias", "\\alias run=python3; run p.py"],
		["an alias and a later command with any operand", "alias run=python3; run payload"],
	])("an alias definition spelled as %s refuses", async (_name, command) => {
		write(path.join(start, "p.py"), HARMFUL);
		write(path.join(start, "payload"), HARMFUL);
		const result = await gate(command);
		expect(refusalOf(result).layer).toBe("script-body");
		expect(refusalOf(result).why).toContain("defines an alias");
	});

	test.each([
		["an editor variable with nothing to open", "$EDITOR"],
		["all arguments as the command", '"$@"'],
	])("%s with no script to run stays open", async (_name, command) => {
		expect(await gate(command)).toBe("ALLOWED");
	});
});

describe("the parse finds interpreters the text reader missed", () => {
	test.each([
		["inside a quoted substitution", 'echo "$(python3 p.py)"'],
		["inside backticks", "echo `python3 p.py`"],
		["in an if branch", "if true; then python3 p.py; fi"],
		["in a loop body", "for i in 1; do python3 p.py; done"],
		["after time", "time python3 p.py"],
		["after a negation", "! python3 p.py"],
	])("%s is read", async (_name, command) => {
		write(path.join(start, "p.py"), HARMFUL);
		const payload = refusalOf(await gate(command));
		expect(payload.layer).toBe("flagged");
		expect(String(stateOf(0).command)).toContain("subprocess.run(");
	});

	test("a program found by the parse is read from the directory it runs in", async () => {
		write(path.join(start, "p.py"), BENIGN);
		write(path.join(root, "safe", "p.py"), HARMFUL);
		const payload = refusalOf(await gate("cd ../safe && if true; then python3 p.py; fi"));
		expect(payload.layer).toBe("flagged");
	});
});

describe("text the parser rejects fails closed", () => {
	// bash runs a multi-line command line by line: every line above the stray
	// `fi` runs before the syntax error stops it, but the parser rejects the
	// whole text, so none of the parse's checks would see those lines.
	test.each([
		["an unclosed quote before a program", "echo 'oops\npython3 p.py"],
		["a comment cd above a syntax error", "echo hi # ; cd ../safe\npython3 p.py\nfi"],
		["a brace-expanded cd above a syntax error", "{cd,../safe}; python3 p.py\nfi"],
		["time above a syntax error", "time python3 p.py\nfi"],
		["a brace-expanded interpreter above a syntax error", "pyth{on3,} p.py\nfi"],
		["an escaped interpreter name above a syntax error", "py\\thon3 p\nfi"],
		["a quoted interpreter name above a syntax error", 'p"y"thon3 p\nfi'],
		["a variable verb above a syntax error", "$X p\nfi"],
	])("%s refuses", async (_name, command) => {
		write(path.join(start, "p.py"), HARMFUL);
		write(path.join(root, "safe", "p.py"), BENIGN);
		const result = await gate(command);
		expect(refusalOf(result).layer).toBe("script-body");
	});
});

describe("ordinary commands keep working", () => {
	test.each([
		["a cd chain", "cd dir && python3 x.py", "dir"],
		["a cd on its own line", "cd dir\npython3 x.py", "dir"],
		["a trailing comment", "python3 x.py # comment", ""],
		["a comment line before the program", "# Let's run it\npython3 x.py", ""],
		["a quoted apostrophe and a comment", "echo \"it's\" # it's\npython3 x.py", ""],
		["a written heredoc with an unbalanced quote", "cat > f <<'EOF'\nit's \"\nEOF\npython3 x.py", ""],
		["an empty heredoc", "cat > f <<EOF\nEOF\npython3 x.py", ""],
		["a test before the program", "[ -f x.py ] && python3 x.py", ""],
		["a venv interpreter path", '"$VENV/bin/python" x.py', ""],
		["a subshell cd", "(cd dir && python3 x.py)", "dir"],
		["a background run", "cd dir && python3 x.py &", "dir"],
		["a loop over files", "cd dir && for f in a b; do python3 x.py $f; done", "dir"],
	])("%s", async (_name, command, dir) => {
		write(path.join(start, dir, "x.py"), BENIGN);
		expect(await gate(command)).toBe("ALLOWED");
		expect(String(stateOf(0).command)).toContain("scratch probe ok");
	});

	test("a quoted apostrophe with no program", async () => {
		expect(await gate(`echo "it's"`)).toBe("ALLOWED");
	});
});
