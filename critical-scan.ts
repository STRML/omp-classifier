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
 * 1. The raw command. The parser names the word operands that are message
 *    text for `git commit` and `gh pr|issue`, and those spans are blanked in
 *    place. Every other byte is scanned exactly as before. Blanking happens
 *    only when every command in the parse comes from a small set of verbs
 *    that cannot execute text, with no env prefix, no redirect that writes a
 *    file, and nothing run out of source order. Any other shape, and any
 *    parse failure, scans the whole text.
 * 2. Spliced script bodies (issue #67). The host never reads them, so this
 *    scan is coverage the gate adds on its own. A body the shell runs keeps
 *    the critical refusal. A JavaScript or Python body's hit refuses, with no
 *    refusal record, when the body names a process API. Otherwise it goes to
 *    the judge with the hit named in its state.
 */
import { CRITICAL_BASH_PATTERNS } from "@oh-my-pi/pi-coding-agent/tools/bash";
import { parseShell, type ShellCommand, type ShellRedirect, type ShellWord, shellRunsInSourceOrder } from "./shell-ast";

export function matchesCriticalPattern(text: string): boolean {
	return CRITICAL_BASH_PATTERNS.some(pattern => pattern.test(text));
}

/** Verbs that read or print and never execute their input. A chain made only
 *  of these, plus allowed `git` and `gh` invocations, cannot run the message
 *  text it carries: no shell, `eval`, `xargs`, interpreter, `sudo` or
 *  wrapper, and no unknown program that might be one. `printf` is absent
 *  because `printf -v NAME` assigns a variable the persistent session shell
 *  keeps. `cd` stays: it moves the directory and carries no text. */
const INERT_VERBS: ReadonlySet<string> = new Set(["cat", "echo", "head", "tail", "wc", "grep", "ls", "pwd", "cd", "true"]);

/** The flags an allowed invocation may carry. Any other word that starts with
 *  `-` (before a `--`) ends the blanking: `git log --output=<file>` writes a
 *  file, `git push --receive-pack=<cmd>` names a program, `gh pr create -e`
 *  opens an editor. Positional words are operands (paths, refs, numbers). */
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

/** git subcommands, each with the flags it may carry. An unknown subcommand
 *  may be an alias, and `!`-aliases are shell commands. */
const GIT_FLAGS: Readonly<Record<string, FlagSpec>> = {
	commit: {
		bare: set("-a", "--all", "-q", "--quiet", "-s", "--signoff", "-v", "--verbose", "--amend", "--no-edit", "--no-verify", "-n", "--allow-empty", "--allow-empty-message"),
		value: set("-m", "--message", "-F", "--file"),
		attached: ["--message=", "--file="],
		// `-am`, `-qm`, `-mtext`, `-F-`, and boolean clusters such as `-aq`.
		shapes: [/^-[aqsvn]*m/u, /^-[aqsvn]+$/u, /^-F-$/u],
	},
	add: { bare: set("-A", "--all", "-u", "--update", "-v", "--verbose", "-N", "--intent-to-add"), value: set(), attached: [], shapes: [] },
	log: {
		bare: set("--oneline", "--stat", "--graph", "--decorate", "--no-decorate", "--name-only", "--name-status", "--no-patch", "-s", "--reverse", "--first-parent"),
		value: set("-n"),
		attached: ["--format=", "--pretty=", "--max-count=", "--since=", "--until="],
		shapes: [/^-\d+$/u],
	},
	status: { bare: set("-s", "--short", "-b", "--branch", "-sb", "--porcelain"), value: set(), attached: [], shapes: [] },
	push: { bare: set("-u", "--set-upstream", "-q", "--quiet", "--force-with-lease"), value: set(), attached: ["--force-with-lease="], shapes: [] },
	"rev-parse": { bare: set("--short", "--abbrev-ref", "--show-toplevel", "--git-dir"), value: set(), attached: ["--short="], shapes: [] },
};

/** `gh pr|issue create|edit|comment`, and the flags they may carry. `--web`
 *  and `--editor` are absent: both start another program. */
const GH_GROUPS: ReadonlySet<string> = set("pr", "issue");
const GH_ACTIONS: ReadonlySet<string> = set("create", "edit", "comment");
const GH_FLAGS: FlagSpec = {
	bare: set("--draft", "-d", "--fill", "--fill-first", "--fill-verbose"),
	value: set(
		"-b", "--body", "-t", "--title", "-F", "--body-file", "-B", "--base", "-H", "--head", "-R", "--repo",
		"-l", "--label", "-a", "--assignee", "-r", "--reviewer", "-m", "--milestone",
		"--add-label", "--remove-label", "--add-assignee", "--remove-assignee", "--add-reviewer", "--remove-reviewer",
	),
	attached: ["--body=", "--title=", "--body-file=", "--base=", "--head=", "--repo=", "--label="],
	shapes: [/^-[bt]./u],
};

/** git options allowed before the subcommand. `-c`, `--config-env` and
 *  `--exec-path` are absent on purpose: `core.editor`, `core.sshCommand` and
 *  `alias.*` values execute. */
const GIT_GLOBAL_FLAGS: ReadonlySet<string> = set("--no-pager", "-P", "--no-optional-locks");

/** Whether every flag from `start` on is one the spec names. */
function flagsAllowed(words: readonly ShellWord[], start: number, spec: FlagSpec): boolean {
	for (let index = start; index < words.length; index++) {
		const word = words[index];
		// Every word must reach the program as written. An expansion, a glob
		// or a brace (`{--output=x,-1}`, `--outp*`) can turn one word into a
		// flag this list never saw, or into several words.
		if (!word.fixed) return false;
		const flag = word.value;
		if (!flag.startsWith("-") || flag === "-") continue;
		if (flag === "--") return words.slice(index + 1).every(rest => rest.fixed);
		if (spec.value.has(flag)) {
			index += 1;
			// A flag's value is one word too. The one non-literal value read is
			// a message spelled as a quoted `"$(cat <<'EOF' … EOF)"`.
			const value = words[index];
			if (value !== undefined && !value.fixed && !isQuotedCatHeredoc(value)) return false;
		} else if (!spec.bare.has(flag) && !spec.attached.some(prefix => flag.startsWith(prefix)) && !spec.shapes.some(shape => shape.test(flag))) return false;
	}
	return true;
}

/** `"$(cat <<'EOF' … EOF)"` as one double-quoted word: quoted, so it stays
 *  one word, and its only command prints a literal heredoc. */
function isQuotedCatHeredoc(word: ShellWord): boolean {
	return word.source.startsWith('"$(') && word.source.endsWith(')"') && catHeredocData(word) !== undefined;
}

/** Where a git command's own argv starts after its subcommand, or -1 when
 *  the command is not one this module reads. */
function gitSubcommandIndex(words: readonly ShellWord[]): number {
	let index = 1;
	while (index < words.length && words[index].value.startsWith("-")) {
		const flag = words[index].value;
		if (!words[index].fixed) return -1;
		if (flag === "-C") {
			if (words[index + 1]?.fixed !== true) return -1;
			index += 2;
		} else if (GIT_GLOBAL_FLAGS.has(flag)) index += 1;
		else return -1;
	}
	const sub = words[index];
	return sub !== undefined && sub.fixed && Object.hasOwn(GIT_FLAGS, sub.value) ? index : -1;
}

function isAllowedGit(words: readonly ShellWord[]): boolean {
	const sub = gitSubcommandIndex(words);
	return sub !== -1 && flagsAllowed(words, sub + 1, GIT_FLAGS[words[sub].value]);
}

function isGhMessageCommand(words: readonly ShellWord[]): boolean {
	return words.length >= 3 && words[1].fixed && words[2].fixed && GH_GROUPS.has(words[1].value) && GH_ACTIONS.has(words[2].value);
}

/** A redirect that writes no file and starts no program. Writing a file is
 *  how carried text becomes a later program (`> .git/hooks/pre-push`). A
 *  duplicate may only join stdout and stderr: the host keeps one shell per
 *  session, so a descriptor such as 3 can still be open on a file or a
 *  process from an earlier call. */
function isInertRedirect(redirect: ShellRedirect): boolean {
	if (redirect.here) return true;
	if (!redirect.target.literal) return false;
	if (redirect.duplicate) return ["", "1", "2"].includes(redirect.fd) && ["1", "2", "-"].includes(redirect.target.value);
	if (redirect.direction === "in") return true;
	return redirect.direction === "out" && redirect.target.value === "/dev/null";
}

function isInertCommand(command: ShellCommand): boolean {
	if (command.unreadShape !== undefined || command.expression !== undefined) return false;
	if (command.assigns.length > 0 || command.words.length === 0) return false;
	if (!command.redirects.every(isInertRedirect)) return false;
	const verb = command.words[0];
	if (!verb.literal || !verb.fixed) return false;
	if (INERT_VERBS.has(verb.value)) return true;
	if (verb.value === "git") return isAllowedGit(command.words);
	if (verb.value === "gh") return isGhMessageCommand(command.words) && flagsAllowed(command.words, 3, GH_FLAGS);
	return false;
}

/** The text a here-document or here-string hands its command, when that text
 *  expands nothing. An unquoted heredoc that substitutes runs code. */
function hereData(redirect: ShellRedirect): ShellWord | undefined {
	if (!redirect.here) return undefined;
	const data = redirect.body ?? redirect.target;
	return data.literal ? data : undefined;
}

/** The spans of a message operand: the word itself when it is literal, or the
 *  heredoc body of `"$(cat <<'EOF' … EOF)"`, the one substitution whose only
 *  output is literal text. */
function messageSpans(word: ShellWord | undefined): ShellWord[] {
	if (word === undefined) return [];
	if (word.fixed) return [word];
	const data = isQuotedCatHeredoc(word) ? catHeredocData(word) : undefined;
	return data === undefined ? [] : [data];
}

/** The heredoc a `$(cat <<EOF … EOF)` word prints, when that is all it runs. */
function catHeredocData(word: ShellWord): ShellWord | undefined {
	if (word.commands.length !== 1) return undefined;
	const [inner] = word.commands;
	if (inner.assigns.length > 0 || inner.words.length !== 1 || inner.words[0].value !== "cat" || !inner.words[0].fixed) return undefined;
	if (inner.redirects.length !== 1) return undefined;
	return hereData(inner.redirects[0]);
}

/** Option grammar shared by the two message-carrying commands. */
interface MessageGrammar {
	/** Flags whose next word is message text. */
	message: ReadonlySet<string>;
	/** `--flag=` prefixes whose remainder is message text. */
	messagePrefix: readonly string[];
	/** Flags whose next word names a file to read the message from. */
	file: ReadonlySet<string>;
	/** Short flags that take no value and may cluster before a message flag. */
	boolean: string;
	/** Short flags whose attached remainder or next word is message text. */
	messageShort: string;
	/** Short flags that take a value (not message text). */
	valueShort: string;
	/** Long flags whose next word is a value (not message text). */
	valueLong: ReadonlySet<string>;
}

const GIT_COMMIT_GRAMMAR: MessageGrammar = {
	message: new Set(["-m", "--message"]),
	messagePrefix: ["--message="],
	file: new Set(["-F", "--file"]),
	boolean: "apzsneioqv",
	messageShort: "m",
	valueShort: "CcFtSu",
	valueLong: new Set(["--author", "--date", "--fixup", "--squash", "--trailer", "--cleanup", "--reuse-message", "--reedit-message", "--template", "--pathspec-from-file"]),
};

const GH_GRAMMAR: MessageGrammar = {
	message: new Set(["-b", "--body", "-t", "--title"]),
	messagePrefix: ["--body=", "--title="],
	file: new Set(["-F", "--body-file"]),
	boolean: "",
	messageShort: "bt",
	valueShort: "",
	valueLong: new Set(),
};

/** Read one argv against a grammar: the message spans it carries, and whether
 *  the message comes from stdin. */
function readMessageArgs(words: readonly ShellWord[], start: number, grammar: MessageGrammar): { spans: ShellWord[]; stdin: boolean } {
	const spans: ShellWord[] = [];
	let stdin = false;
	for (let index = start; index < words.length; index++) {
		const word = words[index];
		const value = word.value;
		if (!word.literal) continue;
		if (value === "--") break;
		if (grammar.message.has(value)) {
			spans.push(...messageSpans(words[index + 1]));
			index += 1;
			continue;
		}
		if (grammar.messagePrefix.some(prefix => value.startsWith(prefix))) {
			spans.push(word);
			continue;
		}
		if (grammar.file.has(value)) {
			if (words[index + 1]?.literal && words[index + 1].value === "-") stdin = true;
			index += 1;
			continue;
		}
		const eq = value.indexOf("=");
		if (value.startsWith("--") && eq !== -1 && grammar.file.has(value.slice(0, eq))) {
			if (value.slice(eq + 1) === "-") stdin = true;
			continue;
		}
		if (grammar.valueLong.has(value)) {
			index += 1;
			continue;
		}
		if (!/^-[A-Za-z]/u.test(value)) continue;
		for (let at = 1; at < value.length; at++) {
			const flag = value[at];
			if (grammar.boolean.includes(flag)) continue;
			const rest = value.slice(at + 1);
			if (grammar.messageShort.includes(flag)) {
				if (rest === "") {
					spans.push(...messageSpans(words[index + 1]));
					index += 1;
				} else {
					spans.push(word);
				}
			} else if (flag === "F") {
				if (rest === "-") stdin = true;
				else if (rest === "") {
					if (words[index + 1]?.literal && words[index + 1].value === "-") stdin = true;
					index += 1;
				}
			} else if (grammar.valueShort.includes(flag) && rest === "") {
				index += 1;
			}
			break;
		}
	}
	return { spans, stdin };
}

/** The data spans one top-level command carries. */
function commandDataSpans(command: ShellCommand): ShellWord[] {
	const { words } = command;
	let read: { spans: ShellWord[]; stdin: boolean } | undefined;
	if (words[0].value === "git") {
		const sub = gitSubcommandIndex(words);
		if (sub !== -1 && words[sub].value === "commit") read = readMessageArgs(words, sub + 1, GIT_COMMIT_GRAMMAR);
	} else if (words[0].value === "gh" && isGhMessageCommand(words)) {
		read = readMessageArgs(words, 3, GH_GRAMMAR);
	}
	if (read === undefined) return [];
	const spans = [...read.spans];
	if (read.stdin) {
		for (const redirect of command.redirects) {
			const data = hereData(redirect);
			if (data !== undefined) spans.push(data);
		}
	}
	return spans;
}

/**
 * The raw command with its message operands blanked to spaces, the same
 * length as the input so every other byte keeps its place. Returns the input
 * unchanged whenever any guard fails: that is today's full scan.
 *
 * `shellTrusted` false skips blanking outright. The host keeps one shell per
 * session, so once an earlier call may have defined a function, an alias or a
 * hashed path, `git` and `cat` need not be the programs this module reasons
 * about.
 */
export function criticalScanText(command: string, shellTrusted = true): string {
	if (!shellTrusted) return command;
	// Only a gate on doing work: a command naming neither verb has nothing to
	// blank, and a false hit here costs a parse, never a byte of the scan.
	if (!/\bgit\b|\bgh\b/u.test(command)) return command;
	const parsed = parseShell(command);
	if (!parsed.ok || parsed.commands.length === 0) return command;
	if (!shellRunsInSourceOrder(command)) return command;
	if (!parsed.commands.every(isInertCommand)) return command;
	const spans = parsed.commands.filter(candidate => !candidate.nested).flatMap(commandDataSpans);
	if (spans.length === 0) return command;
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
	return matchesCriticalPattern(criticalScanText(command, shellTrusted));
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
