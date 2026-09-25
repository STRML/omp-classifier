/**
 * The generated tool grammars (plan `docs/plans/2026-09-22-real-shell-parser.md`,
 * section 2, "Opposed requests").
 *
 * `arity.generated.ts` holds what each CLI says about its own commands and
 * flags, read from that tool's help and completion by `tools/generate-arity.ts`.
 * This module is its only reader, and it answers the three questions the
 * summary has about a tool: is this word one of your commands, does this flag
 * take a value, and what does this short spelling mean.
 *
 * The questions exist because bash does not know the answers. A subcommand
 * path is named only as far as the grammar goes, and past a flag, whether the
 * next word is a subcommand or that flag's value is the CLI's own knowledge:
 * `npm --silent audit` and `gh api -X GET`. #94's review rounds found a new
 * spelling of that class each time, and every one of them was a hole in a
 * hand-written table, so the tables are generated now and there is nothing left
 * to guess at.
 *
 * What is *not* here is policy: which subcommands reach the network, which
 * flags widen an action, and what each kind means stay in `authorization.ts`,
 * because they are this repository's decisions rather than the tools'. A tool
 * that the table does not carry has no grammar here, and its callers keep the
 * behavior they had before the table existed.
 */
import { ARITY_PATH_SEPARATOR, ARITY_TOOLS, type ToolArity } from "./arity.generated";

/** What the summary may ask about a flag under one command path. */
export interface FlagGrammar {
	/**
	 * The tool's long name for a spelling that takes a value, without its
	 * dashes, or "" when the tool prints no long form (`git -C <path>`). An
	 * undefined answer means this grammar does not know the spelling at all.
	 */
	valued(spelling: string): string | undefined;
	/** True when the tool prints this short spelling and gives it no value. */
	boolean(spelling: string): boolean;
	/** The name a short spelling widens with, when the tool's own long name is
	 *  one of the widening names. */
	widening(spelling: string): string | undefined;
}

/** One tool's grammar, as far as its own help and completion described it. */
export interface ToolGrammar {
	/** The version the tool answered its probes with. */
	readonly version: string;
	/** True when the tool lists `word` as one of its commands under `path`. */
	names(path: readonly string[], word: string): boolean;
	/** The flag grammar at `path`, or undefined when the table has none: a path
	 *  whose own help could not be read, or one the tool does not have. */
	flags(path: readonly string[]): FlagGrammar | undefined;
}

/** Path keys are words joined by one space, the generated file's own spelling
 *  of a path. */
const keyOf = (path: readonly string[]): string => path.join(ARITY_PATH_SEPARATOR);

const grammarOf = (table: ToolArity): ToolGrammar => ({
	version: table.version,
	names: (path, word) => (table.commands[keyOf(path)] ?? []).includes(word),
	flags: path => {
		const key = keyOf(path);
		const valued = table.valued[key];
		const booleans = table.boolean[key];
		const widening = table.widening[key];
		if (valued === undefined && booleans === undefined) return undefined;
		return {
			valued: spelling => valued?.[spelling],
			boolean: spelling => booleans?.includes(spelling) ?? false,
			widening: spelling => widening?.[spelling],
		};
	},
});

/** The grammar of one tool, keyed by the name the tool goes by, or undefined
 *  when the repository has none for it. Callers spell that name the way the
 *  table does (`npm`, not `/usr/local/bin/npm`). */
export function toolGrammar(tool: string): ToolGrammar | undefined {
	const table = ARITY_TOOLS[tool];
	return table === undefined ? undefined : grammarOf(table);
}

/** The tools the tables were generated from, for the record and for tests. */
export function generatedTools(): ReadonlyArray<{ tool: string; version: string; sources: readonly string[] }> {
	return Object.entries(ARITY_TOOLS).map(([tool, table]) => ({ tool, version: table.version, sources: table.sources }));
}
