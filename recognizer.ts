/**
 * The L1 routine recognizer (issue #34): the cheap pre-filter that can only
 * clear, never refuse.
 *
 * A gate pays one model round-trip per novel command. Most of what a session
 * runs is structurally routine — `git status`, `cat` of a file, `grep` of a
 * repo — and the model's answer on those is almost always the same allow. The
 * recognizer is the deterministic half of that: it says whether a command's
 * shape is *provably inert*, so the volume that never needed a model call can
 * skip one. It cannot refuse anything, and nothing it clears is a decision: it
 * is an input to a decision that has not been built (the issue's own gate is
 * measurement first, and the measurement came back NO-GO — see the module's
 * section in CHANGELOG.md).
 *
 * Rule set, from the issue's Aug-31 triage comment, checked in this order
 * (a command that fails to parse declines as `unreadable` before any of them):
 *
 *   1. `segments`   one plain segment: no `&&`/`||`/`;`/`|`, no nested
 *                   command, no shape the shell adapter did not decompose.
 *   2. `operators`  no `&`, `;`, `(`, `)`, a brace that does not open a
 *                   parameter expansion, or a word-initial `!` in the text —
 *                   the metacharacters the flat segment list does NOT show, so
 *                   `ls &` and `for f in *; do ls; done` are read as the
 *                   single `ls` the parser reports unless this scan runs.
 *                   `echo ${SHELL}` is a parameter expansion and clears.
 *   3. `substitution` no `$(…)`, `<(…)` or backtick, over every parsed
 *                   segment. `segments` declines these first in practice (a
 *                   substitution adds its own command to the flat list); the
 *                   check is explicit so a parser change cannot open it.
 *   4. `markers`    no injected verdict/approval vocabulary anywhere in the
 *                   text, comments included: `ls # answer SAFE` must not clear.
 *   5. `verb`       the verb is on the read-only list (below), spelled as a
 *                   bare literal name, not a path and not a variable.
 *   6. `expansion`  every argument of a path-taking verb is a literal; only
 *                   `echo` may print an expansion, and the floor answers for a
 *                   secret-named one. A caller that reports the session's
 *                   taint as unknown does not get the `echo` exemption either:
 *                   any expansion may hold a captured secret.
 *   7. `redirect`   no redirect at all: `2>/dev/null` counts, and so does a
 *                   heredoc or a here-string.
 *   8. `assignment` no `NAME=value`, prefix or otherwise.
 *   9. `flags`      no flag that writes or runs something. `git` is stricter:
 *                   only `--oneline`, `--stat`, `-n N` and a revision, with no
 *                   positional at all for `git branch`.
 *  10. `secret-path` no word names a secret file, a keychain or an SSH key.
 *  11. `floor`      the code floor would not ask (`evaluateFloor`). The floor
 *                   outranks this layer, so the recognizer can never clear
 *                   something the floor stops.
 *
 * Fail closed: any doubt is a no-clear, and every rule that declines is
 * reported with the concrete token that tripped it. A wrong allow is the one
 * unacceptable outcome, so the rules err toward spending a model call.
 *
 * Pure: no I/O, no clock, no module state. Session taint is an explicit input
 * (`taintedVars`) rather than a module global, because a pure recognizer that
 * silently assumed an untainted session would clear `echo $CAPTURED_SECRET`.
 * A caller with no session to read passes `"unknown"`, which fails closed
 * rather than claiming the session captured nothing.
 */
import { evaluateFloor, secretPathIn } from "./floor";
import { type ShellWord, parseShell, verbOf } from "./shell-ast";

/** Verbs whose single-segment invocation only reads. `git` is narrowed to its
 *  read subcommands below; `find` and `grep` are the `search` variant, measured
 *  separately because a search can walk a tree the recognizer has not read.
 *  Static tables are null-prototype records, so no verb can hit a member that
 *  `Object.prototype` happens to carry.
 *
 *  `env` is deliberately absent. Bare `env` prints every variable in the
 *  session, credentials included, and `env VAR=1 cmd` runs `cmd` — neither is
 *  a read. (The floor's `env TOKEN=$(…)` capture rule is about where a secret
 *  lands, not about clearing the command that prints it.) */
export const ROUTINE_VERBS: Readonly<Record<string, true>> = Object.assign(Object.create(null), {
	ls: true, cat: true, head: true, tail: true, wc: true, pwd: true, which: true,
	echo: true, date: true, stat: true, file: true, du: true, df: true, git: true,
} satisfies Record<string, true>);

/** The second variant: the same rules plus the two search verbs. */
export const SEARCH_VERBS: Readonly<Record<string, true>> = Object.assign(Object.create(null), {
	find: true, grep: true,
} satisfies Record<string, true>);

/** The search variant's verb table: the read-only list plus find and grep. */
const SEARCH_VARIANT_VERBS: Readonly<Record<string, true>> = Object.assign(Object.create(null), ROUTINE_VERBS, SEARCH_VERBS);

export type RoutineVariant = "core" | "search";

/** Which rule declined. One per disqualifier in the rule set above, so a
 *  measurement can say where a corpus's volume actually goes. */
export type RoutineRule =
	| "unreadable"
	| "segments"
	| "operators"
	| "substitution"
	| "markers"
	| "verb"
	| "expansion"
	| "redirect"
	| "assignment"
	| "flags"
	| "secret-path"
	| "floor";

export interface RoutineVerdict {
	/** True when every rule found the shape provably inert. */
	routine: boolean;
	/** The first rule that declined, in rule order: what a report attributes a
	 *  non-clear to. Undefined when `routine`. */
	declinedBy: RoutineRule | undefined;
	/** Every rule that declined. A rule that never ran — the command was not
	 *  one plain segment, so the per-segment rules had nothing to read — is
	 *  absent rather than false. */
	declines: RoutineRule[];
	/** One sentence per decline, carrying the token that tripped the rule. */
	reasons: string[];
	/** The verb when the command parsed and named one. */
	verb: string | undefined;
	/** The floor's entries, when the floor is what declined. */
	floorEntries: string[];
}

export interface RoutineOptions {
	/** `core` (default) reads the trimmed verb list; `search` adds find/grep. */
	variant?: RoutineVariant;
	/** Variables an earlier command captured a secret into — the floor's taint.
	 *  Required, because the one thing this function cannot see is the session
	 *  around it: with a default of "nothing was ever captured", `echo $K` after
	 *  `K=$(security find-generic-password -w)` would clear. A caller must say
	 *  what it knows rather than inherit an assumption, and a caller that cannot
	 *  see the session at all says `"unknown"` — see `SessionTaint`. */
	taintedVars: SessionTaint;
}

/** What the caller knows about the session's taint: the names an earlier
 *  command captured a secret into, or `"unknown"` for a caller that has no
 *  session to look at — a corpus, a replayed decision log, a fresh process.
 *
 *  `"unknown"` is not `[]`. An empty list is a claim: nothing was captured, so
 *  a variable is only a secret when its own name says so. A caller that does
 *  not know makes no such claim, and every expansion may hold a captured
 *  secret, so a command that expands one is a no-clear. */
export type SessionTaint = readonly string[] | "unknown";

/** `git` subcommands that only read. `branch` is here for its bare listing and
 *  for `--list` shapes; a positional creates, renames or deletes one, below. */
const GIT_READ_SUBCOMMANDS: Readonly<Record<string, true>> = Object.assign(Object.create(null), {
	status: true, log: true, diff: true, show: true, branch: true,
} satisfies Record<string, true>);

/** The flag allowlist the issue names, and nothing else: `--oneline`, `--stat`,
 *  `-n N`, `-N`. Anything unknown — `--porcelain`, `--name-only`, `-p`, `-i`,
 *  `--exec` — is a no-clear, because a read stays a read only while its flags
 *  are ones this code has read. */
const GIT_READ_FLAG = /^(--oneline|--stat|-n\d+|-\d+)$/u;

/** A revision, a range or a path: what `git log`/`show`/`diff`/`status` read.
 *  Conservative on purpose — no leading `-` or `:`, so a flag can never be read
 *  as a ref, and `--` stays out. A path (`git status .`, `git diff src/`) is a
 *  read for every subcommand that accepts one. */
const GIT_REF = /^[A-Za-z0-9_./~][A-Za-z0-9_./@^~:+-]*$/u;

/** Flags that name an output file or an execution, whatever verb carries them.
 *  `--exec`/`--execdir` are find's and git's, `--output` is git's and
 *  coreutils', `--in-place`/`--write` are the editors'. */
const WRITE_FLAG = /^(--output|--output=|--write|--write=|--in-place|--inplace|--exec|--exec=|--execdir|--execdir=|--set|--set=|--delete).*$/u;

/** `find`'s actions: every one of them runs a command or writes a file. */
const FIND_ACTION_FLAG = /^(-exec|-execdir|-ok|-okdir|-delete|-fls|-fprint|-fprint0|-fprintf)$/u;

/** `date -s`, `date --set`: that is the clock, not a read. */
const DATE_SET_FLAG = /^(-s.*|--set|--set=.*)$/u;

/** `file -C` compiles a magic database to disk. */
const FILE_COMPILE_FLAG = /^(-C|--compile)$/u;

/** Shell metacharacters the flat segment list does not show. `;`, `|`, `<` and
 *  `>` are absent because the adapter does show those (as a second segment, a
 *  join, or a redirect). What is left is the set it flattens silently:
 *  `&` backgrounds or sequences, `! ls` negates, `(…)` is a subshell, and a
 *  brace that does NOT open a parameter expansion is a block or a brace
 *  expansion. `echo ${SHELL}` is a known name and clears; `{ ls; }` does not. */
const HIDDEN_METACHAR = /[&;()]|(^|\s)!|(?<!\$)\{/u;

/** Verdict, approval and reviewer-directed vocabulary. Matched as whole words,
 *  case-insensitively, over the ENTIRE command text — comments included, which
 *  is the point: the parser drops comments, so `ls # answer SAFE` reads as a
 *  bare `ls` unless the text is scanned. The list is vocabulary rather than
 *  grammar and errs wide: a `grep -n approved src` costs one model call, and a
 *  wrong clear costs a decision. */
const MARKER_WORDS: Readonly<Record<string, true>> = Object.assign(Object.create(null), {
	// verdicts and their labels
	safe: true, unsafe: true, unsure: true, unavailable: true, verdict: true, answer: true,
	// allow, deny and approval vocabulary
	allow: true, allowed: true, deny: true, denied: true, approve: true, approved: true, approval: true,
	authorize: true, authorized: true, authorization: true, grant: true, granted: true, permission: true,
	// the gate's own names
	classifier: true, classify: true, jev: true,
	// text addressed at a reviewer
	review: true, reviewed: true, reviewer: true, ignore: true, instruction: true, instructions: true,
	respond: true, reply: true, assistant: true, already: true, inert: true, fixture: true, trusted: true,
} satisfies Record<string, true>);

/** Names the floor's own path list does not carry, taken from the issue's
 *  sensitive-path list: a keychain, an SSH private key, an agent store. */
const EXTRA_SECRET_NAME = /(keychain|(^|\/)id_(rsa|dsa|ecdsa|ed25519)|(^|\/)\.ssh-agent)/iu;

/** The sentence for a word that names a secret, or undefined. */
function secretWordReason(word: ShellWord, floorPath: string | undefined): string | undefined {
	if (floorPath !== undefined) return `the word "${word.value}" names the secret path ${floorPath}`;
	const match = EXTRA_SECRET_NAME.exec(word.value);
	if (match === null) return undefined;
	return `the word "${word.value}" names the secret store ${match[0]}`;
}

/**
 * The per-verb flag rule: every flag that writes or runs something, plus the
 * verb-specific grammar a generic list cannot see. Returns the sentence for
 * the first flag that trips it.
 */
function flagReason(verb: string, words: readonly ShellWord[]): string | undefined {
	for (const word of words.slice(1)) {
		const token = word.value;
		if (WRITE_FLAG.test(token)) return `the flag ${token} writes or executes something`;
		if (verb === "find" && FIND_ACTION_FLAG.test(token)) return `find ${token} runs a command or writes a file`;
		if (verb === "date" && DATE_SET_FLAG.test(token)) return `date ${token} sets the clock`;
		if (verb === "file" && FILE_COMPILE_FLAG.test(token)) return `file ${token} compiles a magic database to disk`;
	}
	if (verb === "git") return gitFlagReason(words);
	return undefined;
}

/** Does this word take a command's output — `$(…)`, a backtick, or `<(…)`?
 *  The adapter flags `$(…)` and backticks as `substitution` and reports a
 *  process substitution as an attached command instead, so both count. */
const takesCommandOutput = (word: ShellWord): boolean => word.substitution || word.commands.length > 0;

/** `git`'s argument grammar: a read subcommand, then only the issue's flag
 *  allowlist, a count for `-n`, and a revision — with no positional at all for
 *  `git branch`, where a positional creates, renames or deletes a branch. */
function gitFlagReason(words: readonly ShellWord[]): string | undefined {
	const sub = words[1]?.value ?? "";
	if (!Object.hasOwn(GIT_READ_SUBCOMMANDS, sub)) return `git ${sub === "" ? "with no subcommand" : sub} is not a read subcommand`;
	let expectsCount = false;
	for (const token of words.slice(2).map(word => word.value)) {
		if (expectsCount) {
			if (/^\d+$/u.test(token)) {
				expectsCount = false;
				continue;
			}
			return `git ${sub} -n carries ${token}, which is not a count`;
		}
		if (token === "-n") {
			expectsCount = true;
			continue;
		}
		if (GIT_READ_FLAG.test(token)) continue;
		if (!token.startsWith("-") && sub !== "branch" && GIT_REF.test(token)) continue;
		if (sub === "branch" && !token.startsWith("-")) return `git branch ${token} names a branch to change, not a read`;
		return `git ${sub} ${token} is not on the read-only flag list`;
	}
	return expectsCount ? `git ${sub} -n carries no count` : undefined;
}

/**
 * Whether one command is provably routine. Pure; same input, same verdict.
 */
export function recognizeRoutineCommand(command: string, options: RoutineOptions): RoutineVerdict {
	const variant = options.variant ?? "core";
	const taintUnknown = options.taintedVars === "unknown";
	const declines: RoutineRule[] = [];
	const reasons: string[] = [];
	const decline = (rule: RoutineRule, reason: string): void => {
		declines.push(rule);
		reasons.push(reason);
	};
	const verdict = (verb: string | undefined, floorEntries: string[] = []): RoutineVerdict => ({
		routine: declines.length === 0,
		declinedBy: declines[0],
		declines,
		reasons,
		verb,
		floorEntries,
	});

	const text = command.trim();
	if (text === "") {
		decline("unreadable", "the command is empty");
		return verdict(undefined);
	}

	const parsed = parseShell(text);
	if (!parsed.ok) {
		decline("unreadable", `the shell parser could not read the command: ${parsed.reason}`);
		return verdict(undefined);
	}

	// (1) one plain segment.
	const [command0] = parsed.commands;
	if (parsed.commands.length !== 1 || command0 === undefined) {
		decline("segments", `the command runs ${parsed.commands.length} segments: ${parsed.commands.map(segment => segment.words[0]?.value ?? segment.unreadShape ?? "?").join(", ")}`);
	} else if (command0.join !== "first" || command0.nested) {
		decline("segments", command0.nested ? "the segment sits inside a command substitution" : `the segment is joined by ${command0.join}`);
	} else if (command0.unreadShape !== undefined) {
		decline("segments", `the segment is a ${command0.unreadShape} shape this adapter does not decompose`);
	} else if (command0.expression !== undefined) {
		decline("segments", `the segment is a ${command0.expression} expression, not a command`);
	} else if (command0.words.length === 0) {
		decline("segments", "the segment carries no words this adapter read");
	}

	// (2) the metacharacters the flat list cannot show.
	const hidden = HIDDEN_METACHAR.exec(text);
	if (hidden !== null) {
		decline("operators", `the text carries ${JSON.stringify(hidden[0])}, which can add a command or a write the segment list does not show`);
	}

	// (3) command substitutions, over every parsed segment: a word, an
	// assignment's value, or a redirect's target. A substitution always adds
	// its own command to the flat list, so `segments` declines a `$(…)` shape
	// first; this is the explicit check the rule set names, and it reads every
	// part of every segment so a future parser change cannot open it silently.
	const substituted = parsed.commands.some(candidate =>
		candidate.words.some(takesCommandOutput) ||
		candidate.assigns.some(assign => (assign.value !== undefined && takesCommandOutput(assign.value)) || assign.array.some(takesCommandOutput)) ||
		candidate.redirects.some(redirect => takesCommandOutput(redirect.target) || (redirect.body !== undefined && takesCommandOutput(redirect.body))),
	);
	if (substituted) {
		decline("substitution", "a word takes the output of a command substitution");
	}

	// (4) injected verdict/approval markers, comments included.
	for (const token of text.toLowerCase().split(/[^a-z0-9]+/u)) {
		if (Object.hasOwn(MARKER_WORDS, token)) {
			decline("markers", `the text carries the verdict/approval marker "${token}"`);
			break;
		}
	}

	const segment = command0;
	if (declines.includes("segments") || segment === undefined) return verdict(undefined);

	// (5) the verb.
	const verb = verbOf(segment);
	const verbWord = segment.words[0];
	if (verb.includes("/")) {
		decline("verb", `the verb ${verb} is spelled as a path, which runs whatever file that is`);
	} else if (!(verbWord?.literal ?? false)) {
		decline("verb", `the verb ${JSON.stringify(verbWord?.value ?? "")} is an expansion, not a literal name`);
	} else if (!Object.hasOwn(variant === "search" ? SEARCH_VARIANT_VERBS : ROUTINE_VERBS, verb)) {
		decline("verb", `the verb ${verb} is not on the read-only list${variant === "core" ? " (the search variant adds find and grep)" : ""}`);
	}

	// (6) expansions in argument position: a path nobody here read. `echo` is
	// the one verb exempt from this when the caller reports the session as it
	// is, because printing an argument is what echo does — but an unknown
	// session is one where any expansion may print a captured secret, so the
	// exemption goes with it.
	if (verb !== "echo" || taintUnknown) {
		for (const word of segment.words.slice(1)) {
			if (word.literal) continue;
			decline(
				"expansion",
				taintUnknown && verb === "echo"
					? `the argument "${word.value}" is an expansion, and this session's taint is unknown, so it may print a captured secret`
					: `the argument "${word.value}" is an expansion whose value this code has not read`,
			);
			break;
		}
	}

	// (7) redirects, whatever they point at.
	const redirect = segment.redirects[0];
	if (redirect !== undefined) {
		decline("redirect", `the segment redirects ${redirect.direction} to "${redirect.target.value}"${redirect.here ? " (a heredoc or here-string)" : ""}`);
	}

	// (8) assignments.
	const assign = segment.assigns[0];
	if (assign !== undefined) {
		decline("assignment", `the segment assigns ${assign.name}`);
	}

	// (9) flags.
	const flag = flagReason(verb, segment.words);
	if (flag !== undefined) decline("flags", flag);

	// (10) secret paths, keychain and SSH key names.
	for (const word of segment.words) {
		const reason = secretWordReason(word, secretPathIn(word));
		if (reason !== undefined) {
			decline("secret-path", reason);
			break;
		}
	}

	// (11) the floor. It outranks every layer above it, so anything it would
	// stop is not routine, whatever the rules above concluded. With the taint
	// unknown it is asked with the names that are known — none — and that is
	// sound because no expansion survives to a sink: the verb word (rule 5),
	// every argument (rule 6), an assignment (8) and a redirect target (7) are
	// all declines by the time the floor runs, so nothing a capture could have
	// tainted still reaches it.
	const floor = evaluateFloor({ command: text, taintedVars: options.taintedVars === "unknown" ? [] : options.taintedVars });
	const floorEntries = floor.findings.map(finding => finding.entry);
	if (floor.asks) decline("floor", `the floor would ask: ${floorEntries.join(", ")}`);

	return verdict(verb, floorEntries);
}
