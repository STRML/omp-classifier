/**
 * What the built-in critical patterns are run over.
 *
 * `CRITICAL_BASH_PATTERNS` are regexes over text. The host runs them over the
 * raw command (tools/bash.ts, the `criticalCommand` check), and a hit there
 * returns `override` with no policy, which `yolo` drops. So the gate runs them
 * too, and a gate hit is a refusal that never yields for the session.
 *
 * Over the raw text, the patterns also match data: a commit message that says
 * "reboot", or a test file whose fixture strings read `rm -rf /`. This module
 * narrows what they read in two ways, and neither strips text with a regex.
 *
 * 1. The raw command. When the whole command is a plain chain of `git add`,
 *    `git commit`, `git log` and `git status`, the parser names the
 *    `git commit` message words and those spans are blanked in place. Every
 *    other byte is scanned exactly as before. Every word must reach git as
 *    written, every flag must be on a short allowlist, and the session's shell
 *    must be one no earlier call could have changed. Any other shape, and any
 *    parse failure, scans the whole text.
 * 2. Spliced script bodies (issue #67). The host never reads them, so this
 *    scan is coverage the gate adds on its own. A body the shell runs keeps
 *    the critical refusal. A JavaScript or Python body's hit refuses, with no
 *    refusal record, when the body names a process API. Otherwise it goes to
 *    the judge with the hit named in its state, as a risk flag a SAFE alone
 *    cannot release.
 */
import { CRITICAL_BASH_PATTERNS } from "@oh-my-pi/pi-coding-agent/tools/bash";
import { parseShell, type ShellCommand, type ShellRedirect, type ShellWord, shellRunsInSourceOrder } from "./shell-ast";

export function matchesCriticalPattern(text: string): boolean {
	return CRITICAL_BASH_PATTERNS.some(pattern => pattern.test(text));
}

/** The flags one git subcommand may carry. Any other word that starts with
 *  `-` ends the blanking: `git log --output=<file>` writes a file, and
 *  `git commit -e` opens an editor. Positional words are paths and refs. */
interface FlagSpec {
	/** Flags that take no value. */
	bare: ReadonlySet<string>;
	/** Flags whose value is the next word. */
	value: ReadonlySet<string>;
	/** `--flag=` spellings whose value is attached. */
	attached: readonly string[];
	/** Other whole-word shapes (short clusters, `-5`). */
	shapes: readonly RegExp[];
}

const set = (...items: string[]): ReadonlySet<string> => new Set(items);

/** The only git subcommands a blanked chain may hold. An unknown subcommand
 *  may be an alias, and `!`-aliases are shell commands. */
const GIT_FLAGS: Readonly<Record<string, FlagSpec>> = {
	commit: {
		bare: set("-a", "--all", "-q", "--quiet", "-s", "--signoff", "-v", "--verbose", "--amend", "--no-edit", "--no-verify", "-n", "--allow-empty"),
		value: set("-m", "--message"),
		attached: ["--message="],
		// `-am`, `-qm`, `-mtext`, and boolean clusters such as `-aq`.
		shapes: [/^-[aqsvn]*m/u, /^-[aqsvn]+$/u],
	},
	add: { bare: set("-A", "--all", "-u", "--update", "-v", "--verbose"), value: set(), attached: [], shapes: [] },
	log: {
		bare: set("--oneline", "--stat", "--graph", "--decorate", "--no-decorate", "--name-only", "--name-status", "--no-patch", "-s", "--reverse", "--first-parent"),
		value: set("-n"),
		attached: ["--format=", "--pretty=", "--max-count="],
		shapes: [/^-\d+$/u],
	},
	status: { bare: set("-s", "--short", "-b", "--branch", "-sb", "--porcelain"), value: set(), attached: [], shapes: [] },
};

/** git options allowed before the subcommand. `-c`, `--config-env` and
 *  `--exec-path` are absent on purpose: `core.editor`, `core.sshCommand` and
 *  `alias.*` values execute. */
const GIT_GLOBAL_FLAGS: ReadonlySet<string> = set("--no-pager", "-P", "--no-optional-locks");

/** Where a git command's own argv starts after its subcommand, or -1. */
function gitSubcommandIndex(words: readonly ShellWord[]): number {
	let index = 1;
	while (index < words.length && words[index].value.startsWith("-")) {
		const flag = words[index].value;
		if (flag === "-C") index += 2;
		else if (GIT_GLOBAL_FLAGS.has(flag)) index += 1;
		else return -1;
	}
	const sub = words[index];
	return sub !== undefined && Object.hasOwn(GIT_FLAGS, sub.value) ? index : -1;
}

/** Whether every flag from `start` on is one the spec names. */
function flagsAllowed(words: readonly ShellWord[], start: number, spec: FlagSpec): boolean {
	for (let index = start; index < words.length; index++) {
		const flag = words[index].value;
		if (!flag.startsWith("-") || flag === "-") continue;
		if (flag === "--") return true;
		if (spec.value.has(flag)) index += 1;
		else if (!spec.bare.has(flag) && !spec.attached.some(prefix => flag.startsWith(prefix)) && !spec.shapes.some(shape => shape.test(flag))) return false;
	}
	return true;
}

/** A redirect that writes no file: `2>&1`, `>&2`, `>/dev/null`. The host
 *  keeps one shell per session, so any other descriptor may still be open on
 *  a file or a process from an earlier call. */
function isInertRedirect(redirect: ShellRedirect): boolean {
	if (redirect.here || !redirect.target.fixed) return false;
	if (redirect.duplicate) return ["", "1", "2"].includes(redirect.fd) && ["1", "2"].includes(redirect.target.value);
	return redirect.direction === "out" && redirect.target.value === "/dev/null";
}

/** A git command this module reads: every word reaches git as written (no
 *  expansion, substitution, glob or brace, so `{--output=x,-1}` cannot become
 *  a flag), an allowed subcommand, allowed flags, no env prefix. */
function isPlainGit(command: ShellCommand): boolean {
	if (command.nested || command.unreadShape !== undefined || command.expression !== undefined) return false;
	if (command.assigns.length > 0 || command.words.length === 0) return false;
	if (!command.words.every(word => word.fixed)) return false;
	if (!command.redirects.every(isInertRedirect)) return false;
	if (command.words[0].value !== "git") return false;
	const sub = gitSubcommandIndex(command.words);
	return sub !== -1 && flagsAllowed(command.words, sub + 1, GIT_FLAGS[command.words[sub].value]);
}

/** The message words of a `git commit`, in a command `isPlainGit` accepted. */
function commitMessageWords(command: ShellCommand): ShellWord[] {
	const { words } = command;
	const sub = gitSubcommandIndex(words);
	if (words[sub].value !== "commit") return [];
	const spans: ShellWord[] = [];
	for (let index = sub + 1; index < words.length; index++) {
		const value = words[index].value;
		if (value === "--") break;
		if (value === "-m" || value === "--message") {
			if (words[index + 1] !== undefined) spans.push(words[index + 1]);
			index += 1;
		} else if (value.startsWith("--message=")) {
			spans.push(words[index]);
		} else if (/^-[aqsvn]*m/u.test(value)) {
			// `-am "text"` takes the next word; `-amtext` carries it attached.
			if (value.endsWith("m")) {
				if (words[index + 1] !== undefined) spans.push(words[index + 1]);
				index += 1;
			} else {
				spans.push(words[index]);
			}
		}
	}
	return spans;
}

/**
 * The raw command with its commit message words blanked to spaces, the same
 * length as the input so every other byte keeps its place. Returns the input
 * unchanged whenever any guard fails: that is the full scan.
 *
 * `shellTrusted` false skips blanking outright. The host keeps one shell per
 * session, so once an earlier call may have defined a function, an alias or a
 * hashed path, `git` need not be git.
 */
export function criticalScanText(command: string, shellTrusted = true): string {
	if (!shellTrusted) return command;
	// Only a gate on doing work: a false hit here costs a parse, never a byte of the scan.
	if (!command.includes("commit")) return command;
	const parsed = parseShell(command);
	if (!parsed.ok || parsed.commands.length === 0) return command;
	if (!shellRunsInSourceOrder(command)) return command;
	if (!parsed.commands.every(isPlainGit)) return command;
	const spans = parsed.commands.flatMap(commitMessageWords);
	// Word offsets are UTF-16 string indexes (shell-ast converts the parser's
	// byte offsets), and split("") indexes by UTF-16 unit too.
	const out = command.split("");
	for (const span of spans) {
		const start = span.offset;
		if (start === undefined) return command;
		const end = start + span.source.length;
		if (command.slice(start, end) !== span.source) return command;
		for (let index = start; index < end; index++) out[index] = " ";
	}
	return out.join("");
}

export function commandMatchesCriticalPattern(command: string, shellTrusted = true): boolean {
	return matchesCriticalPattern(criticalScanText(command, shellTrusted)) || redirectTargetMatches(command);
}

/**
 * The shell removes quotes before it opens a redirect target, so
 * `echo x > "/etc/passwd"` writes the file the unquoted pattern names, but the
 * raw text puts a quote between `>` and the path. Each file redirect is
 * rendered as `> <target as the shell reads it>` and scanned on its own. Only
 * redirect targets are dequoted: an argument such as `echo "rm -rf /"` is data
 * the shell prints, and dequoting it would turn every quoted mention into a
 * refusal that never yields. A target with an expansion is left to the raw
 * scan and the judge, as before.
 */
/** `>&2` and `>&-` duplicate or close a descriptor. bash reads any other
 *  `>&word` as `&>word`, a write to that file, whatever the parser calls it. */
const namesDescriptor = (redirect: ShellRedirect): boolean => redirect.duplicate && redirect.target.fixed && /^(?:\d+|-)$/u.test(redirect.target.value);

function redirectTargetMatches(command: string): boolean {
	if (!command.includes(">")) return false;
	const parsed = parseShell(command);
	if (!parsed.ok) return false;
	return parsed.commands.some(entry =>
		entry.redirects.some(redirect => redirect.direction !== "in" && !redirect.here && !namesDescriptor(redirect) && matchesCriticalPattern(`> ${redirect.target.value}`)),
	);
}

export interface CriticalScanBody {
	verb: string;
	operand: string;
	body: string;
}

export interface CriticalScan {
	/** The raw command, or a body the shell runs, matched: refuse and record. */
	critical: boolean;
	/** A JavaScript or Python body matched and names a process API: refuse,
	 *  but record nothing. The scan is a pure function of the file, so the
	 *  same body refuses on every retry; a record would only keep refusing
	 *  the target after the file changes. */
	unrecorded: boolean;
	/** Non-shell bodies that matched, as `<verb> runs <operand>`: judged, with
	 *  the hit named in the judge's state. */
	judgedBodies: string[];
}

/** Interpreters whose program is not shell text. */
const NON_SHELL_VERB = /^(?:node|nodejs|bun|deno|python(?:\d+(?:\.\d+)*)?)$/u;
const SHELL_EXTENSION = /\.(?:sh|bash|zsh|fish|dash|ksh)$/iu;
const SHELL_SHEBANG = /^#!.*\b(?:sh|bash|zsh|fish|dash|ksh|ash|mksh)\b/u;

/** A body the shell does not run: a JavaScript or Python interpreter, an
 *  operand that is not named as a shell script, and no shell shebang. Any
 *  doubt reads as shell. */
function isNonShellBody(body: CriticalScanBody): boolean {
	const verb = body.verb.split("/").pop() ?? body.verb;
	if (!NON_SHELL_VERB.test(verb)) return false;
	if (SHELL_EXTENSION.test(body.operand)) return false;
	const firstLine = body.body.split("\n", 1)[0] ?? "";
	return !SHELL_SHEBANG.test(firstLine);
}

/**
 * Any name through which JavaScript or Python code can start a process or run
 * code it builds at runtime. This is a detector, not a filter: it never cuts
 * text, and a hit only makes the call stricter. Comments and strings count,
 * because nothing here can tell them apart without a parser for the language,
 * so a fixture string that names `child_process` refuses too.
 */
const PROCESS_API =
	/child_process|\bBun\s*\.\s*(?:\$|spawn|spawnSync)\b|\$`|\bspawn(?:Sync)?\s*\(|\bexec(?:Sync|File|FileSync|a)?\s*\(|\bexeca\b|\bshelljs\b|\bzx\b|\bDeno\s*\.\s*(?:Command|run)\b|\bos\s*\.\s*(?:system|popen|exec\w*|spawn\w*|posix_spawn\w*)\b|\bsubprocess\b|\bpty\b|\bctypes\b|\bimportlib\b|__import__|\beval\s*\(|\bFunction\s*\(|\bimport\s*\(/u;

export function scanCriticalPatterns(command: string, bodies: readonly CriticalScanBody[], shellTrusted: boolean): CriticalScan {
	let critical = commandMatchesCriticalPattern(command, shellTrusted);
	let unrecorded = false;
	const judgedBodies: string[] = [];
	for (const body of bodies) {
		if (!matchesCriticalPattern(body.body)) continue;
		if (!isNonShellBody(body)) critical = true;
		else if (PROCESS_API.test(body.body)) unrecorded = true;
		else judgedBodies.push(`${body.verb} runs ${body.operand}`);
	}
	return { critical, unrecorded: unrecorded && !critical, judgedBodies };
}

/** The judge's state note for a non-shell body hit. */
export const CRITICAL_BODY_NOTE =
	"A built-in dangerous-command pattern matched inside these script bodies. They are JavaScript or Python, not shell. " +
	"The gate found no process API named in them, but code can still reach one through dynamic access, so this is no " +
	"evidence the code cannot start a process. Judge whether the code can execute the matching text or only carries it " +
	"as data, such as a test fixture string.";
