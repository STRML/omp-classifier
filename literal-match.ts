/**
 * The literal match (plan `docs/plans/2026-09-19-intent-aware-judgment.md`,
 * Phase 2 step 2).
 *
 * A fast path for local actions the user named in their own words. Two things
 * must hold at once, and the second is what keeps the first honest:
 *
 *   1. Every segment of the command is an extracted action or an inert shape.
 *      One segment the parser does not fully understand makes the command
 *      incomplete, so a matched `rm` riding beside `python3 -c` never gets the
 *      fast path.
 *   2. Every extracted action is named in the user's recent standalone text,
 *      as whole words, in imperative or present form, with no restrictive or
 *      conditional word nearby.
 *
 * What is deliberately NOT here: network egress, secrets, and privilege. They
 * are not on the inert list and nothing extracts them, so they make a command
 * incomplete and it goes to the reviewer. That is the plan's rule that code may
 * grant an allow only for what code fully sees.
 *
 * One place where the plan contradicts itself, resolved conservatively: the
 * action table lists force push, while the exclusion list says network egress
 * never matches literally. A push is network egress, so this module does not
 * extract it and a force push goes to the reviewer. Branch delete, which is
 * local, still matches. Filed to reconcile the plan text.
 */
import { isSecretPath } from "./floor";
import { parseShell, type ShellCommand } from "./shell-ast";

export type ActionKind = "delete" | "branch-delete" | "merge" | "deploy";

export interface ExtractedAction {
	kind: ActionKind;
	/** What the user has to name: a path's final component, a branch, a PR
	 *  number, an environment. Never a whole path. */
	target: string;
	/** Extra words the user has to name too, such as a widening flag. */
	requiredWords: string[];
}

export interface LiteralMatchInput {
	command: string;
	cwd: string;
	homeDir: string;
	/** Standalone user text from the recent window. Fenced code, quoted lines
	 *  and inline code are stripped here, not by the caller. */
	userMessages: readonly string[];
	/** Reaches the reviewer, never the literal match: an old request must not
	 *  authorize a new command by itself. */
	pinnedUserMessage?: string;
	/** Same rule, for messages a subagent inherited from its parent. */
	inheritedUserMessages?: readonly string[];
	sessionTempDir?: string;
	/** Resolve a path the way the kernel will, following symlinks. The plan
	 *  asks for the real path of a delete target and every parent, and this
	 *  module does no I/O, so the caller supplies it.
	 *
	 *  Required for a delete to match at all. A lexical check cannot see that
	 *  `build` is a symlink to `/etc`, and the agent can create that symlink,
	 *  so without a resolver a delete fails closed and goes to the reviewer
	 *  rather than matching on the name it was given. */
	resolveRealPath?: (candidate: string) => string;
}

export interface LiteralMatchResult {
	matched: boolean;
	actions: ExtractedAction[];
	/** Segments that were neither extracted nor inert. */
	incomplete: string[];
	reason: string;
}

/** Shapes that carry no action of their own. Anything not here, and not an
 *  extracted action, makes the command incomplete. */
const INERT_VERBS = new Set(["ls", "pwd", "true", "cat", "echo", "git"]);
const INERT_GIT_SUBCOMMANDS = new Set(["status", "diff", "log", "show", "branch"]);

const DELETE_VERBS = new Set(["rm", "trash", "unlink"]);
const VERB_FORMS: Record<ActionKind, { allowed: RegExp; target: "path" | "word" }> = {
	delete: { allowed: /^(delete|deletes|deleting|remove|removes|removing|clean|cleans|cleaning|clear|clears|clearing|rm|trash|nuke|drop)$/u, target: "path" },
	"branch-delete": { allowed: /^(delete|deletes|deleting|remove|removes|removing|drop|kill)$/u, target: "word" },
	merge: { allowed: /^(merge|merges|merging|land|lands|landing)$/u, target: "word" },
	deploy: { allowed: /^(deploy|deploys|deploying|ship|ships|shipping|publish|publishes|publishing|release|releases|releasing)$/u, target: "word" },
};

/** A restrictive or conditional word this close to a matched token cancels the
 *  match. The distance is the plan's: five words either side. */
const CANCEL_WINDOW = 5;
/** An upper bound on how far a verb may sit from the target it authorizes.
 *  What actually decides is what sits BETWEEN them, below. */
const PAIR_WINDOW = 6;
/** Words that can sit between a verb and the target it authorizes without
 *  starting a different instruction. "delete the build dir" is one request;
 *  "delete release/backup, keep release/old" is two, and the second is not a
 *  delete. */
const FILLER = new Set([
	"the", "a", "an", "this", "that", "these", "those", "my", "our", "its", "and", "plus", "also", "all", "of", "in", "to", "on", "into", "for",
	"dir", "dirs", "directory", "folder", "branch", "branches", "file", "files", "pr", "prs", "tag", "please", "now", "just", "old", "stale",
]);
const CANCEL_WORDS = new Set([
	"don't", "dont", "don", "do", "not", "never", "stop", "avoid", "skip", "without", "rather", "instead",
	"if", "when", "unless", "should", "would", "could", "suppose", "maybe", "perhaps", "only", "except",
	"can't", "cant", "won't", "wont", "isn't", "isnt", "doesn't", "doesnt", "no", "nope", "hold",
]);

/** Flags that widen an action, so the user has to have named them. */
const WIDENING_FLAG = /^--(admin|force|force-with-lease|no-verify|hard|prod|production)$/u;

export function literalMatch(input: LiteralMatchInput): LiteralMatchResult {
	const parsed = parseShell(input.command);
	if (!parsed.ok) {
		return { matched: false, actions: [], incomplete: [input.command], reason: `the shell parser could not read the command: ${parsed.reason}` };
	}
	const actions: ExtractedAction[] = [];
	const incomplete: string[] = [];

	for (const command of parsed.commands) {
		const tokens = plainTokens(command);
		const extracted = tokens === undefined ? undefined : extractActions(tokens, input);
		if (extracted === undefined) {
			incomplete.push(command.unreadShape ?? command.words.map(word => word.source).join(" "));
			continue;
		}
		actions.push(...extracted);
	}

	if (incomplete.length > 0) {
		return { matched: false, actions, incomplete, reason: `segment not extracted or inert: ${incomplete[0]}` };
	}
	if (actions.length === 0) {
		return { matched: false, actions, incomplete, reason: "no action extracted, so there is nothing for the user's words to authorize" };
	}

	const words = userWords(input.userMessages);
	const siblingTargets = new Set(actions.map(action => action.target.toLowerCase()));
	for (const action of actions) {
		const miss = unmatchedPart(action, words, siblingTargets);
		if (miss !== undefined) {
			return { matched: false, actions, incomplete, reason: `the user's recent words do not name ${miss}` };
		}
	}
	return { matched: true, actions, incomplete, reason: `every segment matched: ${actions.map(a => `${a.kind} ${a.target}`).join(", ")}` };
}

/**
 * A command's words as plain text, or undefined when the command does more
 * than its words say. A redirect writes somewhere, an assignment sets state,
 * an expansion is a value nobody here has read, and a command inside a
 * substitution runs for a word of another command. Each of those makes the
 * command incomplete. So does a shape the parser could not decompose.
 */
function plainTokens(command: ShellCommand): string[] | undefined {
	if (command.nested || command.unreadShape !== undefined) return undefined;
	if (command.redirects.length > 0 || command.assigns.length > 0) return undefined;
	if (command.words.length === 0 || command.words.some(word => !word.literal)) return undefined;
	return command.words.map(word => word.value);
}

/** Returns the actions in this segment, or undefined when the segment is
 *  neither an action this module extracts nor an inert shape. */
function extractActions(tokens: readonly string[], input: LiteralMatchInput): ExtractedAction[] | undefined {
	const spelling = tokens[0] ?? "";
	// A command spelled as a path is a FILE, and the agent can write files. Only
	// a bare name resolves through PATH to the tool this module means, so `./rm`
	// and `/tmp/evil/cat` are neither the delete verb nor an inert read. The one
	// exception is a deploy script, which is a path by nature and is bounded to
	// the working directory below.
	const spelledAsPath = spelling.includes("/");
	const verb = basename(spelling);
	if (isDeployScript(spelling, verb, input)) return [deployAction(tokens, verb)];
	if (spelledAsPath) return undefined;
	if (DELETE_VERBS.has(verb)) return deleteActions(tokens, input);
	// `git` and `gh` carry both actions and inert reads, so a subcommand this
	// module does not extract still gets the inert check below rather than
	// making the whole command incomplete.
	if (verb === "git" && tokens[1] === "branch") return gitActions(tokens);
	if (verb === "gh") return ghActions(tokens);
	if (isInert(tokens, verb)) return [];
	return undefined;
}

/**
 * A deploy, publish or release script. The plan's action table extracts these
 * by verb, and the verb of a repository script is its filename, so this is the
 * one place a name grants anything. Two bounds on that: the file must live
 * inside the working directory, and what the file DOES is still unread here.
 * Phase 4 reads script bodies, which is what will make this sound rather than
 * merely bounded (#67).
 */
function isDeployScript(spelling: string, verb: string, input: LiteralMatchInput): boolean {
	const named = /^(deploy|publish|release)/u.test(verb) || /(deploy|publish|release)[^/]*\.(sh|ts|js|py)$/u.test(verb);
	if (!named) return false;
	if (!spelling.includes("/")) return true;
	return isInside(resolvePath(spelling, input.cwd), input.cwd);
}

/** Flags a read-only git subcommand may carry. Git runs commands of its own
 *  when asked: `git log --ext-diff` runs the external diff driver the repo's
 *  config names, and `git -c core.pager=…` names one outright. A read stays a
 *  read only while its flags are on this list. */
const INERT_GIT_FLAGS = /^(-[0-9]+|-p|-s|-v|-n|--oneline|--stat|--numstat|--name-only|--name-status|--short|--porcelain|--graph|--decorate|--no-color|--date=[a-z0-9-]+|--pretty=[a-z0-9:%+_-]+|--format=[a-z0-9:%+_-]+)$/u;

function inertGit(tokens: readonly string[]): boolean {
	if (!INERT_GIT_SUBCOMMANDS.has(tokens[1] ?? "")) return false;
	return tokens.slice(2).every(token => !NOT_PLAIN.test(token) && (!token.startsWith("-") || INERT_GIT_FLAGS.test(token)));
}

/** Characters that make a segment do something this module did not read: a
 *  substitution, a redirect, or a pattern the shell expands to paths nobody
 *  here has seen. */
const NOT_PLAIN = /[$`><{}*?\[\]]/u;

function isInert(tokens: readonly string[], verb: string): boolean {
	if (!INERT_VERBS.has(verb)) return false;
	if (verb === "git") return inertGit(tokens);
	// The verb says what the segment READS. A redirect is what it WRITES, and
	// `echo "alias x=y" >> ~/.bashrc` is an inert verb installing a shell
	// alias beside a delete the user did name. A glob or brace is the same
	// problem for reads: the shell expands `id_rsa.{pem,pub}` to a path this
	// code never looked at.
	if (tokens.some(token => NOT_PLAIN.test(token))) return false;
	// The plan's inert entry is `cat` of a NON-SECRET path. A secret read is
	// exactly what the floor exists to catch, and an inert label here would let
	// it ride along beside a matched delete.
	if (verb === "cat") return !tokens.slice(1).some(token => !token.startsWith("-") && isSecretPath(token));
	return true;
}

function deleteActions(tokens: readonly string[], input: LiteralMatchInput): ExtractedAction[] | undefined {
	const targets = tokens.slice(1).filter(token => !token.startsWith("-"));
	if (targets.length === 0) return undefined;
	const actions: ExtractedAction[] = [];
	for (const target of targets) {
		const name = deleteTargetName(target, input);
		if (name === undefined) return undefined;
		actions.push({ kind: "delete", target: name, requiredWords: [] });
	}
	return actions;
}

/**
 * The final component of a delete target, when the target is a plain path
 * inside the working directory (or the session temp directory) and naming it
 * says something. Everything else returns undefined, which makes the segment
 * incomplete rather than matched: a glob, a variable, a substitution, `.`,
 * `..`, a two-character name, a path outside the directory, or any delete at
 * all when the working directory is the home directory or one of its parents.
 */
function deleteTargetName(target: string, input: LiteralMatchInput): string | undefined {
	if (/[*?\[\]$`]/u.test(target)) return undefined;
	if (target === "." || target === ".." || target.length === 0) return undefined;
	if (homeOrAbove(input.cwd, input.homeDir)) return undefined;

	if (input.resolveRealPath === undefined) return undefined;
	const real = input.resolveRealPath;
	// The target is compared by its real path, so the roots are too: a
	// symlinked working directory (macOS /var is /private/var) otherwise never
	// contains its own files. The home rule is checked on both spellings.
	const cwd = real(input.cwd);
	if (homeOrAbove(cwd, real(input.homeDir))) return undefined;
	const resolved = real(resolvePath(target, input.cwd));
	const roots = [cwd, ...(input.sessionTempDir ? [real(input.sessionTempDir)] : [])];
	if (!roots.some(root => isInside(resolved, root))) return undefined;

	const name = resolved.split("/").filter(part => part.length > 0).pop();
	if (name === undefined || name.length < 3) return undefined;
	return name;
}

function gitActions(tokens: readonly string[]): ExtractedAction[] | undefined {
	if (tokens[1] !== "branch") return undefined;
	const deleteFlag = tokens.some(token => token === "-D" || token === "-d" || token === "--delete");
	if (!deleteFlag) return undefined;
	// A variadic delete deletes every branch it names, so every branch it names
	// needs the user's words. Stopping at the first one authorized the rest.
	const branches = tokens.slice(2).filter(token => !token.startsWith("-"));
	if (branches.length === 0 || branches.some(branch => NOT_PLAIN.test(branch))) return undefined;
	return branches.map(branch => ({ kind: "branch-delete" as const, target: branch, requiredWords: [] }));
}

function ghActions(tokens: readonly string[]): ExtractedAction[] | undefined {
	if (tokens[1] !== "pr" || tokens[2] !== "merge") return undefined;
	const numbers = tokens.slice(3).filter(token => /^\d+$/u.test(token));
	if (numbers.length === 0) return undefined;
	const widening = wideningWords(tokens);
	return numbers.map(number => ({ kind: "merge" as const, target: number, requiredWords: widening }));
}

function deployAction(tokens: readonly string[], verb: string): ExtractedAction {
	const argument = tokens.slice(1).find(token => !token.startsWith("-"));
	const flagTarget = tokens.slice(1).find(token => WIDENING_FLAG.test(token));
	const target = argument ?? (flagTarget ? flagTarget.replace(/^--/u, "") : verb.replace(/\.(sh|ts|js|py)$/u, ""));
	return { kind: "deploy", target, requiredWords: wideningWords(tokens).filter(word => word !== target) };
}

function wideningWords(tokens: readonly string[]): string[] {
	return tokens.filter(token => WIDENING_FLAG.test(token)).map(token => token.replace(/^--/u, "").replace(/-with-lease$/u, ""));
}

/** The part of this action the user's words fail to carry, or undefined when
 *  they carry all of it. */
function unmatchedPart(action: ExtractedAction, words: readonly string[], siblingTargets: ReadonlySet<string>): string | undefined {
	const verbIndexes = indexesOf(words, word => VERB_FORMS[action.kind].allowed.test(word));
	if (verbIndexes.length === 0) return `${action.target} with a ${action.kind} verb in imperative or present form`;
	const targetIndexes = indexesOf(words, word => word === action.target.toLowerCase());
	if (targetIndexes.length === 0) return action.target;
	for (const required of action.requiredWords) {
		if (!words.includes(required.toLowerCase())) return required;
	}
	// The verb has to belong to THIS target. "delete build then merge main"
	// authorizes deleting build and merging main; pairing any verb with any
	// target in the message turns it into authorization to delete main.
	const paired = verbIndexes.some(verb =>
		targetIndexes.some(
			target =>
				Math.abs(target - verb) <= PAIR_WINDOW &&
				sameClause(words, verb, target, siblingTargets) &&
				!cancelled(words, verb) &&
				!cancelled(words, target),
		),
	);
	if (!paired) return `${action.target} next to a ${action.kind} verb, with no restriction or condition nearby`;
	return undefined;
}

function indexesOf(words: readonly string[], predicate: (word: string) => boolean): number[] {
	return words.flatMap((word, index) => (predicate(word) ? [index] : []));
}

/**
 * Whether the verb and the target are parts of one instruction. Everything
 * between them has to be filler or another target of this same command, so
 * "delete release/backup and release/old" pairs both branches while "delete
 * release/backup, keep release/old" pairs only the first.
 */
function sameClause(words: readonly string[], verb: number, target: number, siblingTargets: ReadonlySet<string>): boolean {
	const from = Math.min(verb, target) + 1;
	const to = Math.max(verb, target);
	for (let index = from; index < to; index += 1) {
		const word = words[index];
		if (FILLER.has(word) || siblingTargets.has(word)) continue;
		return false;
	}
	return true;
}

function cancelled(words: readonly string[], index: number): boolean {
	const from = Math.max(0, index - CANCEL_WINDOW);
	const to = Math.min(words.length, index + CANCEL_WINDOW + 1);
	return words.slice(from, to).some((word, offset) => from + offset !== index && CANCEL_WORDS.has(word));
}

/**
 * The user's words, as words. Fenced blocks, inline code and quoted lines are
 * removed first: the plan accepts that "run this: ```rm -rf build```" does not
 * match literally, because the reviewer still sees it, and a document the agent
 * pasted must never authorize anything.
 */
function userWords(messages: readonly string[]): string[] {
	return messages
		.map(message =>
			// A phone and a Mac type `don’t`, not `don't`. The split keeps the
			// ASCII apostrophe and drops everything else, so without this the
			// negation arrives as `don` and `t` and cancels nothing.
			message
				.normalize("NFKC")
				.replace(/[‘’ʼ՚＇]/gu, "'")
				.replace(/[“”]/gu, '"')
				.replace(/```[\s\S]*?```/gu, " ")
				.replace(/`[^`]*`/gu, " ")
				.split("\n")
				.filter(line => !line.trimStart().startsWith(">"))
				.join(" "),
		)
		.join(" ")
		.toLowerCase()
		.split(/[^a-z0-9._\/'-]+/u)
		.filter(word => word.length > 0);
}

function basename(token: string): string {
	return token.split("/").pop() ?? token;
}

function resolvePath(target: string, cwd: string): string {
	const absolute = target.startsWith("/") ? target : `${cwd}/${target}`;
	const parts: string[] = [];
	for (const part of absolute.split("/")) {
		if (part === "" || part === ".") continue;
		if (part === "..") {
			parts.pop();
			continue;
		}
		parts.push(part);
	}
	return `/${parts.join("/")}`;
}

function isInside(candidate: string, root: string): boolean {
	const normalizedRoot = resolvePath(root, "/");
	return candidate === normalizedRoot || candidate.startsWith(`${normalizedRoot}/`);
}

/** True when deletes must never match: the working directory is the home
 *  directory itself, or one of its parents. */
function homeOrAbove(cwd: string, homeDir: string): boolean {
	const normalizedCwd = resolvePath(cwd, "/");
	const normalizedHome = resolvePath(homeDir, "/");
	return normalizedCwd === normalizedHome || isInside(normalizedHome, normalizedCwd);
}
