/**
 * The floor against a real shell.
 *
 * Every defect in `floor.ts` since it was written has been a shell rule written
 * from memory of what a shell does: a quoted capture read as a print, `2>/dev/null`
 * read as the allowed sink, `nohup` / `command` / `builtin` listed as assignment
 * prefixes, and a scan that let a literal `env` in argument position restore
 * assignment position. Each fix was right for the case in front of it and wrong
 * for the next spelling, because the rules were never checked against a shell.
 *
 * So this fixture asks the shell. Each shape runs in a real `bash` with stub
 * secret sources on `PATH`, and what the shell did is compared with what
 * `evaluateFloor` answers.
 *
 * The oracle watches four channels, because a draft that watched stdout alone
 * reported four false mismatches:
 *
 *   - stdout of the shell,
 *   - stderr of the shell,
 *   - every file the command wrote in its working directory,
 *   - the sink process `pbcopy`, whose stub appends stdin to a capture file.
 *
 * Two kinds of row, and the difference is kept explicit because flattening it
 * would either fail the fixture or hide a leak:
 *
 *   - `oracle`: the shell's own exposure decides. `asks === exposed`.
 *   - `policy`: the write lands outside the directory the file channel walks, so
 *     the oracle cannot see it. A file sink asks by policy (`floor.ts`,
 *     `routeStdout`), so the row asserts that policy and its stated reason
 *     rather than the oracle's blind spot.
 *
 * Running it: it lives in the default `bun test` run. The CI image is
 * `ubuntu-latest`, which has bash 5, so the fixture is exercised on every push.
 * A machine whose bash is too old to parse a spelling gets that row named in
 * the report instead of silently dropped, and a host with no bash fails the
 * fixture, naming the binary it could not spawn, rather than passing vacuously.
 * `bun test tests/shell-oracle.test.ts` runs it alone, and `JEV_ORACLE_BASH`
 * picks the interpreter by hand.
 *
 * Two shapes are deliberately NOT rows, because the shell exposes nothing and
 * the floor asks anyway, which is its safe direction rather than a defect:
 * `env -i KEY=$(…) true` and `KEY=$(…) printf '%s\n' "$KEY"` (bash expands the
 * arguments of a command before the temporary assignment takes effect). The
 * second is already pinned as intended by `tests/floor.test.ts` ("a capture and
 * a sink in the same segment both count").
 */
import { afterAll, describe, expect, test } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { evaluateFloor } from "../floor";

const SECRET = "jev-oracle-secret-1f4c9a";

/** The stubs, all in a temp directory prepended to `PATH`. `security` prints
 *  its value only with `-w`, as the real one does; `op` only for `read`; and
 *  `pbcopy` is the sink process the oracle watches. */
const STUBS: Record<string, string> = {
	security: `#!/bin/sh
for arg in "$@"; do
	if [ "$arg" = "-w" ]; then printf '%s\\n' "$JEV_ORACLE_SECRET"; exit 0; fi
done
printf '%s\\n' "security: metadata only"
`,
	op: `#!/bin/sh
if [ "$1" = "read" ]; then printf '%s\\n' "$JEV_ORACLE_SECRET"; else printf '%s\\n' "op: usage"; fi
`,
	pass: `#!/bin/sh
printf '%s\\n' "$JEV_ORACLE_SECRET"
`,
	pbcopy: `#!/bin/sh
cat >> "$JEV_ORACLE_SINK"
`,
};

type ShapeMode = "oracle" | "policy";

interface Shape {
	/** The command text, exactly as the floor receives it. */
	command: string;
	/** Which of the two assertions above this row takes. */
	mode: ShapeMode;
	/** The mistake the row exists to catch, or why the oracle cannot see the write. */
	note: string;
}

/** The 24 shapes: the captures in every quoting, the redirect spellings, the
 *  wrapper prefixes, the quoted read commands, and one file sink the oracle
 *  cannot see. */
const SHAPES: Shape[] = [
	{
		command: "KEY=$(security find-generic-password -s neuralwatt -w)",
		mode: "oracle",
		note: "an unquoted capture is an allowed sink, so nothing is printed",
	},
	{
		command: 'KEY="$(security find-generic-password -s neuralwatt -w)"',
		mode: "oracle",
		note: "a quoted capture is the same capture",
	},
	{
		command: "KEY=`security find-generic-password -s neuralwatt -w`",
		mode: "oracle",
		note: "a backticked capture is the same capture again",
	},
	{
		command: "export KEY=$(op read op://v/i/c)",
		mode: "oracle",
		note: "`export KEY=$(…)` captures too, and prints nothing",
	},
	{
		command: 'KEY=$(security find-generic-password -s neuralwatt -w); printf \'%s\\n\' "$KEY"',
		mode: "oracle",
		note: "the capture taints the variable for the commands after it, which print it",
	},
	{
		command: "security find-generic-password -s neuralwatt -w",
		mode: "oracle",
		note: "a store read with no redirect prints, so it asks",
	},
	{
		command: 'security "find-generic-password" -s neuralwatt -w',
		mode: "oracle",
		note: "the shell joins a quoted word back into one word, so quoting the read command hides nothing",
	},
	{
		command: 'sec"urity" find-generic-password -s neuralwatt -w',
		mode: "oracle",
		note: "the same for a quoted piece of the verb",
	},
	{
		command: "pass 'show' services/x",
		mode: "oracle",
		note: "the second store, with its own quoted read command",
	},
	{
		command: "security find-generic-password -s neuralwatt -w | pbcopy",
		mode: "oracle",
		note: "a sink process piped into: the oracle watches the capture file pbcopy writes",
	},
	{
		command: "security find-generic-password -s neuralwatt -w &> out.txt",
		mode: "oracle",
		note: "`&>` is one redirect of both streams to a file, not a background operator",
	},
	{
		command: "security find-generic-password -s neuralwatt -w &>> out.txt",
		mode: "oracle",
		note: "`&>>` appends both streams; bash before 4 does not parse it, which the report names",
	},
	{
		command: "security find-generic-password -s neuralwatt -w >& out.txt",
		mode: "oracle",
		note: "`>&` with a filename is the same redirect spelled the other way",
	},
	{
		command: "security find-generic-password -s neuralwatt -w 2> err.txt",
		mode: "oracle",
		note: "the digit binds to its redirect: 2> moves stderr, and the secret prints on stdout",
	},
	{
		command: "security find-generic-password -s neuralwatt -w 2>/dev/null",
		mode: "oracle",
		note: "the round-2 shape: discarding stderr discards the error message, not the secret",
	},
	{
		command: "security find-generic-password -s neuralwatt -w 1>&2",
		mode: "oracle",
		note: "stdout onto stderr is still a print, which the stderr channel catches",
	},
	{
		command: "security find-generic-password -s neuralwatt -w &>/dev/null",
		mode: "oracle",
		note: "the null device for both streams is an allowed sink",
	},
	{
		command: 'security find-generic-password -s neuralwatt -w ">/dev/null"',
		mode: "oracle",
		note: "a quoted redirect is an argument, so the secret still prints",
	},
	{
		command: "nohup TOKEN=$(op read op://v/i/c) true",
		mode: "oracle",
		note: "the round-3 shape: under nohup the word is a command NAME, and the shell's error message prints the secret",
	},
	{
		command: "command TOKEN=$(op read op://v/i/c) true",
		mode: "oracle",
		note: "the same for `command`",
	},
	{
		command: "builtin TOKEN=$(op read op://v/i/c) true",
		mode: "oracle",
		note: "and for `builtin`",
	},
	{
		command: "env TOKEN=$(op read op://v/i/c) true",
		mode: "oracle",
		note: "under `env` the word IS an assignment, and a command after it makes it the allowed sink",
	},
	{
		command: "echo env TOKEN=$(op read op://v/i/c)",
		mode: "oracle",
		note: "the round-4 shape: a literal `env` in argument position is not assignment position",
	},
	{
		command: 'security find-generic-password -s neuralwatt -w > "$JEV_ORACLE_UNWATCHED/leak.txt"',
		mode: "policy",
		note: "the file channel walks the command's working directory, so this write is invisible to the oracle; a file sink asks by policy, which this row asserts with its reason",
	},
];

/** The interpreter the fixture drives. The first `bash` on `PATH`, unless it
 *  cannot parse the newer redirect spellings and a newer one is available
 *  further along `PATH`: a shape the interpreter rejects cannot test how the
 *  floor reads it, and stock macOS ships bash 3.2 with a 5.x often installed
 *  beside it. `JEV_ORACLE_BASH` overrides the choice. */
function resolveBash(): string {
	const configured = process.env.JEV_ORACLE_BASH;
	if (configured !== undefined && configured.length > 0) return configured;
	const candidates: string[] = [];
	for (const dir of (process.env.PATH ?? "").split(delimiter)) {
		if (dir.length === 0) continue;
		const candidate = join(dir, "bash");
		try {
			if (statSync(candidate).isFile()) candidates.push(candidate);
		} catch {
			// A `bash` this process cannot stat is not a candidate.
		}
	}
	const first = candidates[0] ?? "bash";
	return candidates.find(candidate => /version ([4-9]|\d\d)\./u.test(bashVersion(candidate))) ?? first;
}

function bashVersion(bash: string): string {
	const result = Bun.spawnSync([bash, "--version"], { stdout: "pipe", stderr: "pipe" });
	return result.stdout.toString().split("\n", 1)[0]?.trim() ?? "";
}

const BASH = resolveBash();
const VERSION = bashVersion(BASH);
const PARSED = new Map<string, boolean>();

/** Whether the fixture's bash parses the shape at all: bash before 4 rejects
 *  `&>>`, and a row this interpreter cannot read is reported rather than
 *  silently skipped. Memoized, since the skip decision and the report both ask. */
function parses(command: string): boolean {
	const cached = PARSED.get(command);
	if (cached !== undefined) return cached;
	const ok = Bun.spawnSync([BASH, "-n", "-c", command], { stdout: "pipe", stderr: "pipe" }).exitCode === 0;
	PARSED.set(command, ok);
	return ok;
}

interface Fixture {
	root: string;
	bin: string;
	scratch: string;
	sink: string;
	unwatched: string;
	env: Record<string, string>;
}

/** The stub directory, the directory the command runs in, the capture file the
 *  sink stub writes, and a directory the file channel deliberately does not
 *  walk. The environment is built rather than inherited, so a `BASH_ENV` or an
 *  aliased `bash` in the caller's shell cannot change what runs. */
function makeFixture(): Fixture {
	const root = mkdtempSync(join(tmpdir(), "jev-oracle-"));
	const bin = join(root, "bin");
	const scratch = join(root, "scratch");
	const state = join(root, "state");
	const unwatched = join(root, "unwatched");
	for (const dir of [bin, scratch, state, unwatched]) mkdirSync(dir, { recursive: true });
	for (const [name, body] of Object.entries(STUBS)) {
		const file = join(bin, name);
		writeFileSync(file, body);
		chmodSync(file, 0o755);
	}
	const sink = join(state, "sink");
	writeFileSync(sink, "");
	return {
		root,
		bin,
		scratch,
		sink,
		unwatched,
		env: {
			PATH: `${bin}${delimiter}${process.env.PATH ?? ""}`,
			HOME: state,
			LC_ALL: "C",
			JEV_ORACLE_SECRET: SECRET,
			JEV_ORACLE_SINK: sink,
			JEV_ORACLE_UNWATCHED: unwatched,
		},
	};
}

const FIXTURE = makeFixture();
afterAll(() => rmSync(FIXTURE.root, { recursive: true, force: true }));

interface Observation {
	/** What the shell did, across all four channels. */
	exposed: boolean;
	/** The channels the secret was found in, for the report. */
	channels: string[];
}

const OBSERVED = new Map<string, Observation>();

function filesUnder(dir: string): string[] {
	const found: string[] = [];
	for (const entry of readdirSync(dir, { withFileTypes: true })) {
		const path = join(dir, entry.name);
		if (entry.isDirectory()) found.push(...filesUnder(path));
		else found.push(path);
	}
	return found;
}

/** Run one shape in the real shell and look for the secret in all four
 *  channels. Memoized: the report prints what the rows already observed. */
function observe(command: string): Observation {
	const cached = OBSERVED.get(command);
	if (cached !== undefined) return cached;
	// Fresh ground for every shape: a stale file would read as a write this
	// command did not make.
	rmSync(FIXTURE.scratch, { recursive: true, force: true });
	mkdirSync(FIXTURE.scratch, { recursive: true });
	writeFileSync(FIXTURE.sink, "");
	const result = Bun.spawnSync([BASH, "-c", command], {
		cwd: FIXTURE.scratch,
		env: FIXTURE.env,
		stdout: "pipe",
		stderr: "pipe",
	});
	const secret = Buffer.from(SECRET);
	const channels: string[] = [];
	if (result.stdout.includes(secret)) channels.push("stdout");
	if (result.stderr.includes(secret)) channels.push("stderr");
	for (const file of filesUnder(FIXTURE.scratch)) {
		if (readFileSync(file).includes(secret)) channels.push(`file:${file.slice(FIXTURE.scratch.length + 1)}`);
	}
	if (readFileSync(FIXTURE.sink).includes(secret)) channels.push("sink:pbcopy");
	const observation = { exposed: channels.length > 0, channels };
	OBSERVED.set(command, observation);
	return observation;
}

const UNPARSEABLE = SHAPES.filter(shape => !parses(shape.command)).map(shape => shape.command);

describe("the floor against a real shell", () => {
	for (const shape of SHAPES) {
		const label = shape.mode === "oracle" ? "the shell decides" : "the policy decides";
		test.skipIf(!parses(shape.command))(`${label} — ${shape.command}`, () => {
			const seen = observe(shape.command);
			const result = evaluateFloor({ command: shape.command });
			const verdict = `exposed=${seen.exposed} asks=${result.asks} channels=[${seen.channels.join(", ")}] findings=[${result.findings.map(finding => `${finding.entry}: ${finding.detail}`).join("; ")}]`;
			if (shape.mode === "policy") {
				// A file sink asks whether or not the oracle can see the write.
				expect(result.asks, `${shape.command}\n${verdict}\n${shape.note}`).toBe(true);
				expect(result.findings.some(finding => finding.entry === "secret-sink" && finding.detail.includes("reaches a file"))).toBe(true);
				return;
			}
			expect(result.asks, `${shape.command}\n${verdict}\n${shape.note}`).toBe(seen.exposed);
			// When the shell exposed the secret, the floor must have asked
			// because of a secret reaching a sink, not because it failed to read
			// the command at all.
			if (seen.exposed) expect(result.findings.map(finding => finding.entry)).toContain("secret-sink");
		});
	}

	test("the fixture reports its interpreter and every row's verdict", () => {
		const asserted = SHAPES.filter(shape => !UNPARSEABLE.includes(shape.command));
		const rows = SHAPES.map(shape => {
			const seen = observe(shape.command);
			const result = evaluateFloor({ command: shape.command });
			const canParse = !UNPARSEABLE.includes(shape.command);
			const verdict = !canParse ? "unasserted" : shape.mode === "policy" ? "policy" : result.asks === seen.exposed ? "agree" : "DISAGREE";
			return `${verdict.padEnd(10)} ${shape.mode.padEnd(6)} exposed=${String(seen.exposed).padEnd(5)} asks=${String(result.asks).padEnd(5)} [${seen.channels.join(",")}] ${shape.command}`;
		});
		console.log(
			[
				`bash: ${BASH} (${VERSION})`,
				...rows,
				`${asserted.length}/${SHAPES.length} shapes asserted against the floor, ${UNPARSEABLE.length} not parseable by this bash`,
				UNPARSEABLE.length === 0 ? "" : `not parseable here: ${UNPARSEABLE.join(" ; ")}`,
			]
				.filter(line => line.length > 0)
				.join("\n"),
		);
		// Every row is either asserted or named: nothing drops out quietly. With
		// a bash that has the spellings, nothing may drop out at all, and a host
		// with no usable bash asserts nothing, which is a broken fixture rather
		// than a passing one.
		expect(asserted.length).toBeGreaterThan(0);
		expect(asserted.length + UNPARSEABLE.length).toBe(SHAPES.length);
		// A `JEV_ORACLE_BASH` that is not a bash, or a host with none, otherwise
		// reads as a wall of unparseable shapes.
		expect(VERSION).toContain("bash");
		if (/version ([4-9]|\d\d)\./u.test(VERSION)) expect(UNPARSEABLE).toEqual([]);
	});
});
