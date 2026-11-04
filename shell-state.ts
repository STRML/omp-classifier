/**
 * shell-state — what the live session shell says about a command before the
 * stage 2 reviewer may allow it, and the token the host checks again at run
 * time (docs/plans/2026-11-04-stage-2-latch-scope.md, plan v4).
 *
 * The gate used to latch the reviewer off for a whole session once any call
 * might have changed the persistent shell (PR #225). Text could never say
 * which calls did: `printf -v "b[w]"`, `PS4` with `set -x` and
 * `export GIT_SSH_COMMAND` all looked harmless. This module asks the host's
 * shell instead. The host reports how each command word resolves right now,
 * which hooks would run code, and a fingerprint of the whole state. The gate
 * skips review on anything it cannot vouch for. The fingerprint, with the
 * hashes of the files the reviewer read, goes back to the host with the allow,
 * and the host refuses to run when either moved between the gate and the
 * exec.
 *
 * A host without `inspectShellSession` (upstream omp, an older fork build)
 * gets `undefined` from `hostInspector()`, and the caller keeps the old latch.
 */
import * as bashExecutor from "@oh-my-pi/pi-coding-agent/exec/bash-executor";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { createHash } from "node:crypto";
import { hiddenArithmetic, parseShell } from "./shell-ast";
import { isSystemProgram } from "./stage-two";

/** How the live shell would run one command word. */
export type ShellResolution =
	| { kind: "alias"; text: string }
	| { kind: "keyword" }
	| { kind: "special" }
	| { kind: "function" }
	| { kind: "builtin"; usable: boolean }
	| { kind: "hashed"; path: string }
	| { kind: "file"; path: string }
	| { kind: "missing" };

/** The host's report on a session shell (`inspectShellSession`). */
export interface ShellInspectReport {
	/** Hex digest of the shell's whole state, volatile job counters aside. */
	fingerprint: string;
	resolution: Record<string, ShellResolution>;
	/** State that runs code on its own: `trap:DEBUG`, `ps4`, `var:CDPATH`. */
	hooks: string[];
	/** `set -o` and shopt options that differ from a fresh session. */
	optionsChanged: string[];
	/** Exported names whose value differs from the session's first build. */
	exportsChanged: string[];
	/** The snapshot file changed since this shell first sourced it. */
	snapshotChanged: boolean;
	home: string;
	path: string;
}

export type ShellInspector = (sessionKey: string, names: string[]) => Promise<ShellInspectReport | undefined>;

/** The token the bash tool checks under the session lock before it submits. */
export interface ShellStateToken {
	state: string;
	files: { path: string; sha256: string }[];
}

let override: ShellInspector | null | undefined;

/** Tests only: stand in for the host (`null` = a host without the API). */
export function setShellInspectorForTest(inspector: ShellInspector | null | undefined): void {
	override = inspector;
}

/** One entry of the host's report as pi-natives ships it. */
interface HostResolution {
	name: string;
	kind: ShellResolution["kind"];
	text?: string;
	path?: string;
	usable?: boolean;
}

/** The report as `inspectShellSession` returns it: resolution as a list, HOME and PATH optional. */
interface HostReport extends Omit<ShellInspectReport, "resolution" | "home" | "path"> {
	resolution: HostResolution[];
	home?: string;
	path?: string;
}

/** One host entry as the gate reads it; a field the kind needs and lacks reads as missing. */
function fromHost(entry: HostResolution): ShellResolution {
	switch (entry.kind) {
		case "alias":
			return { kind: "alias", text: entry.text ?? "" };
		case "builtin":
			return { kind: "builtin", usable: entry.usable === true };
		case "hashed":
		case "file":
			return entry.path === undefined ? { kind: "missing" } : { kind: entry.kind, path: entry.path };
		case "keyword":
		case "special":
		case "function":
		case "missing":
			return { kind: entry.kind };
		default:
			return { kind: "missing" };
	}
}

/** The host's report in the gate's shape. An unset HOME or PATH never matches the gate's. */
export function fromHostReport(report: HostReport): ShellInspectReport {
	return {
		...report,
		resolution: Object.fromEntries(report.resolution.map(entry => [entry.name, fromHost(entry)])),
		home: report.home ?? "",
		path: report.path ?? "",
	};
}

/** The host's inspector, or undefined when the installed host has none. */
export function hostInspector(): ShellInspector | undefined {
	if (override !== undefined) return override ?? undefined;
	const candidate = (bashExecutor as Record<string, unknown>).inspectShellSession;
	if (typeof candidate !== "function") return undefined;
	const inspect = candidate as (sessionKey: string, names: string[]) => Promise<HostReport | undefined>;
	return async (sessionKey, names) => {
		const report = await inspect(sessionKey, names);
		return report === undefined ? undefined : fromHostReport(report);
	};
}

/** Bash inputs that run somewhere the token is never checked. */
const UNBOUND_ROUTES = ["pty", "async", "name"] as const;

/** The input field the token rides in. The model never sets it. */
export const SHELL_STATE_FIELD = "shellState";

/** Why a bash input cannot carry a token, or undefined. */
export function unboundRoute(input: Record<string, unknown> | undefined): string | undefined {
	const set = UNBOUND_ROUTES.find(key => {
		const value = input?.[key];
		return value !== undefined && value !== false && value !== "";
	});
	return set === undefined ? undefined : `the call runs with \`${set}\`, where the host cannot check the shell state`;
}

/** Text in the command itself whose meaning hangs on state the shapes cannot read. */
const STATEFUL_FORMS: ReadonlyArray<[RegExp, string]> = [
	[/\$\{!/u, "an indirect expansion"],
	[/@P\}/u, "a prompt expansion"],
	[/(?<![\w-])(?:compgen|complete)(?![\w-])/u, "a completion builtin"],
	[/(?<![\w-])(?:mapfile|readarray)\b[^|;&\n]*\s-C/u, "a mapfile callback"],
	[/(?<![\w-])(?:\[|test)\s+(?:[^|;&\n]*\s)?-v(?:\s|$)/u, "a `-v` test, which evaluates a subscript"],
	[/(?<![\w$])~(?:[-+]|\d|[A-Za-z_])/u, "a tilde form other than `~` and `~/`"],
	[/(?<![\w-])(?:pushd|popd)(?![\w-])|\bcd\s+-(?:\s|$|;|&)/u, "a directory-stack move"],
];

/**
 * Why the reviewed command's own text depends on shell state the gate cannot
 * read, or undefined. `touchesShell` is the gate's coarse predicate
 * (`touchesShellEnv`), passed in so this module does not import index.ts.
 */
export function commandStateRefusal(command: string, touchesShell: (command: string) => boolean): string | undefined {
	if (touchesShell(command)) return "the command itself can change the shell";
	const arithmetic = hiddenArithmetic(command);
	if (arithmetic !== undefined) return `the command ${arithmetic}`;
	for (const [pattern, why] of STATEFUL_FORMS) if (pattern.test(command)) return `the command uses ${why}`;
	return undefined;
}

/** Every word in command position, nested substitutions and a leading `cd` included. */
export function commandWords(command: string): string[] | undefined {
	const parsed = parseShell(command);
	if (!parsed.ok) return undefined;
	const words = new Set<string>();
	for (const item of parsed.commands) {
		const verb = item.words[0];
		if (verb === undefined) continue;
		if (!verb.fixed) return undefined;
		words.add(verb.value);
	}
	return [...words];
}

/** What the gate resolved each word to: a file path, or "builtin". */
export type GateResolution = (word: string) => string | "builtin" | undefined;

/** Whether the live shell runs `word` the way the gate read it. */
function resolutionMatches(word: string, live: ShellResolution | undefined, gate: string | "builtin" | undefined): boolean {
	if (live === undefined) return false;
	// A usable builtin is the host's own code (pi runs git, grep and friends
	// in process), whatever file the gate found on PATH. A disabled one falls
	// through to a PATH search the gate did not make.
	if (live.kind === "builtin") return live.usable;
	// The shell hashes every PATH lookup, so a hash entry is the normal state
	// of any name run before; it matches when it names the gate's file
	// (`hash -p ./x tar` names another one).
	if (live.kind === "file" || live.kind === "hashed") return gate !== undefined && gate !== "builtin" && samePath(live.path, gate, isSystemProgram);
	if (live.kind === "keyword") return KEYWORD_VERBS.has(word);
	return false;
}

/** Synthetic verbs the parser reports for compound expressions. */
const KEYWORD_VERBS = new Set(["[[", "(("]);

/**
 * Whether the shell's path `live` is the file the gate read as `gate`. The
 * literal paths must agree, or `live` must be a root-owned system program
 * whose links resolve to the same file: a user-writable link (`hash -p ./link
 * tar` with `./link -> /usr/bin/tar`) can be re-pointed after the review, so
 * agreeing realpaths prove nothing about it.
 */
function samePath(live: string, gate: string, isSystemProgram: (file: string) => boolean): boolean {
	// A relative path (`hash -p ./x tar`) resolves against the run's cwd, which
	// the host sets after the check: it names no file the gate can vouch for.
	if (!path.isAbsolute(live)) return false;
	if (path.resolve(live) === path.resolve(gate)) return true;
	if (!isSystemProgram(live)) return false;
	try {
		return fs.realpathSync(live) === fs.realpathSync(gate);
	} catch {
		return false;
	}
}

/**
 * Why the live shell's report rules the review out, or undefined.
 * `gatePath` is the PATH the gate resolves bare names with.
 */
export function reportRefusal(report: ShellInspectReport, words: readonly string[], gate: GateResolution, gatePath: string | undefined): string | undefined {
	if (report.snapshotChanged) return "the shell snapshot changed after the session started";
	if (report.exportsChanged.length > 0) return `exported ${listed(report.exportsChanged)} changed in the session's shell`;
	if (report.hooks.length > 0) return `the session's shell runs code on its own (${listed(report.hooks)})`;
	if (report.optionsChanged.length > 0) return `the session's shell has options set (${listed(report.optionsChanged)})`;
	if (report.home !== os.homedir()) return "the session's shell has a different HOME";
	if (gatePath !== undefined && report.path !== gatePath) return "the session's shell has a different PATH";
	for (const word of words) {
		if (!resolutionMatches(word, report.resolution[word], gate(word))) return `\`${word}\` runs ${describe(report.resolution[word])} in the session's shell`;
	}
	return undefined;
}

function listed(items: readonly string[]): string {
	return items.length <= 3 ? items.join(", ") : `${items.slice(0, 3).join(", ")} and ${items.length - 3} more`;
}

function describe(live: ShellResolution | undefined): string {
	if (live === undefined) return "something the host did not report";
	if (live.kind === "file" || live.kind === "hashed") return `${live.kind} ${live.path}`;
	if (live.kind === "builtin") return live.usable ? "a builtin" : "a disabled builtin";
	return `a ${live.kind}`;
}

const sha256 = (file: string): string => createHash("sha256").update(fs.readFileSync(file)).digest("hex");

/** A file the allow depends on; `reviewed` is the digest of the bytes the reviewer read. */
export interface TokenFile {
	file: string;
	reviewed?: string;
}

/**
 * The token for an allow: the fingerprint and a hash for every file the
 * decision depends on. A reviewed script carries the digest of the bytes the
 * reviewer read, never a fresh read, and a fresh read that differs voids the
 * allow. A program file nobody read is hashed now.
 */
export function shellStateToken(report: ShellInspectReport, files: readonly TokenFile[]): ShellStateToken | undefined {
	const hashed = new Map<string, string>();
	for (const { file, reviewed } of files) {
		// The literal path the shell opens, not its realpath: the host follows
		// the links again at run time, so a link re-pointed after the review
		// hashes differently and the run is refused.
		const literal = path.resolve(file);
		let now: string;
		try {
			now = sha256(file);
		} catch {
			return undefined;
		}
		if (reviewed !== undefined && now !== reviewed) return undefined;
		const digest = reviewed ?? now;
		if (hashed.has(literal) && hashed.get(literal) !== digest) return undefined;
		hashed.set(literal, digest);
	}
	return { state: report.fingerprint, files: [...hashed].map(([file, digest]) => ({ path: file, sha256: digest })) };
}
