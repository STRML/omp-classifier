/**
 * stage-two — what the gate measures for the stage 2 reviewer
 * (docs/plans/2026-10-27-stage-2-reviewer.md) and what it remembers about it.
 *
 * The reviewer reads the body of every script a command runs. This module
 * finds those scripts and reads them under the rules a model must not be
 * trusted to enforce: a secret path, a non-regular file, a binary, an oversized
 * file, or a script that hands off to another local file is reported unread,
 * and an unread body keeps the reviewer from running at all. Each body is
 * hashed when read, and `scriptsUnchanged` re-reads them before an allow
 * counts, so the reviewer's seconds-long wait is not a window to swap the file.
 *
 * Interpreter invocations (`python3 x.py`, `bash x.sh`) are not read here:
 * readInterpretedScriptBodies already splices their bodies into the judged
 * command, which is the text the reviewer is given.
 */
import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { isSecretPath } from "./floor";
import { REVIEWER_SCRIPT_MAX_BYTES, type ReviewerScriptBody } from "./reviewer";
import { parseShell, type ShellCommand } from "./shell-ast";
import { segmentCwdAt } from "./shell-cwd";

export interface ReadScript extends ReviewerScriptBody {
	/** The path the command names, resolved against its working directory but not through links. */
	file?: string;
	/** Where the body was read from, after links. */
	realPath?: string;
	sha256?: string;
}

/** Commands that run the word after them (and their own flags) as the program. */
const WRAPPERS = new Set(["env", "time", "nohup", "exec", "command", "nice", "caffeinate"]);
/** Interpreters whose script operand readInterpretedScriptBodies already reads. */
const INTERPRETERS = /^(?:bash|sh|zsh|dash|ksh|fish|python[\d.]*|node|bun|deno|ruby|perl|php|tclsh[\d.]*|lua|osascript)$/u;
const SCRIPT_EXTENSION = /\.(?:sh|bash|zsh|py|js|mjs|cjs|ts|rb|pl|tcl|lua)$/iu;
/**
 * A body that hands work to another local file is incomplete: the reviewer
 * would judge a wrapper and allow code nobody read. `source`/`.` of anything,
 * an interpreter run on a relative or script-dir path, and a script-dir path
 * to a program file all count. A false match only means no stage 2.
 */
const LOCAL_HANDOFF = [
	/(?:^|[;&|(`]|\s)(?:source|\.)\s+["']?(?:[./~$]|[\w-]+\/|[\w.-]+\.(?:sh|bash|zsh)\b)/mu,
	/(?:^|[\s;&|(`])(?:exec\s+)?(?:bash|sh|zsh|python3?|node|bun|ruby|perl)\s+(?:\.{1,2}\/|"?\$\{?(?:BASH_SOURCE|0\b|SCRIPT_DIR|DIR\b|HERE\b))/mu,
	/(?:^|[\s;&|(`])exec\s+(?:\.{1,2}\/|"?\$)/mu,
	/\$\(\s*dirname\b[^)]*\)"?\/[^\s"']+\.(?:sh|bash|py|js|mjs|ts|rb|pl)\b/u,
	// A relative program run as a statement's command: `./lib/real.sh`, `(../x)`.
	/(?:^|[;&|(`{]\s*|\bthen\s+|\bdo\s+|\belse\s+)["']?\.{1,2}\/[^\s"';&|]+/mu,
	// A variable that names a local script, ready to run as `"$VAR"`.
	/^\s*(?:local\s+|export\s+|readonly\s+)?[A-Za-z_]\w*=["']?(?:[^"'\s]*(?:BASH_SOURCE|\$\(\s*dirname|\$0\b)[^"'\s]*|\.{1,2}\/[^"'\s]*)\.(?:sh|bash|zsh|py|js|mjs|ts|rb|pl)\b/mu,
];
/** Commands that may run before a script in the same command line without being able to change it. */
const INERT_BEFORE_SCRIPT = new Set(["cd", "pushd", "pwd", "export", "set", "true", ":"]);

const sha256 = (bytes: Uint8Array): string => createHash("sha256").update(bytes).digest("hex");
const unread = (spelled: string, why: string): ReadScript => ({ path: spelled, body: null, unread: why });

/** A bare program name as the PATH resolves it, when that is a file under the home directory. */
function userProgramOnPath(name: string): string | undefined {
	const home = os.homedir();
	for (const dir of (process.env.PATH ?? "").split(path.delimiter)) {
		if (dir === "") continue;
		const candidate = path.join(dir, name);
		try {
			const stat = fs.statSync(candidate);
			if (!stat.isFile() || (stat.mode & 0o111) === 0) continue;
			const real = fs.realpathSync(candidate);
			return real.startsWith(`${home}${path.sep}`) ? candidate : undefined;
		} catch {
			// Not in this directory.
		}
	}
	return undefined;
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
	// Full-line comments are prose; a trailing comment is kept, since cutting at
	// a `#` inside a string could hide a hand-off after it.
	const code = body
		.split("\n")
		.filter(line => !/^\s*#/u.test(line))
		.join("\n");
	if (LOCAL_HANDOFF.some(pattern => pattern.test(code))) return unread(spelled, "sources or runs another local file");
	return { path: spelled, body, file, realPath: real, sha256: sha256(bytes) };
}

/** The program words of one parsed command: its verb past any wrappers, and any executable path argument (`xargs ./x`). */
function programWords(command: ShellCommand): Array<{ value: string; offset: number; verb: boolean }> {
	const words = command.words;
	let head = 0;
	while (head < words.length && WRAPPERS.has(path.basename(words[head].value))) {
		head++;
		while (head < words.length && (words[head].value.startsWith("-") || /^[A-Za-z_]\w*=/u.test(words[head].value))) head++;
	}
	const found: Array<{ value: string; offset: number; verb: boolean }> = [];
	if (head < words.length) found.push({ value: words[head].value, offset: words[head].offset ?? 0, verb: true });
	for (let index = head + 1; index < words.length; index++) {
		const value = words[index].value;
		if (/^(?:\.{1,2}\/|\/|~\/)/u.test(value)) found.push({ value, offset: words[index].offset ?? 0, verb: false });
	}
	return found;
}

/**
 * Every script the command runs directly, read for the reviewer, deduplicated
 * by real path. A command the parser cannot read, or a relative program whose
 * working directory the gate cannot pin, is reported unread.
 */
export function scriptsForReview(command: string, cwd: string): ReadScript[] {
	const parsed = parseShell(command);
	if (!parsed.ok) return [unread(command, "the command could not be parsed")];
	const home = os.homedir();
	const seen = new Map<string, ReadScript>();
	// Whether an earlier step of this command line could have written, checked
	// out, or replaced a script before it runs: the body read now would then not
	// be the program that runs.
	let writableBefore = false;
	for (const shellCommand of parsed.commands) {
		if (shellCommand.unreadShape !== undefined) return [unread(command, `the command has a shape the gate cannot read (${shellCommand.unreadShape})`)];
		const verb = shellCommand.words[0]?.value ?? "";
		const inert = INERT_BEFORE_SCRIPT.has(verb) && !shellCommand.redirects.some(redirect => redirect.direction !== "in");
		const priorWrites = writableBefore;
		if (!shellCommand.nested && !inert) writableBefore = true;
		for (const word of programWords(shellCommand)) {
			if (word.verb && INTERPRETERS.test(path.basename(word.value))) break;
			const expanded = word.value.startsWith("~/") ? path.join(home, word.value.slice(2)) : word.value;
			let file: string | undefined;
			if (!expanded.includes("/")) {
				if (!word.verb) continue;
				file = userProgramOnPath(expanded);
				if (file === undefined) continue;
			} else if (path.isAbsolute(expanded)) {
				file = expanded;
			} else {
				const dir = segmentCwdAt(command, word.offset, cwd);
				if (dir === null) {
					seen.set(`unpinned:${word.value}`, unread(word.value, "its working directory could not be pinned"));
					continue;
				}
				file = path.resolve(dir, expanded);
			}
			if (!word.verb) {
				// An argument counts only when it is an executable file: `xargs ./x`,
				// `find -exec ./x`. A data file the command reads is not a program.
				try {
					const stat = fs.statSync(file);
					if (!stat.isFile() || (stat.mode & 0o111) === 0) continue;
				} catch {
					continue;
				}
			} else if (!fs.existsSync(file)) {
				// A program that is not there runs nothing.
				continue;
			}
			if (priorWrites) {
				seen.set(`after-write:${file}`, unread(word.value, "runs after an earlier step of the same command that could change it"));
				continue;
			}
			const read = readScriptForReview(word.value, file);
			seen.set(read.realPath ?? `unread:${file}`, read);
		}
	}
	return [...seen.values()];
}

/** Whether every body still has the bytes the reviewer was shown, at the
 *  path the command names: the link is resolved again, so a swapped symlink
 *  that now points elsewhere counts as a change. */
export function scriptsUnchanged(scripts: readonly ReadScript[]): boolean {
	return scripts.every(script => {
		if (script.file === undefined || script.realPath === undefined || script.sha256 === undefined) return true;
		try {
			if (fs.realpathSync(script.file) !== script.realPath) return false;
			return sha256(fs.readFileSync(script.realPath)) === script.sha256;
		} catch {
			return false;
		}
	});
}

/**
 * The reviewer's blocks, per session: one key per target, working directory,
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
