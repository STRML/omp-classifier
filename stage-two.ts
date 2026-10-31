/**
 * stage-two — what the gate measures for the stage 2 reviewer
 * (docs/plans/2026-10-27-stage-2-reviewer.md) and what it remembers about it.
 *
 * The reviewer judges a command partly by the body of the script it runs, so
 * the body it is shown has to be the program that runs. Guessing that from
 * shell heuristics failed review after review: every wrapper flag, `cd`, PATH
 * entry or substitution was another way to run a file other than the one
 * read. So this module does not guess. It admits two command shapes and
 * refuses every other one, which keeps the stage-1 block:
 *
 *   A. no local program: every program is a bare name that is not a script,
 *      with no interpreter running a file, no wrapper running another
 *      program, and no PATH change;
 *   B. one local script: the whole command is one simple command, after at
 *      most one literal `cd <dir> &&`, its program a literal path to an
 *      existing script, every word literal, no assignment, no pipe.
 *
 * A shape-B body is read under rules a model must not be trusted to enforce:
 * a secret path, a non-regular file, a binary, an oversized file, or a body
 * that runs another local file is unread, and an unread body means no review.
 * The body is hashed when read, and `scriptsUnchanged` re-resolves and
 * re-hashes it before an allow counts.
 *
 * What this does not cover, and says so: a build runner (`bun test`, `make`,
 * `npm run`) or a git hook runs repository code nobody read. That is the
 * ordinary development work Jev's own safe criterion already covers; the
 * reviewer is told it runs the repository's own scripts.
 */
import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { isSecretPath } from "./floor";
import { REVIEWER_SCRIPT_MAX_BYTES, type ReviewerScriptBody } from "./reviewer";
import { parseShell, type ShellCommand, type ShellWord } from "./shell-ast";

export interface ReadScript extends ReviewerScriptBody {
	/** The path the command names, resolved but not through links. */
	file?: string;
	/** Where the body was read from, after links. */
	realPath?: string;
	sha256?: string;
}

/** What the gate can show the reviewer about the programs a command runs. */
export type CommandScripts = { kind: "scripts"; scripts: ReadScript[] } | { kind: "refuse"; why: string };

/** Commands that run another program named in their arguments. */
const WRAPPERS = new Set(["env", "time", "nohup", "exec", "command", "builtin", "nice", "caffeinate", "xargs", "timeout", "gtimeout", "watch", "parallel", "sudo", "doas", "su", "script", "stdbuf", "chroot", "eval", "source", ".", "find", "fd", "entr"]);
/** Interpreters: their operand is a program file or inline code. */
const INTERPRETERS = /^(?:bash|sh|zsh|dash|ksh|fish|csh|tcsh|python[\d.]*|pypy[\d.]*|node|deno|ruby|perl|php|tclsh[\d.]*|wish|lua|osascript)$/u;
/** Builtins that point a command name at another program without changing PATH. */
const REPOINT_COMMANDS = new Set(["hash", "alias", "unalias", "enable"]);
/** Text tools whose arguments are patterns (`awk -F/`, `jq '.a/2'`); they run a program file only through `-f`. */
const PROGRAM_FILE_FLAG_TOOLS = new Set(["awk", "gawk", "mawk", "nawk", "jq", "sed", "gsed"]);
/** Runners whose operand may be a program file rather than a script name. */
const FILE_RUNNERS = new Set(["bun", "bunx", "npx", "pnpx", "tsx", "ts-node"]);
/** Whether `target` and every directory above it is owned by root and
 *  writable by no one else, read without following the last link, so nothing
 *  on that chain can be replaced by the agent or the user's own tooling. */
function rootOwnedChain(target: string): boolean {
	for (let current = target; ; current = path.dirname(current)) {
		try {
			const stat = fs.lstatSync(current);
			if (stat.uid !== 0 || (!stat.isSymbolicLink() && (stat.mode & 0o022) !== 0)) return false;
		} catch {
			return false;
		}
		if (current === path.dirname(current)) return true;
	}
}

/**
 * Whether a path names a system program: absolute, no `..` segment, and both
 * the path as spelled and the file it resolves to sit on a root-owned chain
 * no one else can write. A directory prefix alone proves nothing
 * (`/usr/../tmp/x`, a user-writable `/opt/homebrew`), and neither does a
 * root-owned target behind a link in a user-writable directory.
 */
function isSystemProgram(value: string): boolean {
	const expanded = expandHome(value);
	if (!path.isAbsolute(expanded) || expanded.split("/").includes("..")) return false;
	try {
		return rootOwnedChain(expanded) && rootOwnedChain(fs.realpathSync(expanded));
	} catch {
		return false;
	}
}
const SCRIPT_EXTENSION = /\.(?:sh|bash|zsh|py|js|mjs|cjs|ts|rb|pl|tcl|lua)$/iu;
/** The hand-offs a parse can miss: a script-dir path to a program file, and a variable assigned one. */
const LOCAL_HANDOFF = [
	/\$\(\s*dirname\b[^)]*\)"?\/[^\s"']+\.(?:sh|bash|py|js|mjs|ts|rb|pl)\b/u,
	/^\s*(?:local\s+|export\s+|readonly\s+|declare\s+)?[A-Za-z_]\w*=["']?(?:[^"'\s]*(?:BASH_SOURCE|\$\(\s*dirname|\$0\b)[^"'\s]*|\.{1,2}\/[^"'\s]*)\.(?:sh|bash|zsh|py|js|mjs|ts|rb|pl)\b/mu,
];

const sha256 = (bytes: Uint8Array): string => createHash("sha256").update(bytes).digest("hex");
const unread = (spelled: string, why: string): ReadScript => ({ path: spelled, body: null, unread: why });
const refuse = (why: string): CommandScripts => ({ kind: "refuse", why });
const expandHome = (value: string): string => (value === "~" ? os.homedir() : value.startsWith("~/") ? path.join(os.homedir(), value.slice(2)) : value);
const verbName = (command: ShellCommand): string => path.basename(command.words[0]?.value ?? "");
/** The names a command's program goes by: as spelled, and, for a path, the
 *  file it resolves to, so `~/x -> /bin/sh` is still an interpreter. */
function programNames(command: ShellCommand): string[] {
	const spelled = command.words[0]?.value ?? "";
	const names = [path.basename(spelled)];
	// A path resolves as written; a bare name resolves through PATH, so a
	// `tool -> /bin/sh` link on PATH is known as `sh` too.
	const located = isPathWord(spelled) ? expandHome(spelled) : spelled === "" ? undefined : onPath(spelled);
	if (located !== undefined) {
		try {
			names.push(path.basename(fs.realpathSync(located)));
		} catch {
			// A path that does not resolve runs nothing under another name.
		}
	}
	return names;
}
const isLiteral = (word: ShellWord): boolean => word.fixed;

/** Whether a word names a file by path rather than by a bare name. */
const isPathWord = (value: string): boolean => value.includes("/") || value.startsWith("~");

/** Whether PATH holds an empty or relative entry. The shell resolves one from
 *  the command's own directory, after any `cd`, so the gate cannot tell which
 *  file a bare name runs (https://github.com/STRML/omp-classifier/issues/206). */
function pathHasRelativeEntry(): boolean {
	return (process.env.PATH ?? "").split(path.delimiter).some(dir => !path.isAbsolute(dir));
}

/** A bare name as the gate's PATH resolves it. Callers that vouch for a bare
 *  name check `pathHasRelativeEntry` first: this lookup skips those entries. */
function onPath(name: string): string | undefined {
	for (const dir of (process.env.PATH ?? "").split(path.delimiter)) {
		if (dir === "") continue;
		const candidate = path.join(dir, name);
		try {
			const stat = fs.statSync(candidate);
			if (stat.isFile() && (stat.mode & 0o111) !== 0) return candidate;
		} catch {
			// Not in this directory.
		}
	}
	return undefined;
}

/** Whether a file is text a shell or interpreter runs, rather than a binary. */
function isScriptFile(file: string): boolean {
	try {
		const fd = fs.openSync(file, "r");
		try {
			const head = Buffer.alloc(512);
			const read = fs.readSync(fd, head, 0, head.length, 0);
			const bytes = head.subarray(0, read);
			return !bytes.includes(0) && (bytes.subarray(0, 2).toString() === "#!" || SCRIPT_EXTENSION.test(file));
		} finally {
			fs.closeSync(fd);
		}
	} catch {
		return false;
	}
}

/** Read one program file under the reviewer's rules. */
export function readScriptForReview(spelled: string, file: string): ReadScript {
	let real: string;
	let stat: fs.Stats;
	try {
		real = fs.realpathSync(file);
		stat = fs.statSync(real);
	} catch (err) {
		return unread(spelled, `could not be resolved (${(err as NodeJS.ErrnoException).code ?? "error"})`);
	}
	if (isSecretPath(file) || isSecretPath(real)) return unread(spelled, "a secret path");
	if (!stat.isFile()) return unread(spelled, "not a regular file");
	if (stat.size > REVIEWER_SCRIPT_MAX_BYTES) return unread(spelled, `over ${REVIEWER_SCRIPT_MAX_BYTES} bytes`);
	let bytes: Buffer;
	try {
		bytes = fs.readFileSync(real);
	} catch (err) {
		return unread(spelled, `could not be read (${(err as NodeJS.ErrnoException).code ?? "error"})`);
	}
	if (bytes.byteLength !== stat.size) return unread(spelled, "changed while it was read");
	if (bytes.includes(0)) return unread(spelled, "a binary");
	const body = bytes.toString("utf8");
	if (!body.startsWith("#!") && !SCRIPT_EXTENSION.test(real)) return unread(spelled, "not a script");
	const handOff = bodyHandOff(body);
	if (handOff !== undefined) return unread(spelled, handOff);
	return { path: spelled, body, file, realPath: real, sha256: sha256(bytes) };
}

/**
 * Why a body runs a file this read did not cover, or undefined. A shell body
 * (any body whose shebang names no other interpreter) is parsed: a program
 * named by a path outside the system directories, a wrapper or interpreter
 * handed a path, or a construct the parser cannot decompose all count. A
 * bare variable as the program (`"$OMP"`) is allowed: the reviewer reads what
 * the body assigns it, and LOCAL_HANDOFF refuses a script-dir assignment.
 */
function bodyHandOff(body: string): string | undefined {
	const code = body
		.split("\n")
		.filter(line => !/^\s*#/u.test(line))
		.join("\n");
	if (LOCAL_HANDOFF.some(pattern => pattern.test(code))) return "runs another local file";
	// PATH written any way at all (`read PATH`, `printf -v PATH`, `PATH+=`):
	// later bare names would resolve where this check did not look. Reading
	// `$PATH` or `${PATH}` is fine.
	if (/(?<![$\w{])(?:PATH|BASH_ENV|ENV|CDPATH)\b|\$\{(?:PATH|BASH_ENV|ENV|CDPATH):?=/u.test(code)) return "changes PATH or what a shell loads";
	const shebang = body.startsWith("#!") ? body.split("\n", 1)[0] : "";
	if (shebang !== "" && !/\b(?:ba|z|da|k)?sh\b/u.test(shebang)) return undefined;
	const parsed = parseShell(body);
	if (!parsed.ok) return "its shell body could not be parsed";
	for (const command of parsed.commands) {
		if (command.unreadShape !== undefined) return `a shell construct the gate cannot read (${command.unreadShape})`;
		const program = command.words[0]?.value ?? "";
		const name = verbName(command);
		const names = programNames(command);
		if (isPathWord(program) && !isSystemProgram(program)) return `runs ${program}`;
		// An interpreter or `source` in a body runs code this read did not cover,
		// whatever carries it: a file, a bare name, stdin, a pipe, a here-document
		// or `-c` text. Each of those was a bypass in turn, so none is allowed.
		if (names.some(n => n === "source" || n === "." || INTERPRETERS.test(n))) return `${name} runs code the gate did not read`;
		// A wrapper starts another program (`timeout 30 bash x`), and `hash -p`,
		// `alias` or `enable` repoint a command name without touching PATH.
		if (names.some(n => WRAPPERS.has(n) || REPOINT_COMMANDS.has(n))) return `${name} runs or repoints another program`;
		if (names.some(n => PROGRAM_FILE_FLAG_TOOLS.has(n)) && command.words.some(word => /^(?:-f|--from-file|--file)(?:=|$)/u.test(word.value))) return `${name} runs a program file`;
		if (names.some(n => FILE_RUNNERS.has(n) && runnerRunsFile(n, command.words))) return `${name} runs a program file`;
	}
	return undefined;
}

/** Whether a file runner runs a program file: `bun x.ts`, `bun run ./x.js`,
 *  `bunx ./x`, `tsx x.ts`. `bun build x.ts` compiles, and `bun test`,
 *  `bun install` or `bun run <script>` run the repository's own tooling. */
function runnerRunsFile(name: string, words: readonly ShellWord[]): boolean {
	const operands = words.slice(1).map(word => word.value).filter(value => !value.startsWith("-"));
	const isFile = (value: string | undefined): boolean => value !== undefined && (isPathWord(value) || SCRIPT_EXTENSION.test(value));
	if (name === "tsx" || name === "ts-node") return operands.some(isFile);
	if (name !== "bun") return isFile(operands[0]);
	if (operands[0] === "run" || operands[0] === "x" || operands[0] === "exec") return isFile(operands[1]);
	return isFile(operands[0]);
}

/** Whether a command assigns or exports PATH, for itself or for what follows. */
function changesPath(command: ShellCommand): boolean {
	return (
		command.assigns.some(assign => assign.name === "PATH") ||
		(["export", "declare", "typeset", "readonly", "local", "set"].includes(verbName(command)) && command.words.some(word => /^PATH(?:\+)?=/u.test(word.value)))
	);
}

/** Shape A: why a command with no local program still cannot be reviewed, or undefined. */
function shapeARefusal(commands: readonly ShellCommand[]): string | undefined {
	for (const command of commands) {
		if (command.unreadShape !== undefined) return `a shell construct the gate cannot read (${command.unreadShape})`;
		const name = verbName(command);
		if (changesPath(command)) return "changes PATH";
		if (command.words.length === 0) continue;
		const program = command.words[0];
		if (!isLiteral(program)) return "the program is built at run time";
		if (!isPathWord(program.value) && pathHasRelativeEntry()) return "PATH has an empty or relative entry";
		const resolved = isPathWord(program.value) ? undefined : onPath(program.value);
		const names = programNames(command);
		if (names.some(n => WRAPPERS.has(n))) return `${name} runs another program`;
		if (names.some(n => INTERPRETERS.test(n))) return `${name} runs a program the gate does not read`;
		if (names.some(n => PROGRAM_FILE_FLAG_TOOLS.has(n)) && command.words.some(word => /^(?:-f|--from-file|--file)(?:=|$)/u.test(word.value))) return `${name} runs a program file`;
		if (names.some(n => FILE_RUNNERS.has(n) && runnerRunsFile(n, command.words))) return `${name} runs a program file`;
		// A script on a root-owned chain is a system program like any binary
		// there: macOS ships `cd` as /usr/bin/cd, a root-owned sh script.
		if (resolved !== undefined && isScriptFile(resolved) && !isSystemProgram(resolved)) return `${program.value} is a local script run by name`;
	}
	return undefined;
}

const TIMEOUTS = new Set(["timeout", "gtimeout"]);
const DURATION = /^\d+(?:\.\d+)?[smhd]?$/u;

/** How many words a leading `timeout <duration>` takes before the program it
 *  runs: 2, or 0 when there is none. Only that bare form counts, and only for
 *  a timeout binary on PATH: an option, a built duration, or a `timeout`
 *  script shadowing it is left for shapeARefusal to refuse. An empty or
 *  relative PATH entry also refuses: the shell resolves it from the command's
 *  own directory, after any `cd`, and onPath cannot see that file. */
function timeoutWords(command: ShellCommand): number {
	const [wrapper, duration] = command.words;
	if (command.words.length < 3 || !wrapper.fixed || !duration.fixed || !DURATION.test(duration.value)) return 0;
	if (pathHasRelativeEntry()) return 0;
	const resolved = TIMEOUTS.has(wrapper.value) ? onPath(wrapper.value) : undefined;
	if (resolved === undefined || isScriptFile(resolved)) return 0;
	return programNames(command).every(name => TIMEOUTS.has(name)) ? 2 : 0;
}

const COUNT = /^[+-]?\d+$/u;
const HEAD_TAIL_ARG = /^(?:-\d+|-[nc][+-]?\d+|-[qv]|--(?:lines|bytes)=[+-]?\d+)$/u;

/** tail/head arguments that only set a count: no word can name a file. */
function countsOnly(args: readonly string[]): boolean {
	for (let at = 0; at < args.length; at += 1) {
		if (HEAD_TAIL_ARG.test(args[at])) continue;
		if ((args[at] === "-n" || args[at] === "-c") && COUNT.test(args[at + 1] ?? "")) {
			at += 1;
			continue;
		}
		return false;
	}
	return true;
}

/** grep short options known to read stdin only, and those that take a value.
 *  Any other letter (`-f`, `-r`, `-R`, `-d`, `-D`, or one the gate does not
 *  know) refuses. */
const GREP_FLAG_LETTERS = new Set(["i", "y", "v", "n", "c", "o", "q", "s", "E", "F", "G", "w", "x", "h", "H", "l", "L", "b"]);
const GREP_VALUE_LETTERS = new Set(["e", "m", "A", "B", "C"]);
/** grep long options read stdin only when spelled out in full from this list:
 *  getopt_long takes a unique prefix, so `--rec` is `--recursive`. */
const GREP_LONG_ALLOWED = /^--(?:ignore-case|invert-match|count|line-number|only-matching|quiet|silent|no-messages|extended-regexp|fixed-strings|basic-regexp|word-regexp|line-regexp|colou?r(?:=(?:never|always|auto))?|(?:max-count|after-context|before-context|context)=\d+)$/u;

/** One short-option cluster: undefined when it reads a file, else whether
 *  the next word is its value and whether that value is a pattern. */
function grepCluster(cluster: string): { next: boolean; pattern: boolean } | undefined {
	for (let at = 0; at < cluster.length; at += 1) {
		const letter = cluster[at];
		if (GREP_VALUE_LETTERS.has(letter)) return { next: at === cluster.length - 1, pattern: letter === "e" };
		if (!GREP_FLAG_LETTERS.has(letter)) return undefined;
	}
	return { next: false, pattern: false };
}

/** grep arguments that search stdin only: one pattern, and no file operand. */
function grepsStdinOnly(args: readonly string[]): boolean {
	let operands = 0;
	let patterns = 0;
	for (let at = 0; at < args.length; at += 1) {
		const arg = args[at];
		if (arg.startsWith("--")) {
			if (arg.startsWith("--regexp=")) patterns += 1;
			else if (!GREP_LONG_ALLOWED.test(arg)) return false;
			continue;
		}
		if (!arg.startsWith("-") || arg === "-") {
			operands += 1;
			continue;
		}
		const cluster = grepCluster(arg.slice(1));
		if (cluster === undefined) return false;
		if (cluster.next) at += 1;
		if (cluster.pattern) patterns += 1;
	}
	return patterns > 0 ? operands === 0 : operands === 1;
}

/** The filters a script's output may be piped into, each with the arguments
 *  that keep it reading the pipe and nothing else. */
const OUTPUT_FILTERS: Record<string, (args: readonly string[]) => boolean> = {
	tail: countsOnly,
	head: countsOnly,
	grep: grepsStdinOnly,
	cat: args => args.every(arg => /^-[benstuv]+$/u.test(arg)),
};

/** Whether `command` is a system output filter reading the pipe it is on:
 *  `./x.sh | tail -60` runs what x.sh runs and prints part of it. */
function isOutputFilter(command: ShellCommand): boolean {
	if (command.join !== "pipe" || command.nested || command.negated || command.unreadShape !== undefined) return false;
	if (command.assigns.length > 0 || command.redirects.length > 0 || !command.words.every(isLiteral)) return false;
	const name = command.words[0]?.value ?? "";
	const filter = Object.hasOwn(OUTPUT_FILTERS, name) ? OUTPUT_FILTERS[name] : undefined;
	if (filter === undefined || pathHasRelativeEntry()) return false;
	const resolved = onPath(name);
	return resolved !== undefined && isSystemProgram(resolved) && filter(command.words.slice(1).map(word => word.value));
}

/** `command` with a trailing output filter cut off, so `./x.sh | tail -60`
 *  and `./x.sh` name one action. Any other command comes back unchanged. */
export function withoutOutputFilter(command: string): string {
	const parsed = parseShell(command);
	if (!parsed.ok || parsed.commands.length < 2) return command;
	const last = parsed.commands[parsed.commands.length - 1];
	if (last.sourceOffset === undefined || !isOutputFilter(last)) return command;
	return command.slice(0, last.sourceOffset).replace(/\|&?\s*$/u, "").trimEnd();
}

/**
 * What the gate can show the reviewer about the programs `command` runs,
 * starting from `startCwd` (the directory before any `cd` in the command).
 * `{scripts: []}` is shape A, one script is shape B, and anything else is a
 * refusal that keeps the stage-1 block.
 */
export function scriptsForReview(command: string, startCwd: string): CommandScripts {
	const parsed = parseShell(command);
	if (!parsed.ok) return refuse("the command could not be parsed");
	const commands = parsed.commands;
	const programWord = (item: ShellCommand): string => item.words[timeoutWords(item)]?.value ?? "";
	const runsLocalPath = commands.some(item => isPathWord(programWord(item)) && !isSystemProgram(programWord(item)));
	if (!runsLocalPath) {
		const why = shapeARefusal(commands);
		return why === undefined ? { kind: "scripts", scripts: [] } : refuse(why);
	}
	// Shape B: [cd <literal> &&] [timeout <duration>] <literal path> <literal args> [| <output filter>], and nothing else.
	let dir = startCwd;
	let rest = commands.length > 1 && isOutputFilter(commands[commands.length - 1]) ? commands.slice(0, -1) : commands;
	if (rest.length === 2 && verbName(rest[0]) === "cd" && rest[1].join === "and") {
		const cd = rest[0];
		if (cd.words.length !== 2 || !cd.words[1].fixed || cd.assigns.length > 0 || cd.redirects.length > 0) return refuse("the cd before the script is not one literal directory");
		dir = path.resolve(startCwd, expandHome(cd.words[1].value));
		rest = rest.slice(1);
	}
	if (rest.length !== 1) return refuse("a local script runs inside a compound command");
	const run = rest[0];
	if (run.nested || run.negated || run.unreadShape !== undefined) return refuse("the script runs inside a construct the gate cannot read");
	if (run.assigns.length > 0) return refuse("the script runs with an assignment");
	if (!run.words.every(isLiteral)) return refuse("the script's words are built at run time");
	if (run.redirects.some(redirect => redirect.direction !== "out" && !redirect.duplicate)) return refuse("the script reads a redirect");
	const spelled = programWord(run);
	const file = path.resolve(dir, expandHome(spelled));
	if (!fs.existsSync(file)) return refuse(`${spelled} does not exist yet`);
	const read = readScriptForReview(spelled, file);
	if (read.body === null) return refuse(`${spelled}: ${read.unread ?? "not read"}`);
	return { kind: "scripts", scripts: [read] };
}

/** Whether every body still has the bytes the reviewer was shown, at the
 *  path the command names: the link is resolved again, so a swapped symlink
 *  that now points elsewhere counts as a change. */
export function scriptsUnchanged(scripts: readonly ReadScript[]): boolean {
	return scripts.every(script => {
		if (script.file === undefined || script.realPath === undefined || script.sha256 === undefined) return false;
		try {
			if (fs.realpathSync(script.file) !== script.realPath) return false;
			return sha256(fs.readFileSync(script.realPath)) === script.sha256;
		} catch {
			return false;
		}
	});
}

/**
 * The reviewer's blocks, per session: one key per action, working directory,
 * model and the user's words. A retry under the same words is blocked without
 * a call, so a reworded command cannot resample the reviewer, and a new user
 * message re-opens the review.
 */
const reviewerBlocks = new Map<string, Set<string>>();
const REVIEWER_BLOCK_CAP = 200;

export function reviewerBlockKey(target: string, cwd: string, model: string, userWords: readonly string[]): string {
	return createHash("sha256").update(JSON.stringify([target, cwd, model, userWords])).digest("hex");
}

export function reviewerBlocked(sessionId: string, key: string): boolean {
	return reviewerBlocks.get(sessionId)?.has(key) === true;
}

export function rememberReviewerBlock(sessionId: string, key: string): void {
	const blocks = reviewerBlocks.get(sessionId) ?? new Set<string>();
	blocks.add(key);
	if (blocks.size > REVIEWER_BLOCK_CAP) {
		const oldest = blocks.values().next().value;
		if (oldest !== undefined) blocks.delete(oldest);
	}
	reviewerBlocks.set(sessionId, blocks);
}

export function forgetReviewerBlocks(sessionId: string): void {
	reviewerBlocks.delete(sessionId);
}
