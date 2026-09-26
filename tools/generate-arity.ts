/**
 * Generates `arity.generated.ts`: the command trees and flag arity of the CLIs
 * the action summary reads the option grammar of.
 *
 * The summary could tell `git push -f` from `git push -of` only by keeping a
 * hand-written table of short flags, and #94's three review rounds each found a
 * new spelling of the same class: a leading flag, a flag's value before the
 * subcommand, a flag cluster. Hand-written grammar has an unbounded number of
 * shapes; the tool's own grammar does not.
 *
 * So the grammar comes from the tools. Every probe below is one of the tool's
 * own interfaces — help, long help, or completion — run on this machine:
 *
 *   npm      `npm -l` (long help: usage and options per command) and `npm --help`
 *   yarn     `yarn --help` (a usage line per command, namespaces included)
 *   gh       `gh --help` and `gh <path> --help` (command sections and FLAGS)
 *   docker   `docker --help` and `docker <path> --help`
 *   kubectl  `kubectl --help` and `kubectl <path> --help`
 *   git      `git help -a`, `git --help` and `git <cmd> -h`
 *   brew     `brew --help`, `brew commands` and `brew <cmd> --help` (tree only:
 *            brew's help does not say which of its flags take a value, and a
 *            guessed arity is worse than none)
 *
 * Nothing here touches the network: every probe is a local binary's help or
 * completion, and none of them reads a registry, a cluster, or a repository.
 * That is the whole CI story — the generated file is checked in, the
 * regeneration command is documented in its header, and the test suite checks
 * the table against the live tools where they are installed.
 *
 * Run: bun run generate-arity
 */
import { writeFileSync } from "node:fs";
import { join } from "node:path";

/** One flag as the tool's help spells it: its spellings and whether it takes a
 *  value. A flag the help does not type is not recorded at all. */
export interface FlagReading {
	short?: string;
	long?: string;
	/** The tool's long name without its dashes, when it prints one. */
	valued: boolean;
	/** True when a value is written with `=` and never as the next word. */
	attached: boolean;
}

/** What the generator accumulates for one command path while walking. */
interface ToolReading {
	tool: string;
	version: string;
	sources: string[];
	/** path -> children. The empty path is the tool itself. */
	commands: Map<string, string[]>;
	/** path -> flag readings, keyed by spelling. */
	flags: Map<string, Map<string, FlagReading>>;
	/** Paths whose own help could not be read. */
	unread: string[];
}

const PATH_SEPARATOR = " ";
/** Depth and breadth caps. The summary resolves paths of two or three words,
 *  and a tool that lists thousands of them does not deserve a table of
 *  thousands of them. */
const MAX_DEPTH = 3;
const MAX_PATHS = 400;
/** One probe, in milliseconds. Help is local and immediate; a probe that waits
 *  longer than this is a probe that failed. */
const PROBE_TIMEOUT_MS = 20_000;

// ---------------------------------------------------------------------------
// Running the tools.
// ---------------------------------------------------------------------------

/** Run one probe and return its output. A tool that is missing, or a probe it
 *  rejects, returns undefined: a table with a hole in it is honest, a table
 *  with a guess in it is not. The test suite runs the same probes through this
 *  one function, so the generator and the check cannot drift. */
export function probe(command: readonly string[]): string | undefined {
	// A probe that hangs is a probe that failed: a help screen is local and
	// immediate, and the table must not be built on a command that waits.
	const result = Bun.spawnSync({ cmd: [...command], stdout: "pipe", stderr: "pipe", timeout: PROBE_TIMEOUT_MS });
	const text = result.stdout.toString();
	if (result.exitCode === 0) return text;
	// `git <cmd> -h` exits non-zero while printing the help, and `kubectl
	// version --client` may warn on stderr; whatever came back is still read,
	// and a probe with no output is the only true failure.
	return text.trim() === "" ? undefined : text;
}

const firstLine = (text: string | undefined): string => text?.split("\n")[0]?.trim() ?? "";

// ---------------------------------------------------------------------------
// Parsers. One per help dialect; each takes help text and returns what it can.
// ---------------------------------------------------------------------------

/**
 * Command entries in a sectioned help text: `gh`, `docker`, `kubectl`, `git
 * help -a` and `brew`. An entry is an indented one-word line, optionally
 * followed by a colon and a description (`gh` writes `login:` and puts the
 * description after two spaces; `brew` writes the colon and the description on
 * the following lines; `docker` marks plugin-provided commands with `*`).
 *
 * Section headings are written at column zero, and usage lines put a single
 * space after their first word (`  gh auth <command>`), so neither is an entry.
 */
export function commandSections(help: string): string[] {
	const found = new Set<string>();
	for (const line of help.split("\n")) {
		const match = /^\s{2,}([a-z][a-z0-9-]*)\*?:?(?:\s{2,}\S.*)?$/u.exec(line);
		if (match !== null) found.add(match[1]);
	}
	return [...found];
}

/**
 * Flag readings in a `pflag` (Go) usage block, which is what `gh`, `docker` and
 * `git <cmd> -h` print: `  -X, --method string   The HTTP method`.
 *
 * The tools pad a description to a column, so the flag's own text is what
 * stands before the first run of two spaces. That split is what keeps a
 * one-word description from reading as a value (`-f, --[no-]force      force`
 * takes no value) while a value in the flag's own text still counts
 * (`-e, --exclude <pattern>`). A tool that writes the description on the next
 * line leaves the flag's text alone on its line, which the same rule reads.
 *
 * Three spellings are the tools' own and all three are read: a short spelling
 * with no long form (`-e <pattern>`), git's `--[no-]` prefix on a boolean flag,
 * and a value that is only ever written attached (`[=<refname>]`), which never
 * eats the next word and so is no value here.
 */
export function pflagReadings(help: string): FlagReading[] {
	const readings: FlagReading[] = [];
	for (const line of help.split("\n")) {
		// Padding between two non-spaces, so the line's own indent is not read as
		// the separation between a flag and its description.
		const padding = /\S\s{2,}\S/u.exec(line);
		const spec = padding === null ? line : line.slice(0, padding.index + 1);
		const match = /^\s{2,}((?:-[A-Za-z0-9], )?-{1,2}(?:\[no-\])?[A-Za-z0-9-]+)(.*)$/u.exec(spec);
		if (match === null) continue;
		const spellings = (match[1] as string)
			.replace(/\[no-\]/gu, "")
			.split(", ")
			.filter(spelling => spelling !== "");
		const short = spellings.find(spelling => !spelling.startsWith("--"));
		const long = spellings.find(spelling => spelling.startsWith("--"));
		const rest = match[2] as string;
		if (rest.startsWith("=") || rest.startsWith("[=")) {
			readings.push({ short, long, valued: false, attached: true });
			continue;
		}
		readings.push({ short, long, valued: rest.trim() !== "", attached: false });
	}
	return readings;
}

/**
 * Flag readings in `kubectl`'s usage block, which prints each flag with its
 * default instead of its type: `    --all=false:` and `-o, --output='':`. A
 * default of `false` or `true` is a boolean; anything else is a value.
 */
export function kubectlReadings(help: string): FlagReading[] {
	const readings: FlagReading[] = [];
	for (const line of help.split("\n")) {
		const match = /^\s{2,}(?:(-[A-Za-z0-9]), )?(--[A-Za-z0-9-]+)=(\S*?):?$/u.exec(line);
		if (match === null) continue;
		const [, short, long, initial] = match;
		readings.push({ short, long, valued: initial !== "false" && initial !== "true", attached: false });
	}
	return readings;
}

/**
 * Flag readings in one `npm -l` options line, which writes a bracketed usage
 * form: `[--omit <dev|optional|peer>] [-f|--force] [-w|--workspace <name>]`. A
 * flag followed by a `<meta>` placeholder takes a value.
 */
export function npmFlagReadings(options: string): FlagReading[] {
	const readings: FlagReading[] = [];
	for (const match of options.matchAll(/(-{1,2}[A-Za-z][A-Za-z0-9-]*)(?:\|(-{1,2}[A-Za-z][A-Za-z0-9-]*))?(\s+<[^>]+>)?/gu)) {
		const [, first, second, placeholder] = match;
		const spellings = [first, second].filter((spelling): spelling is string => spelling !== undefined);
		const short = spellings.find(spelling => !spelling.startsWith("--"));
		const long = spellings.find(spelling => spelling.startsWith("--"));
		readings.push({ short, long, valued: placeholder !== undefined, attached: false });
	}
	return readings;
}

/**
 * Flag readings in one `yarn --help` usage line, whose bracketed groups hold
 * the tool's own placeholder: `[--tag #0]`, `[-A,--all]`, `[--mode #0]`.
 */
export function yarnFlagReadings(usage: string): FlagReading[] {
	const readings: FlagReading[] = [];
	for (const group of usage.matchAll(/\[([^\]]*)\]/gu)) {
		const tokens = group[1].split(/\s+/u).filter(token => token !== "");
		for (let index = 0; index < tokens.length; index += 1) {
			const spellings = tokens[index].split(",").filter(spelling => spelling.startsWith("-"));
			if (spellings.length === 0) continue;
			const next = tokens[index + 1] ?? "";
			const valued = /^#\d+$/u.test(next) || /^<[^>]+>$/u.test(next);
			readings.push({
				short: spellings.find(spelling => !spelling.startsWith("--")),
				long: spellings.find(spelling => spelling.startsWith("--")),
				valued,
				attached: false,
			});
			if (valued) index += 1;
		}
	}
	return readings;
}

/**
 * git's global flags, which `git --help` states in its own usage line and
 * nowhere else: `[-C <path>] [-c <name>=<value>] [--exec-path[=<path>]]`.
 * `parse-options` writes one bracketed group per flag, so the groups are the
 * table. Without them `git -C /repo push` would read `/repo` as the subcommand.
 */
export function gitGlobalReadings(help: string): FlagReading[] {
	const readings: FlagReading[] = [];
	// The usage block: from the `usage:` line to the blank line that ends it.
	const lines = help.split("\n");
	const start = lines.findIndex(line => /^usage:/u.test(line));
	const stop = lines.findIndex((line, at) => at > start && line.trim() === "");
	const usage = lines.slice(start < 0 ? 0 : start, stop < 0 ? lines.length : stop).join("\n");
	for (const group of bracketGroups(usage)) {
		// One group can hold more than one flag: git writes `[-p | --paginate |
		// -P | --no-pager]`, where each short spelling pairs with the long one
		// after it.
		const spellings: string[] = [];
		let valued = false;
		let attached = false;
		for (const token of group.split(/[\s|]+/u).filter(token => token !== "")) {
			if (token.startsWith("-")) {
				// `--git-dir=<path>` and `--exec-path[=<path>]` never eat the
				// next word: only the attached spelling exists.
				const spec = token.replace(/\[?=.*$/u, "");
				spellings.push(spec);
				if (spec !== token) attached = true;
				continue;
			}
			if (/[<(]/u.test(token)) valued = true;
		}
		if (spellings.length === 0) continue;
		let short: string | undefined;
		for (const spelling of spellings) {
			if (spelling.startsWith("--")) {
				readings.push({ short, long: spelling, valued: valued && !attached, attached });
				short = undefined;
				continue;
			}
			if (short !== undefined) readings.push({ short, valued: valued && !attached, attached });
			short = spelling;
		}
		if (short !== undefined) readings.push({ short, valued: valued && !attached, attached });
	}
	return readings;
}

/** Every `[…]` group in a text, at any depth, without its outer brackets. */
export function bracketGroups(text: string): string[] {
	const groups: string[] = [];
	let depth = 0;
	let start = 0;
	for (let at = 0; at < text.length; at += 1) {
		if (text[at] === "[") {
			if (depth === 0) start = at + 1;
			depth += 1;
		} else if (text[at] === "]" && depth > 0) {
			depth -= 1;
			if (depth === 0) groups.push(text.slice(start, at));
		}
	}
	return groups;
}

/** The leading plain words of a usage line, stopping at the first placeholder,
 *  group, or value: `npm access set status=public|private` is `access set`, and
 *  `npm run <command>` is `run`. That is the command path the tool itself
 *  prints, so nothing here decides what a subcommand is. */
export function leadingWords(text: string): string[] {
	const words: string[] = [];
	for (const token of text.trim().split(/\s+/u)) {
		if (!/^[a-z][a-z0-9-]*$/u.test(token)) break;
		words.push(token);
	}
	return words;
}

// ---------------------------------------------------------------------------
// Walking a tool.
// ---------------------------------------------------------------------------

const pathKey = (path: readonly string[]): string => path.join(PATH_SEPARATOR);

function record(reading: ToolReading, path: readonly string[], flags: readonly FlagReading[]): void {
	const key = pathKey(path);
	const table = reading.flags.get(key) ?? new Map<string, FlagReading>();
	for (const flag of flags) {
		for (const spelling of [flag.short, flag.long]) {
			if (spelling === undefined) continue;
			// One spelling, one reading: a tool that prints the same short
			// spelling twice in one help is printing its own inconsistency, and
			// the later line wins rather than a merged guess.
			table.set(spelling, flag);
		}
	}
	reading.flags.set(key, table);
}

function addChildren(reading: ToolReading, path: readonly string[], children: readonly string[]): void {
	if (path.length >= MAX_DEPTH) return;
	const key = pathKey(path);
	const known = reading.commands.get(key) ?? [];
	for (const child of children) if (!known.includes(child)) known.push(child);
	reading.commands.set(key, known);
}

/** A cobra CLI: the sections of its own help name its commands, and each
 *  command's help names the next level and its flags. */
function readCobra(tool: string, version: string, rootHelp: string, help: (path: readonly string[]) => string | undefined): ToolReading {
	const reading: ToolReading = { tool, version, sources: [`${tool} --help`, `${tool} <path> --help`], commands: new Map(), flags: new Map(), unread: [] };
	const root = commandSections(rootHelp);
	addChildren(reading, [], root);
	record(reading, [], pflagReadings(rootHelp));
	const queue: string[][] = root.map(word => [word]);
	const seen = new Set<string>();
	while (queue.length > 0 && seen.size < MAX_PATHS) {
		const path = queue.shift() as string[];
		const key = pathKey(path);
		if (seen.has(key)) continue;
		seen.add(key);
		const text = help(path);
		if (text === undefined) {
			reading.unread.push(key);
			continue;
		}
		// `kubectl` prints defaults, `gh` and `docker` print types.
		const flags = tool === "kubectl" ? kubectlReadings(text) : pflagReadings(text);
		record(reading, path, flags);
		const children = commandSections(text).filter(word => word !== path[path.length - 1]);
		addChildren(reading, path, children);
		if (path.length < MAX_DEPTH) for (const child of children) queue.push([...path, child]);
	}
	return reading;
}

/**
 * The commands in `npm --help`'s own `All commands:` list: the lines under the
 * heading, up to the blank line that ends the section. (npm's help ends with
 * prose about `.npmrc` files, and prose words are not commands.)
 */
export function npmCommands(listing: string): string[] {
	const heading = /^All commands:\s*$/mu.exec(listing);
	if (heading === null) return [];
	const commands: string[] = [];
	let started = false;
	for (const line of listing.slice(heading.index).split("\n").slice(1)) {
		const words = line.split(/[,\s]+/u).filter(word => /^[a-z][a-z0-9-]*$/u.test(word));
		if (words.length === 0) {
			if (started) break;
			continue;
		}
		started = true;
		commands.push(...words);
	}
	return commands;
}

/** npm: one long help lists every command with its usage and options. */
function readNpm(): ToolReading {
	const version = firstLine(probe(["npm", "--version"])).trim();
	const long = probe(["npm", "-l"]);
	const listing = probe(["npm", "--help"]) ?? "";
	const reading: ToolReading = { tool: "npm", version, sources: ["npm -l", "npm --help"], commands: new Map(), flags: new Map(), unread: [] };
	addChildren(reading, [], npmCommands(listing));
	if (long === undefined) {
		reading.unread.push("");
		return reading;
	}
	// Every block is one command: its heading word, the usage lines naming the
	// paths under it, and the options that apply to all of them.
	let heading: string[] | undefined;
	let paths: string[][] = [];
	let options: string[] = [];
	const flush = (): void => {
		if (heading === undefined) return;
		const readings = npmFlagReadings(options.join(" "));
		for (const path of [heading, ...paths]) record(reading, path, readings);
		heading = undefined;
		paths = [];
		options = [];
	};
	for (const line of long.split("\n")) {
		const block = /^\s{4}([a-z][a-z0-9-]*)\s{2,}\S/u.exec(line);
		if (block !== null) {
			flush();
			heading = [block[1]];
			addChildren(reading, [], [block[1]]);
			continue;
		}
		if (heading === undefined) continue;
		const usage = /^\s+npm\s+(\S.*)$/u.exec(line);
		if (usage !== null) {
			const words = leadingWords(usage[1] as string);
			// The first word is the block's own command; the rest is the path
			// under it (`npm access list packages …`).
			if (words.length > 0 && words[0] === heading[0]) {
				const path = words.slice(0, MAX_DEPTH);
				paths.push(path);
				for (let depth = 1; depth < path.length; depth += 1) addChildren(reading, path.slice(0, depth), [path[depth]]);
			}
			continue;
		}
		if (/^\s+\[/u.test(line)) options.push(line);
	}
	flush();
	return reading;
}

/** yarn: one help lists every command, namespaces included, with its usage. */
function readYarn(): ToolReading {
	const version = firstLine(probe(["yarn", "--version"])).trim();
	const help = probe(["yarn", "--help"]);
	const reading: ToolReading = { tool: "yarn", version, sources: ["yarn --help"], commands: new Map(), flags: new Map(), unread: [] };
	if (help === undefined) {
		reading.unread.push("");
		return reading;
	}
	for (const line of help.split("\n")) {
		const match = /^\s*yarn\s+(\S.*)$/u.exec(line.trimEnd());
		if (match === null) continue;
		const words = leadingWords(match[1] as string);
		if (words.length === 0) continue;
		addChildren(reading, [], [words[0]]);
		for (let depth = 1; depth < words.length; depth += 1) addChildren(reading, words.slice(0, depth), [words[depth]]);
		record(reading, words.slice(0, MAX_DEPTH), yarnFlagReadings(match[1] as string));
	}
	return reading;
}

/** git: `help -a` names the commands, `git <cmd> -h` prints each one's flags. */
function readGit(): ToolReading {
	const version = firstLine(probe(["git", "--version"])).trim();
	const listing = probe(["git", "help", "-a"]) ?? "";
	const rootHelp = probe(["git", "--help"]) ?? "";
	const reading: ToolReading = { tool: "git", version, sources: ["git help -a", "git --help", "git <cmd> -h"], commands: new Map(), flags: new Map(), unread: [] };
	const commands = commandSections(listing);
	addChildren(reading, [], commands);
	// `git --help` prints its global flags only in its usage line.
	record(reading, [], gitGlobalReadings(rootHelp));
	// `git help -a` lists commands this build does not have (contrib commands,
	// aliases from other packages): a probe that prints nothing is recorded as
	// unread rather than as a command with no flags.
	for (const command of commands.slice(0, MAX_PATHS)) {
		const help = probe(["git", command, "-h"]);
		if (help === undefined || /^usage: git/u.test(help) === false) {
			reading.unread.push(command);
			continue;
		}
		record(reading, [command], pflagReadings(help));
	}
	return reading;
}

/** brew: the command list and each command's own subcommands. Its help does not
 *  type its flags, so the table carries no flag arity for brew at all. */
function readBrew(): ToolReading {
	const version = firstLine(probe(["brew", "--version"])).trim();
	const listing = probe(["brew", "commands"]) ?? "";
	const reading: ToolReading = { tool: "brew", version, sources: ["brew --version", "brew commands", "brew <cmd> --help (subcommands)"], commands: new Map(), flags: new Map(), unread: [] };
	const commands = listing
		.split("\n")
		.map(line => line.trim())
		.filter(line => /^[a-z][a-z0-9-]*$/u.test(line));
	addChildren(reading, [], commands);
	for (const command of commands.slice(0, MAX_PATHS)) {
		const help = probe(["brew", command, "--help"]);
		if (help === undefined) {
			reading.unread.push(command);
			continue;
		}
		const section = /^\s*Subcommands:\s*$/mu.exec(help);
		if (section === null) continue;
		addChildren(reading, [command], commandSections(help.slice(section.index)));
	}
	return reading;
}

// ---------------------------------------------------------------------------
// Emitting the table.
// ---------------------------------------------------------------------------

const sorted = <T>(values: Iterable<T>, key: (value: T) => string): T[] => [...values].sort((a, b) => (key(a) < key(b) ? -1 : key(a) > key(b) ? 1 : 0));

/** The long name of a flag without its dashes: `--push-option` is
 *  `push-option`. A short spelling with no long form is left undefined. */
const longName = (flag: FlagReading): string | undefined => flag.long?.replace(/^--/u, "");

function emit(reading: ToolReading): string[] {
	const commands = sorted(reading.commands.entries(), ([key]) => key)
		.filter(([, children]) => children.length > 0)
		.map(([key, children]) => `\t\t${JSON.stringify(key)}: [${sorted(children, child => child).map(child => JSON.stringify(child)).join(", ")}],`);
	const valued: string[] = [];
	const boolean: string[] = [];
	const widening: string[] = [];
	for (const [key, table] of sorted(reading.flags.entries(), ([key]) => key)) {
		const takesValue = sorted([...table.entries()].filter(([, flag]) => flag.valued), ([spelling]) => spelling);
		if (takesValue.length > 0) {
			valued.push(`\t\t${JSON.stringify(key)}: {${takesValue.map(([spelling, flag]) => `${JSON.stringify(spelling)}: ${JSON.stringify(longName(flag) ?? "")}`).join(", ")}},`);
		}
		// A short spelling known to take no value is what a cluster needs: it
		// says the next letter is another flag rather than this one's value.
		// A short spelling with no long form counts too (`git clean -X`).
		const shorts = sorted(
			[...table.entries()].filter(([, flag]) => !flag.valued && flag.short !== undefined),
			([spelling]) => spelling,
		);
		if (shorts.length > 0) {
			boolean.push(`\t\t${JSON.stringify(key)}: [${shorts.map(([spelling]) => JSON.stringify(spelling)).join(", ")}],`);
		}
		const wideners = shorts.filter(([, flag]) => WIDENING_NAME.test(longName(flag) ?? ""));
		if (wideners.length > 0) {
			widening.push(`\t\t${JSON.stringify(key)}: {${wideners.map(([spelling, flag]) => `${JSON.stringify(spelling)}: ${JSON.stringify(longName(flag) ?? "")}`).join(", ")}},`);
		}
	}
	const header = [
		`\t${JSON.stringify(reading.tool)}: {`,
		`\t\tversion: ${JSON.stringify(reading.version)},`,
		`\t\tsources: [${reading.sources.map(source => JSON.stringify(source)).join(", ")}],`,
		`\t\tcommands: {`,
		...commands,
		`\t\t},`,
		`\t\tvalued: {`,
		...valued,
		`\t\t},`,
		`\t\tboolean: {`,
		...boolean,
		`\t\t},`,
		`\t\twidening: {`,
		...widening,
		`\t\t},`,
		`\t\tunread: [${sorted(reading.unread, value => value).map(value => JSON.stringify(value)).join(", ")}],`,
		`\t},`,
	];
	return header;
}

/** The flags whose long spelling widens an action. The list is policy, not
 *  grammar: it says which flags the summary must carry because the user has to
 *  have asked for the wide version. The names themselves are the tool's. */
const WIDENING_NAME = /^(admin|force|force-with-lease|force-if-includes|no-verify|hard|prod|production|yes|all|mirror|delete|delete-branch|tags|prune)$/u;

function main(): void {
	// The version is the tool's own first line, verbatim: a normalization is a
	// claim about the tool's text, and the table's header is a record of it.
	const version = (...command: string[]): string => firstLine(probe(command)).trim();
	const readings = [
		readNpm(),
		readYarn(),
		readCobra("gh", version("gh", "--version"), probe(["gh", "--help"]) ?? "", path => probe(["gh", ...path, "--help"])),
		readCobra("docker", version("docker", "--version"), probe(["docker", "--help"]) ?? "", path => probe(["docker", ...path, "--help"])),
		readCobra("kubectl", version("kubectl", "version", "--client"), probe(["kubectl", "--help"]) ?? "", path => probe(["kubectl", ...path, "--help"])),
		readGit(),
		readBrew(),
	];
	const body = readings.flatMap(emit).join("\n");
	const file = `/**
 * GENERATED by \`bun run generate-arity\` (tools/generate-arity.ts). Do not edit.
 *
 * The command trees and flag arity the action summary reads option grammar
 * from, generated from each tool's own help and completion on the machine that
 * ran the generator: the table is only as good as those probes, so each tool
 * records the version it answered with. Regenerate when a tool moves and
 * \`tests/arity-tables.test.ts\` reports that the table and the tool disagree.
 *
 * The tables are grammar, not policy: which subcommands reach the network,
 * which flags widen an action, and what a kind means are decisions this
 * repository makes (\`authorization.ts\`). What is here is what the tools
 * themselves say about their own spelling.
 *
 * \`unread\` names the paths whose own help could not be read. They carry the
 * tree the parent's help gave them and no flag arity at all.
 */
export interface ArityReading {
	/** children by parent path, the empty path being the tool itself */
	commands: Record<string, readonly string[]>;
	/** flag spellings that take a value, by path: spelling -> long name, "" when
	 *  the tool prints no long form for it */
	valued: Record<string, Record<string, string>>;
	/** short spellings known to take no value, by path */
	boolean: Record<string, readonly string[]>;
	/** short spellings whose long name widens an action, by path */
	widening: Record<string, Record<string, string>>;
}

export interface ToolArity extends ArityReading {
	/** the version the tool answered its probes with */
	version: string;
	/** the probes, for review: what this table was read from */
	sources: readonly string[];
	/** the paths whose own help could not be read */
	unread: readonly string[];
}

/** Read from each tool on this machine; see the module header. */
export const ARITY_TOOLS: Record<string, ToolArity> = {
${body}
};

/** Path separator of the tables' keys. */
export const ARITY_PATH_SEPARATOR = ${JSON.stringify(PATH_SEPARATOR)};
`;
	writeFileSync(join(import.meta.dir, "..", "arity.generated.ts"), file);
	// The versions are the point of the header, so print them: a regeneration
	// that moves a tool version is a change a reviewer wants to see first.
	for (const reading of readings) console.log(`${reading.tool} ${reading.version}: ${reading.flags.size} paths with flags, ${reading.unread.length} unread`);
}

if (import.meta.main) main();
