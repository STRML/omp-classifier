/**
 * The routine-recognizer measurement's own gate (issue #34).
 *
 * The harness decides GO / NO-GO for a pre-filter nobody has built yet, so its
 * two failure modes are worse than a wrong number: a GO printed with no safety
 * evidence at all, and a GO inflated by context the corpus never carried. Each
 * case here runs the real script over a corpus written for that case — the
 * subject is the gate, so calling its parts would test a copy of it.
 *
 * Two cases are anti-vacuity guards: full evidence still reaches GO, so a gate
 * that fails closed cannot quietly become a gate that always says no.
 */
import { afterAll, describe, expect, test } from "bun:test";
import { execSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

const ROOT = path.join(import.meta.dir, "..");
const MEASURE = path.join(ROOT, "eval", "recognizer-measure.ts");

/** Temp dirs and homes this file made, removed after the suite: `trash` where
 *  the CLI exists, `rm -rf` when it does not (the convention the repo's other
 *  subprocess tests use). */
const TEMP_DIRS: string[] = [];

afterAll(() => {
	// `trash` where the CLI exists, `rm -rf` where it does not: the same
	// convention the repo's other temp-dir tests use. One call, not one per
	// root.
	const roots = TEMP_DIRS.map(dir => JSON.stringify(dir)).join(" ");
	if (roots !== "") execSync(`trash ${roots} 2>/dev/null || rm -rf ${roots}`);
});

function tempDir(prefix: string): string {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
	TEMP_DIRS.push(dir);
	return dir;
}

function tempFile(name: string, text: string): string {
	const file = path.join(tempDir("omp-measure-"), name);
	fs.writeFileSync(file, text);
	return file;
}

const corpus = (rows: readonly Record<string, unknown>[]): string =>
	tempFile("corpus.jsonl", `${rows.map(row => JSON.stringify(row)).join("\n")}\n`);

/** One line the log reader accepts: `layer: verdict` with `decision: allow` is
 *  what the gate's own auto-allow writes, and `outcomeOf` reads it as
 *  auto-allowed. */
const decisionLine = (cmd: string): Record<string, unknown> => ({
	ts: "2026-09-25T00:00:00.000Z",
	tool: "bash",
	decision: "allow",
	layer: "verdict",
	cmd,
	cached: 0,
	verdict: "SAFE",
});

const decisions = (cmds: readonly string[]): string =>
	tempFile("decisions.jsonl", `${cmds.map(cmd => JSON.stringify(decisionLine(cmd))).join("\n")}\n`);

/** A path no case writes, for the "there is no log at all" shape. */
const ABSENT_LOG = path.join(os.tmpdir(), `omp-measure-absent-${process.pid}`, "decisions.jsonl");

function measure(corpusPath: string, decisionsPath: string): string {
	const proc = Bun.spawnSync({
		cmd: [process.execPath, MEASURE, "--corpus", corpusPath, "--decisions", decisionsPath, "--variant", "core"],
		cwd: ROOT,
		// Explicit env: the suite's OMP_JEV_CONFIG would point the default log
		// path at its own temp dir, and a case must not read another's fixtures.
		env: { PATH: process.env.PATH ?? "", HOME: tempDir("omp-measure-home-"), TMPDIR: os.tmpdir() },
		stdout: "pipe",
		stderr: "pipe",
	});
	if (proc.exitCode !== 0) throw new Error(`the measurement exited ${proc.exitCode}: ${proc.stderr.toString()}`);
	return proc.stdout.toString();
}

const gateLine = (out: string): string => out.split("\n").find(line => line.startsWith("gate: ")) ?? "";

/** A path long enough that the log cannot store it whole: the writer cuts at
 *  120 characters and appends its own marker (index.ts, `truncated`). */
const LONG_COMMAND = `cat /private/tmp/${Array.from({ length: 8 }, (_, index) => `segment-${index}-abcdefghijklmno`).join("/")}/win_state.txt`;

describe("the measurement's gate", () => {
	test("a cleared row with no safety evidence is not a pass", () => {
		const out = measure(corpus([{ command: "pwd", count: 100 }]), ABSENT_LOG);
		// The share half passes on its own: the gate has to refuse it anyway.
		expect(out).toContain("clear share volume 100/100 = 100.0%");
		expect(gateLine(out)).toMatch(/^gate: NO-GO/u);
		expect(gateLine(out)).toContain("no safety evidence");
	});

	test("a corpus with no session taint does not clear a shape that expands one", () => {
		// `echo $CAPTURED` after a secret capture is the shape the recognizer's
		// taint input exists for; the corpus carries no capture, so the honest
		// reading of that row is "unknown", not "nothing was captured".
		const out = measure(corpus([{ command: "echo $CAPTURED", count: 100 }]), decisions(["echo $CAPTURED"]));
		expect(out).toContain("clear share rows   0/1");
		expect(gateLine(out)).toMatch(/^gate: NO-GO/u);
	});

	test("a key the log had to cut is a prefix, never a match for the rest", () => {
		// How the writer really stores it: the first 120 characters plus its
		// own marker. A different suffix would store the same key.
		const stored = `${LONG_COMMAND.slice(0, 120)}…`;
		const out = measure(corpus([{ command: LONG_COMMAND, count: 100 }]), decisions([stored]));
		expect(gateLine(out)).toMatch(/^gate: NO-GO/u);
		expect(gateLine(out)).toContain("1 of them joined the log only through its 120-character cut");
	});

	test("a 120-character key is a prefix even when the cut left no marker", () => {
		// The finding's own shape: a command of exactly 120 characters whose
		// text is this command's first 120, so the shorter command's allow can
		// be read as an allow of the longer one.
		const stored = LONG_COMMAND.slice(0, 120);
		expect(stored.length).toBe(120);
		const out = measure(corpus([{ command: LONG_COMMAND, count: 100 }]), decisions([stored]));
		expect(gateLine(out)).toMatch(/^gate: NO-GO/u);
		expect(gateLine(out)).toContain("1 of them joined the log only through its 120-character cut");
	});

	test("full evidence still reaches GO: a label on every cleared row", () => {
		const out = measure(corpus([{ command: "pwd", count: 100, label: "allow" }]), ABSENT_LOG);
		expect(out).toContain("clear share volume 100/100 = 100.0%");
		expect(gateLine(out)).toMatch(/^gate: GO /u);
	});

	test("full evidence still reaches GO: an exact log line that allowed it", () => {
		const out = measure(corpus([{ command: "pwd", count: 100 }]), decisions(["pwd"]));
		expect(gateLine(out)).toMatch(/^gate: GO /u);
	});
});
