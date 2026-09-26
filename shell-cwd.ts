/**
 * The text-level shell model two readers share: which text the shell actually
 * runs, and where each of its command segments runs.
 *
 * `shell-ast.ts` answers questions about a command through `mvdan-sh` and owns
 * that parser. This module answers the two text questions the gate needs before
 * an AST is even useful, and it owns no parser:
 *
 * 1. `maskHeredocBodiesAndAnsiSpans` — the text the shell reads as COMMANDS.
 *    A heredoc body is data, and an ANSI-C or unclosed quote span swallows the
 *    rest of a line-oriented scan, so both are blanked (length-preserving, so
 *    offsets still address the original command).
 * 2. `shellWalk` / `segmentWorkingDirectories` / `segmentCwdAt` — where each
 *    top-level segment runs. The join around a segment decides whether a `cd`
 *    reaches it, and a directory the text cannot pin is `null`, never a guess.
 *
 * Both readers used to answer question 2 for themselves, and both were wrong in
 * a spelling the other had already fixed: the script-body reader learned to
 * apply the command's own `cd` chain per segment while the network tier still
 * resolved a relative `--config` against the command's starting directory, and
 * the walk itself read heredoc body lines as commands unless the caller masked
 * them first. One implementation, one set of spellings, both readers.
 *
 * Why the walk resolves `cd` targets through a caller-supplied resolver: the
 * two readers resolve their own paths differently — the gate resolves a program
 * operand through the host's `resolveToCwd` (which knows internal URL schemes
 * and the workspace-root alias) while the network tier resolves a config path
 * with `node:path` — and a walk that silently substituted one convention for
 * the other would change what an operand resolves to. The resolver is the only
 * injected behavior; the walk itself is the same for both.
 */
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

/** A word carrying one of these is expanded by the shell before the reader
 *  ever sees it, so the path it names is not readable text. `{` and `[` are
 *  brace expansion and globs; a `$` or a backtick is a substitution. */
export const SHELL_WORD_EXPANSION = /[$`*?[\]{}]/u;

/**
 * Every `<<` in `command` the shell would read as a heredoc operator, with
 * the delimiter word after it. Delimiters are words: quote runs contribute
 * their contents, a backslash contributes the escaped character, and a shell
 * metacharacter or whitespace ends the word. Digit and punctuation starts
 * are legal (`cat <<123`, `cat <<.OUT`). A word the walk cannot finish —
 * one containing a command or parameter substitution like `$(printf OUT)`,
 * which bash takes literally — comes back with `delim: null`, and the walk
 * treats an unknown delimiter as covering to EOF, which only over-flags.
 */
function shadowOpeners(command: string): Array<{ index: number; bodyStart: number; tabs: boolean; delim: string | null }> {
	const openers: Array<{ index: number; bodyStart: number; tabs: boolean; delim: string | null }> = [];
	const re = /<<(-?)[ \t]*/gu;
	re.lastIndex = 0;
	let m: RegExpExecArray | null;
	while ((m = re.exec(command)) !== null) {
		let delim = "";
		let unknown = false;
		let i = m.index + m[0].length;
		for (; i < command.length; i++) {
			const ch = command[i];
			if (ch === "\\" && i + 1 < command.length) {
				delim += command[i + 1];
				i++;
				continue;
			}
			if (ch === "'" || ch === '"') {
				const close = command.indexOf(ch, i + 1);
				if (close === -1) break;
				delim += command.slice(i + 1, close);
				i = close;
				continue;
			}
			if (/[\s;|&<>]/u.test(ch)) break;
			if (ch === "(" || ch === ")" || ch === "$" || ch === "`") {
				// Substitution syntax in the word: bash reads it literally,
				// but this walk cannot know where the word ends, so no
				// closer line can be trusted.
				unknown = true;
				break;
			}
			delim += ch;
		}
		const bodyStart = command.indexOf("\n", i) + 1;
		if (bodyStart === 0) break;
		openers.push({
			index: m.index,
			bodyStart,
			tabs: m[1] === "-",
			delim: unknown || delim === "" ? null : delim.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&"),
		});
	}
	return openers;
}

/**
 * True when `at` sits inside the body of an earlier heredoc in `command`: an
 * owner line found there is data to the outer cat or tee, never a command of
 * its own. Every opener counts, not just the strip-shape owners, because an
 * unquoted outer delimiter expands its body before the outer command reads
 * it, so text the strip would delete can be live shell. The walk follows
 * shell body order: openers on one line consume consecutive bodies, an
 * opener inside a consumed body is data and opens nothing, and an
 * unterminated body covers to EOF. This only ever over-flags, because the
 * caller keeps the region under scan either way.
 */
export function heredocShadowedAt(command: string, at: number): boolean {
	const all = shadowOpeners(command);
	let cursor = 0;
	for (let i = 0; i < all.length; i++) {
		const op = all[i];
		if (op.bodyStart === 0) break;
		if (op.bodyStart > at) return false;
		if (op.index < cursor) continue;
		// A closer is the whole delimiter line, exact; `<<-` strips leading
		// tabs. Trailing whitespace disqualifies it here exactly as it does
		// for stripping, or `OUT ` would end a body the shell keeps reading.
		// Openers sharing a line consume consecutive bodies; a body with no
		// closer covers to EOF, which only ever over-flags.
		let edge = op.bodyStart;
		for (let j = i; j < all.length && all[j].bodyStart === op.bodyStart; j++) {
			const peer = all[j];
			// An unknown delimiter covers everything to EOF.
			if (peer.delim === null) return true;
			const closer = new RegExp(`^${peer.tabs ? "\\t*" : ""}${peer.delim}$`, "mu").exec(command.slice(edge));
			if (closer === null) return true;
			const line = edge + closer.index;
			const nl = command.indexOf("\n", line);
			edge = nl === -1 ? command.length : nl + 1;
		}
		cursor = edge;
		if (at < cursor) return true;
	}
	return false;
}

/**
 * Masked scan text for the risk-token matcher (issues #60, #61).
 *
 * `tokenizeShellSegments` models only `inSingle`/`inDouble`. Two shell
 * realities put it into a quote it never leaves, and everything after the
 * quote point disappears from every segment scan:
 *
 * 1. (#60) heredoc body text is DATA unless an unquoted delimiter expands
 *    it, so an unbalanced `"` inside a body swallows the closer and every
 *    later live command. Body boundaries are decidable from the delimiter
 *    alone, which `shadowOpeners` already computes; whether the body runs
 *    is NOT decidable and is not needed here.
 * 2. (#61) ANSI-C `$'...'` strings span lines and treat `\'` as an escaped
 *    quote. The plain `'` state machine closes at the first apostrophe, and
 *    the string's closing apostrophe then opens a phantom quote that eats
 *    the rest of the command.
 */
export interface MaskedScanText {
	masked: string;
	/** Heredoc body regions, scanned as their own units by the caller. */
	bodies: string[];
	/**
	 * Quote-span regions (`'...'`, `"..."`, `$'...'`) the tokenizer
	 * mis-reads, with the opening quote dropped so the recursion
	 * tokenizes the content as fresh text; the seen-set stops a repeat.
	 */
	quoted: string[];
}

export function maskHeredocBodiesAndAnsiSpans(command: string): MaskedScanText {
	const bodies: string[] = [];
	// 1. Heredoc bodies, in shell body order. Openers are reported on the
	// original text; one line's openers consume consecutive bodies, so an
	// opener whose body-start sits inside an already-consumed span is data
	// to an outer heredoc and opens nothing. An opener with no body start
	// (`<<EOF` ending the text) has no body at all. An UNKNOWN delimiter
	// covers to EOF: the whole tail moves to the isolated-body scan, which
	// only ever over-flags.
	const spans: Array<{ start: number; end: number }> = [];
	let cursor = 0;
	for (const op of shadowOpeners(command)) {
		if (op.bodyStart === 0) break;
		if (op.index < cursor) continue;
		if (op.delim === null) {
			spans.push({ start: op.bodyStart, end: command.length });
			bodies.push(command.slice(op.bodyStart));
			cursor = command.length;
			continue;
		}
		const closer = new RegExp(`^${op.tabs ? "\\t*" : ""}${op.delim}$`, "mu").exec(command.slice(op.bodyStart));
		const bodyEnd = closer === null ? command.length : op.bodyStart + closer.index;
		spans.push({ start: op.bodyStart, end: bodyEnd });
		bodies.push(command.slice(op.bodyStart, bodyEnd));
		cursor = bodyEnd;
	}
	// 2. Quote spans the tokenizer mis-READS, walked OUTSIDE the body
	// regions (quotes inside a body are body data; the isolated-body
	// recursion handles them):
	//   a. ANSI-C `$'...'` — `\'` escapes, so the plain loop closes early;
	//   b. a quote run crossed by a heredoc body — body bytes are DATA to
	//      the shell's quote state too;
	//   c. a quote never closed — the #61 swallowing shape; the span covers
	//      to EOF.
	// A properly closed plain `'...'` or `"..."` span is NOT masked: the
	// tokenizer reads those correctly, and the quoted-piece scan changed
	// release behavior the suite pins (an inline `-c 'payload'` must stay
	// releasable). Only mis-read spans are blanked out of the plain read,
	// and the recursion scans their content separately.
	const quoteSpans: Array<{ start: number; end: number }> = [];
	const inBody = (at: number): boolean => spans.some(s => at >= s.start && at < s.end);
	let i = 0;
	while (i < command.length) {
		if (inBody(i)) {
			// Jump past the current body region; its quotes are body data.
			const region = spans.find(s => i >= s.start && i < s.end);
			if (!region) break;
			i = region.end;
			continue;
		}
		const ch = command[i];
		if (ch === "\\" && i + 1 < command.length) {
			i += 2;
			continue;
		}
		if (ch === "$" && command[i + 1] === "'") {
			// ANSI-C open at i: `\'` escapes, plain `'` closes.
			let j = i + 2;
			let closed = false;
			while (j < command.length) {
				if (inBody(j)) break;
				if (command[j] === "'") {
					quoteSpans.push({ start: i, end: j + 1 });
					i = j + 1;
					closed = true;
					break;
				}
				j++;
			}
			if (!closed) {
				quoteSpans.push({ start: i, end: command.length });
				i = command.length;
			}
			continue;
		}
		if (ch === "'") {
			let j = i + 1;
			let crossedBody = false;
			let closed = false;
			while (j < command.length) {
				if (inBody(j)) {
					crossedBody = true;
					const region = spans.find(s => j >= s.start && j < s.end);
					if (!region) break;
					j = region.end;
					continue;
				}
				if (command[j] === "'") {
					if (crossedBody) quoteSpans.push({ start: i, end: j + 1 });
					i = j + 1;
					closed = true;
					break;
				}
				j++;
			}
			if (!closed) {
				quoteSpans.push({ start: i, end: command.length });
				i = command.length;
			}
			continue;
		}
		if (ch === '"') {
			let j = i + 1;
			let crossedBody = false;
			let closed = false;
			while (j < command.length) {
				if (inBody(j)) {
					crossedBody = true;
					const region = spans.find(s => j >= s.start && j < s.end);
					if (!region) break;
					j = region.end;
					continue;
				}
				if (command[j] === "\\") {
					j += 2;
					continue;
				}
				if (command[j] === '"') {
					if (crossedBody) quoteSpans.push({ start: i, end: j + 1 });
					i = j + 1;
					closed = true;
					break;
				}
				j++;
			}
			if (!closed) {
				quoteSpans.push({ start: i, end: command.length });
				i = command.length;
			}
			continue;
		}
		i++;
	}
	// Apply ALL masks (heredoc bodies + mis-read quote spans) to a single
	// output buffer. Every newline is kept so segment structure survives.
	const all = [...spans, ...quoteSpans].sort((a, b) => a.start - b.start);
	const chars = command.split("");
	for (const span of all) {
		for (let k = span.start; k < Math.min(span.end, chars.length); k++) {
			if (chars[k] !== "\n") chars[k] = " ";
		}
	}
	const masked = chars.join("");
	// The queue gets each span's INNER text (opening quote dropped). For an
	// unclosed quote — the #61 swallowing shape — the inner text is the
	// whole tail after the opener, tokenized as fresh text exactly once;
	// the seen-set stops any repeat.
	const quoted = quoteSpans.map(s => command.slice(s.start + 1, s.end));
	return { masked, bodies: bodies, quoted };
}

/**
 * True when a quote opened before `at` and stays open there, so the shell
 * reads everything in between as string text. Both quotes span newlines, a
 * backslash outside quotes escapes the next character, and ANSI-C `$'...'`
 * strings treat `\'` as an escaped quote where plain `'...'` would close.
 * Nothing else matters. An apostrophe in unquoted prose opens a quote that
 * never closes, which only ever blocks a strip that would have removed
 * text — the over-flag direction.
 */
export function openQuoteBefore(command: string, at: number): boolean {
	let quote: "'" | '"' | undefined;
	let ansi = false;
	for (let i = 0; i < at; i++) {
		const ch = command[i];
		if (quote === "'") {
			if (ch === "\\" && ansi) {
				i++;
				continue;
			}
			if (ch === "'") {
				quote = undefined;
				ansi = false;
			}
			continue;
		}
		if (quote === '"') {
			if (ch === "\\") {
				i++;
				continue;
			}
			if (ch === '"') quote = undefined;
			continue;
		}
		if (ch === "\\") {
			i++;
			continue;
		}
		if (ch === "'" || ch === '"') {
			quote = ch;
			ansi = ch === "'" && command[i - 1] === "$";
		}
	}
	return quote !== undefined;
}

/**
 * How one command segment is joined to its neighbours, as far as the shell's
 * working directory is concerned. `tokenizeShellSegments` splits `;`, `&&`,
 * `||`, `|`, `&`, `(`, `)` and a newline into the same kind of boundary, but a
 * `cd` does not cross them alike.
 */
type SegmentJoin =
	/** The first segment: the shell is where the command started. */
	| "start"
	/** `;` or a newline: the same shell runs the next segment. */
	| "same-shell"
	/** `&&`: the next segment runs only if this one SUCCEEDED. */
	| "on-success"
	/** `||`: the next segment runs only if this one FAILED, so it sees the
	 *  state this segment started from. */
	| "on-failure"
	/** `|` or `&`: the next segment runs in a subshell, or in the background. */
	| "new-shell"
	/** `)`: the group ended. */
	| "group-end";

/** One event of the walk over a command's own text: a segment, or a group
 *  boundary. Both matter, because a group's `cd` dies at its `)`. */
type ShellWalkEvent =
	| { kind: "segment"; words: string[]; join: SegmentJoin; terminator: SegmentJoin; start: number }
	| { kind: "group-open" }
	| { kind: "group-close" };

/** A character that never belongs to a word at the top level, so the first
 *  character that is not one of these begins a segment's first word. */
const SEGMENT_BREAK = /[\s;&|()]/u;

/**
 * Walk `text` the way `tokenizeShellSegments` does — same quoting, escaping,
 * words, and separators — and report each segment with the join that started
 * it, the join that ended it, the offset its first word starts at, plus the
 * group boundaries.
 *
 * The walk exists because the tokenizer throws the operators away, and an
 * operator is what decides whether a `cd` reaches the next segment. The
 * script-body reader pairs the segments this walk finds against the
 * tokenizer's own output and refuses to resolve anything when the two
 * disagree: a shifted pairing would resolve a program against another
 * segment's directory. The offset is for readers that hold a position in the
 * command instead of a segment index (the network tier finds its verb by
 * offset), and it addresses the ORIGINAL command as long as the text handed in
 * is the masked command, whose length is unchanged.
 */
function shellWalk(text: string): ShellWalkEvent[] {
	const events: ShellWalkEvent[] = [];
	let words: string[] = [];
	let buffer = "";
	let join: SegmentJoin = "start";
	let start = -1;
	let inSingle = false;
	let inDouble = false;
	const flushWords = (): void => {
		if (buffer.length > 0) {
			words.push(buffer);
			buffer = "";
		}
	};
	const flushSegment = (terminator: SegmentJoin): void => {
		flushWords();
		// A separator with nothing after it closes no segment: the pending join
		// stands, so `cd X; (` keeps the `;` the group inherits through.
		if (words.length === 0) {
			start = -1;
			return;
		}
		events.push({ kind: "segment", words, join, terminator, start });
		words = [];
		start = -1;
		join = terminator;
	};
	for (let i = 0; i < text.length; i++) {
		const ch = text[i];
		if (start === -1 && !SEGMENT_BREAK.test(ch)) start = i;
		if (inSingle) {
			if (ch === "'") inSingle = false;
			else buffer += ch;
			continue;
		}
		if (inDouble) {
			if (ch === "\\" && i + 1 < text.length) {
				const next = text[i + 1];
				if (next === '"' || next === "\\" || next === "$" || next === "`") {
					buffer += next;
					i++;
					continue;
				}
			}
			if (ch === '"') inDouble = false;
			else buffer += ch;
			continue;
		}
		if (ch === "'") {
			inSingle = true;
			continue;
		}
		if (ch === '"') {
			inDouble = true;
			continue;
		}
		if (ch === "\\" && i + 1 < text.length) {
			buffer += text[i + 1];
			i++;
			continue;
		}
		if (ch === " " || ch === "\t") {
			flushWords();
			continue;
		}
		if (ch === "&") {
			if (text[i + 1] === "&") {
				flushSegment("on-success");
				i++;
			} else flushSegment("new-shell");
			continue;
		}
		if (ch === "|") {
			if (text[i + 1] === "|") {
				flushSegment("on-failure");
				i++;
			} else flushSegment("new-shell");
			continue;
		}
		if (ch === ";" || ch === "\n") {
			flushSegment("same-shell");
			continue;
		}
		if (ch === "(") {
			flushSegment("new-shell");
			events.push({ kind: "group-open" });
			// A group inherits the shell's directory, and its first segment runs
			// whenever the group does — so a `cd` there answers for the group's
			// own segments even when the group itself was reached through `&&`
			// or `||`. The close hands the directory back.
			if (join !== "start") join = "same-shell";
			continue;
		}
		if (ch === ")") {
			flushSegment("group-end");
			events.push({ kind: "group-close" });
			continue;
		}
		buffer += ch;
	}
	// The last segment ends with the command: whatever it did to the shell
	// stands, so its own terminator is a plain end rather than a pending join.
	flushSegment(join === "start" ? "same-shell" : join);
	return events;
}

/** What one segment does to the shell's working directory. */
type SegmentDirectoryChange =
	/** The segment does not move the shell. */
	| { moves: false }
	/** The segment moves the shell to `path`, or to a directory the command
	 *  text cannot name (null: an expansion, `cd -`, a bare `cd`, a stack). */
	| { moves: true; path: string | null };

/** The builtins that can move the shell's working directory. */
const DIRECTORY_CHANGE_BUILTINS: Record<string, true> = { cd: true, chdir: true, pushd: true, popd: true };

/**
 * Resolve one path the way the calling reader resolves its own paths. The two
 * readers differ here on purpose (see this module's header), so the walk takes
 * the resolver instead of adopting one of the conventions for both.
 */
export type CwdResolver = (target: string, cwd: string) => string;

/** The resolver for a reader whose paths are ordinary filesystem paths. */
export const defaultCwdResolver: CwdResolver = (target, cwd) => path.resolve(cwd, target);

/**
 * Where one segment leaves the shell's working directory.
 *
 * `cd <literal>` is the only shape this reads. Everything else that can move
 * the shell — an expanded target (`cd $DIR`), `cd -`, a bare `cd` (`$HOME`),
 * `pushd`/`popd`, a `cd` with extra words or a redirect the walk folds into
 * one — resolves to "unknown", which the reader treats as a refusal rather
 * than a guess. A target that is not an existing directory leaves the shell
 * where it was (a failed `cd` changes nothing), and a target the gate cannot
 * even stat is unknown.
 */
function segmentDirectoryChange(words: string[], cwd: string | null, resolveCwd: CwdResolver): SegmentDirectoryChange {
	const verb = words[0];
	if (verb === undefined || DIRECTORY_CHANGE_BUILTINS[verb] !== true) return { moves: false };
	// `pushd`/`popd` move the directory onto a stack this walk does not follow.
	if (verb !== "cd" && verb !== "chdir") return { moves: true, path: null };
	if (words.length !== 2) return { moves: true, path: null };
	const target = words[1];
	if (target === "-" || SHELL_WORD_EXPANSION.test(target)) return { moves: true, path: null };
	const expanded = target === "~" || target.startsWith("~/") ? path.join(os.homedir(), target.slice(1)) : target;
	// An absolute target needs no starting directory; a relative one does, so a
	// relative `cd` while the directory is unknown stays unknown.
	if (cwd === null && !path.isAbsolute(expanded)) return { moves: true, path: null };
	let resolved: string;
	let stat: fs.Stats;
	try {
		resolved = resolveCwd(expanded, cwd ?? os.homedir());
		stat = fs.statSync(resolved);
	} catch (err) {
		// A target that is not there fails the `cd`, leaving the shell where it
		// was; anything the gate cannot even stat is not a place it may guess
		// about.
		if ((err as NodeJS.ErrnoException).code === "ENOENT") return { moves: true, path: cwd };
		return { moves: true, path: null };
	}
	return { moves: true, path: stat.isDirectory() ? resolved : cwd };
}

/**
 * The directories a segment can start in. `null` is a directory the command
 * text cannot name, and a set is only ever read whole: two possible
 * directories are not a directory this walk may choose between.
 */
type DirectorySet = Array<string | null>;

/** How many directories a set may carry before this walk stops tracking the
 *  difference — a set the reader would refuse on either way. */
const MAX_DIRECTORIES = 4;

/** Adds one possible directory, collapsing a set that grew past what this walk
 *  can carry: a set the reader would refuse on is `[null]`. */
const addDirectory = (cwds: DirectorySet, cwd: string | null): void => {
	if (cwds.includes(cwd)) return;
	if (cwds.length + 1 >= MAX_DIRECTORIES) {
		cwds.length = 0;
		cwds.push(null);
		return;
	}
	cwds.push(cwd);
};

/** Whether two sets name the same directories. A set is read whole, so the
 *  order the walk built them in carries no meaning here. */
const sameDirectories = (a: DirectorySet, b: DirectorySet): boolean => a.length === b.length && a.every(cwd => b.includes(cwd));

/** Every directory either set carries, in the same shape. */
const mergeDirectories = (a: DirectorySet, b: DirectorySet): DirectorySet => {
	const merged: DirectorySet = [];
	for (const cwd of a) addDirectory(merged, cwd);
	for (const cwd of b) addDirectory(merged, cwd);
	return merged.length === 0 ? [null] : merged;
};

/** The one directory a set names, or `null` when it names none or more than
 *  one — the answer the reader refuses on. */
const soleDirectory = (cwds: DirectorySet): string | null => (cwds.length === 1 ? (cwds[0] ?? null) : null);

/** One segment's directory, with the offset the segment starts at. */
export interface ShellSegmentDirectory {
	start: number;
	cwd: string | null;
}

/**
 * The directory each segment of an already-walked command runs in, in walk
 * order, with the offset its first word starts at. `null` means the directory
 * cannot be determined from the command text.
 *
 * The join around a segment decides whether a `cd` reaches it: a `;`, newline,
 * or `&&` keeps it, a `|`/`&` runs the segment in a subshell where its own `cd`
 * is invisible, and a `(`…`)` group inherits the directory but hands it back at
 * the close.
 *
 * A conditional chain is walked as the SET of directories it can leave the
 * shell in, because whether a `cd` took effect is not a fact in the text: `cd
 * /tmp || true; python3 payload.py` runs the payload in /tmp or beside the
 * session's own directory, so the walk answers "not determinable" and the
 * reader refuses instead of reading one of them (round 2 review). Round 3
 * review found the sibling spelling of the same doubt: in `cd /tmp || cd
 * /var/tmp && python3 payload.py` the second `cd` runs only if the first
 * FAILED, so the program after the `&&` is in /tmp when /tmp is there and in
 * /var/tmp when it is not. The branch of a `cd` therefore runs where that `cd`
 * found the shell, and the segment after the chain inherits both paths — the
 * `&&` here gates the whole `||` chain, not the last `cd` in it.
 *
 * Round 4 review found the doubt asked for too often: a segment reached only
 * when the earlier chain succeeded was treated as unpinned even when it cannot
 * move the shell, so `: && :; python3 payload.py` refused although both `:`
 * leave the shell exactly where the command started. The conditional segment
 * only doubts the directory when running it could have changed it.
 */
function walkedDirectories(events: ShellWalkEvent[], base: string, resolveCwd: CwdResolver): ShellSegmentDirectory[] {
	const walked: ShellSegmentDirectory[] = [];
	// The directories the next segment can start in, when it runs.
	let pending: DirectorySet = [base];
	// The `||` branch of the segment just walked: it starts where that segment
	// found the shell, because it runs only if that segment failed.
	let branchFrom: DirectorySet | undefined;
	// Where the earlier segments of the chain leave the shell when the segment
	// just walked did NOT run — the `||` chain's successful half.
	let chainAlts: DirectorySet | undefined;
	const opened: DirectorySet[] = [];
	for (const event of events) {
		if (event.kind === "group-open") {
			// A group inherits the directory and hands it back at its close. A
			// group reached as a `||` branch is a branch this walk carries
			// across the boundary (its segments start where the branch does),
			// but where the group then leaves the shell is not modeled, so what
			// it hands back is unknown rather than the chain's other half.
			opened.push(branchFrom === undefined ? pending : [null]);
			continue;
		}
		if (event.kind === "group-close") {
			pending = opened.pop() ?? [null];
			branchFrom = undefined;
			chainAlts = undefined;
			continue;
		}
		const isBranch = branchFrom !== undefined;
		const from = branchFrom ?? pending;
		const alts = chainAlts;
		branchFrom = undefined;
		chainAlts = undefined;
		walked.push({ start: event.start, cwd: soleDirectory(from) });
		// What this segment leaves the shell to, per directory it can start in.
		const after: DirectorySet = [];
		for (const cwd of from) {
			const change = segmentDirectoryChange(event.words, cwd, resolveCwd);
			addDirectory(after, change.moves ? change.path : cwd);
		}
		if (event.terminator === "new-shell" || event.terminator === "group-end") {
			// It ran in its own stage, background job, or subshell: the shell is
			// where this segment found it. A branch that did not run leaves it
			// where the chain's other half did.
			pending = isBranch && alts !== undefined ? mergeDirectories(from, alts) : from;
			continue;
		}
		// Where the shell is when the chain moves past this element: where this
		// element left it, or — for a branch that may have been skipped — where
		// the chain's other half did.
		const combined = isBranch && alts !== undefined ? mergeDirectories(after, alts) : after;
		if (event.terminator === "on-failure") {
			// `X || …`: the next segment is the failure branch and starts where
			// this one found the shell (it runs only if this one failed). The
			// other outcome — this one succeeded, so the branch is skipped —
			// waits in `chainAlts` for the branch's own walk to merge back in.
			branchFrom = from;
			chainAlts = combined;
			pending = combined;
			continue;
		}
		if (event.terminator === "on-success") {
			// `X && …`: the next segment runs only if this one succeeded, so it
			// ran, and the shell is where it left it. A branch that was skipped
			// took the chain's other half, which `combined` carries.
			pending = combined;
			continue;
		}
		// `;`, a newline, or the command's own end: the next segment runs
		// whatever this one did. A segment that may not have run at all (a
		// chain that is not continued by `&&`) leaves the directory unpinned
		// only when running it could have MOVED the shell: a segment that
		// leaves every candidate directory where it found it (`: && :; python3
		// payload.py` is `:; python3 payload.py` to the shell) leaves the shell
		// in the same place whether it ran or not, so the chain's own
		// directories still stand (round 4 review). A segment that moves — and
		// whose move may therefore not have happened — keeps the doubt. A
		// branch's `combined` already carries both of its outcomes.
		const conditional = event.join === "on-success" || event.join === "on-failure";
		pending = conditional && !isBranch && !sameDirectories(from, after) ? [null] : combined;
	}
	return walked;
}

/**
 * The working directory each command segment runs in, aligned with the
 * `segments` `tokenizeShellSegments` produced for the same text. `null` means
 * the directory cannot be determined from the command text.
 *
 * Round 1 review: every operand was resolved against the session's own
 * directory, so `cd /tmp; python3 payload.py` read nothing (ENOENT) and the
 * gate judged the command text while the shell changed directory and ran the
 * file. `walkedDirectories` above carries the chain rules.
 */
export function segmentWorkingDirectories(
	text: string,
	base: string,
	segments: string[][],
	resolveCwd: CwdResolver = defaultCwdResolver,
): Array<string | null> {
	const dirs: Array<string | null> = new Array<string | null>(segments.length).fill(null);
	const events = shellWalk(text);
	const walked = events.filter(event => event.kind === "segment");
	// Nothing is resolved unless this walk and the tokenizer agree word for
	// word: a shifted pairing would read another segment's directory.
	if (walked.length !== segments.length) return dirs;
	for (let index = 0; index < walked.length; index++) {
		const words = walked[index].words;
		if (words.length !== segments[index].length || words.some((word, at) => word !== segments[index][at])) return dirs;
	}
	const cwds = walkedDirectories(events, base, resolveCwd);
	for (let index = 0; index < cwds.length && index < dirs.length; index++) dirs[index] = cwds[index].cwd;
	return dirs;
}

function cwdAtOffset(walked: readonly ShellSegmentDirectory[], offset: number, base: string): string | null {
	let low = 0;
	let high = walked.length;
	while (low < high) {
		const middle = (low + high) >>> 1;
		if (walked[middle].start <= offset) low = middle + 1;
		else high = middle;
	}
	return low === 0 ? base : walked[low - 1].cwd;
}

/**
 * The directory the segment containing `offset` runs in, or `null` when the
 * command text does not pin it.
 *
 * For a caller that holds a position in the command instead of a segment index
 * — the network tier finds its verb by offset in the command it measures.
 * `text` is the text the walk should read: pass the masked command for offsets
 * that address the original (masking is length-preserving). An offset before
 * the first segment answers with `base`, because the shell has not run anything
 * yet, and a command with no segment at all answers with `base` for the same
 * reason.
 */
export function segmentCwdAt(
	text: string,
	offset: number,
	base: string,
	resolveCwd: CwdResolver = defaultCwdResolver,
): string | null {
	return cwdAtOffset(walkedDirectories(shellWalk(text), base, resolveCwd), offset, base);
}

/** Build one shell walk for callers resolving several command offsets. */
export function segmentCwdLookup(
	text: string,
	base: string,
	resolveCwd: CwdResolver = defaultCwdResolver,
): (offset: number) => string | null {
	const walked = walkedDirectories(shellWalk(text), base, resolveCwd);
	return offset => cwdAtOffset(walked, offset, base);
}
