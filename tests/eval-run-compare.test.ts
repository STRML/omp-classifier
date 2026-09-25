/**
 * eval/run.ts `--compare` — case identity, not command identity (issue #80).
 *
 * `--compare` used to key the baseline by `command` alone: `new Map(previous.map(o =>
 * [o.command, o]))`. `eval/corpus/intent.jsonl` lists 14 commands twice — 13 of them with
 * opposite labels — and those pairs differ only in `evidence` (the messages that
 * authorize the command), so the last twin in the baseline stood in for both and the
 * FIXED/REGRESSION lines attributed a movement to the wrong pair. `--corpus heldout`
 * has the same shape with `cwd` (each command repeats 25 times, one per synthetic task).
 *
 * These tests drive the real `--compare` diff over real corpus rows, through a real
 * report round-trip (write the baseline JSON, read it back the way `--compare` reads a
 * baseline file, then diff), so the identity under test is the identity that survives a
 * report on disk — not one that only exists in memory.
 */
import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import { asPriorOutcomes, compareAgainstPrior, type Case, type Decision, type PriorOutcome } from "../eval/run";

const INTENT = join(import.meta.dir, "..", "eval", "corpus", "intent.jsonl");
const ADVERSARIAL = join(import.meta.dir, "..", "eval", "corpus", "adversarial.jsonl");

async function corpus(path: string): Promise<Case[]> {
	const rows: Case[] = [];
	for (const line of (await Bun.file(path).text()).split("\n")) {
		if (line.trim() === "") continue;
		const parsed = JSON.parse(line) as Case & { _comment?: string };
		if (typeof parsed._comment === "string") continue;
		rows.push(parsed);
	}
	return rows;
}

/** The first command the intent corpus lists twice with opposite labels — the twins the
 *  issue was filed about. */
async function firstTwinPair(): Promise<[Case, Case]> {
	const byCommand = new Map<string, Case[]>();
	for (const row of await corpus(INTENT)) {
		const bucket = byCommand.get(row.command);
		if (bucket) bucket.push(row);
		else byCommand.set(row.command, [row]);
	}
	for (const group of byCommand.values()) {
		if (group.length === 2 && group[0].label !== group[1].label) return [group[0], group[1]];
	}
	throw new Error("eval/corpus/intent.jsonl no longer holds a command-twin pair with opposite labels");
}

const verdictsFor = (decision: Decision): string[] => [decision === "allow" ? "SAFE" : "UNSAFE"];

/** One row of a run over a corpus case: identity, label, and the decision drawn. */
const runRow = (testCase: Case, decision: Decision): PriorOutcome => ({
	command: testCase.command,
	cwd: testCase.cwd,
	kind: testCase.kind,
	language: testCase.language,
	evidence: testCase.evidence,
	label: testCase.label,
	decision,
	stable: true,
	verdicts: verdictsFor(decision),
});

/** A baseline as it exists on disk: `--compare` only ever sees one through this path. */
function roundTrippedReport(rows: PriorOutcome[]): PriorOutcome[] {
	const text = JSON.stringify({ summary: {}, outcomes: rows }, null, 2);
	const parsed = asPriorOutcomes(JSON.parse(text));
	if (!parsed) throw new Error("the written baseline did not read back as a harness report");
	return parsed;
}

describe("--compare — twin attribution", () => {
	test("each twin is diffed against its own row, not against its label-twin", async () => {
		const [allowTwin, askTwin] = await firstTwinPair();
		expect(allowTwin.label).toBe("allow");
		expect(askTwin.label).toBe("ask");
		// Same command and same cwd: evidence is the only thing that separates them,
		// and it is what earns the opposite labels.
		expect(askTwin.command).toBe(allowTwin.command);
		expect(askTwin.cwd).toBe(allowTwin.cwd);
		expect(askTwin.evidence).not.toEqual(allowTwin.evidence);

		// Baseline: the allow twin allowed, the ask twin asked.
		const previous = roundTrippedReport([runRow(allowTwin, "allow"), runRow(askTwin, "ask")]);
		// This run: the allow twin asks too — a needless interruption on that row
		// alone. The ask twin did not move.
		const diff = compareAgainstPrior(previous, [runRow(allowTwin, "ask"), runRow(askTwin, "ask")], "intent-baseline.json");

		expect(diff.newInterruptions).toBe(1);
		expect(diff.fixed).toBe(0);
		expect(diff.regressed).toBe(0);
		expect(diff.noise).toBe(0);
		expect(diff.lines).toHaveLength(1);
		expect(diff.lines[0]).toContain("allow → ask");
		expect(diff.lines[0]).toContain("NEW INTERRUPTION");
		expect(diff.verdict).toContain("WEIGH THE COST");
	});

	test("the identity does not depend on the key order of evidence in the baseline", () => {
		// JSON object key order carries no meaning; a writer (or a hand edit) may
		// reorder it. The identity must not change with it.
		const testCase: Case = {
			command: "git push origin main",
			label: "ask",
			family: "intent-test",
			cwd: "/Users/you/sites/project",
			evidence: { userMessages: ["push the docs update too"], operatorContext: "Worker: docs lane" },
		};
		const reorderedEvidence = { operatorContext: "Worker: docs lane", userMessages: ["push the docs update too"] };
		expect(JSON.stringify(reorderedEvidence)).not.toBe(JSON.stringify(testCase.evidence));

		const baseline = roundTrippedReport([{ ...runRow(testCase, "allow"), evidence: reorderedEvidence }]);
		const diff = compareAgainstPrior(baseline, [runRow(testCase, "ask")], "baseline.json");
		expect(diff.fixed).toBe(1);
		expect(diff.lines).toHaveLength(1);
	});

	test("a baseline that carries the same case twice is a loud error, not a silent pick", async () => {
		const [allowTwin] = await firstTwinPair();
		const duplicated = roundTrippedReport([runRow(allowTwin, "allow"), runRow(allowTwin, "allow")]);
		// A duplicate key cannot be attributed to either row. Picking one silently is
		// the bug this test exists for: the error must name the colliding row.
		let message = "";
		try {
			compareAgainstPrior(duplicated, [runRow(allowTwin, "ask")], "baseline.json");
		} catch (err) {
			message = err instanceof Error ? err.message : String(err);
		}
		expect(message).toContain("baseline.json");
		expect(message).toContain(allowTwin.command.slice(0, 60));
		expect(message).toMatch(/same case identity|twice/);
	});

	test("the run under test is loud about its own duplicates too", async () => {
		const [allowTwin] = await firstTwinPair();
		expect(() =>
			compareAgainstPrior(
				roundTrippedReport([runRow(allowTwin, "allow")]),
				[runRow(allowTwin, "ask"), runRow(allowTwin, "ask")],
				"baseline.json",
			),
		).toThrow(/this run/);
	});
});

describe("--compare — a corpus with no repeated command", () => {
	test("attributes every movement to the command that moved, as before", async () => {
		const rows = (await corpus(ADVERSARIAL)).slice(0, 8);
		// Baseline drew the wrong side of every label; this run draws the label.
		const previous = roundTrippedReport(rows.map(row => runRow(row, row.label === "allow" ? "ask" : "allow")));
		const outcomes = rows.map(row => runRow(row, row.label));
		const diff = compareAgainstPrior(previous, outcomes, "adversarial-baseline.json");

		expect(diff.fixed + diff.newInterruptions + diff.regressed).toBe(rows.length);
		expect(diff.noise).toBe(0);
		expect(diff.lines).toHaveLength(rows.length);
		for (const [index, line] of diff.lines.entries()) {
			expect(line).toContain("FIXED");
			expect(line.endsWith(rows[index].command.slice(0, 80))).toBe(true);
		}
	});

	test("a baseline that matches the run reports no measurable effect", async () => {
		const rows = (await corpus(ADVERSARIAL)).slice(0, 8);
		const previous = roundTrippedReport(rows.map(row => runRow(row, row.label)));
		const diff = compareAgainstPrior(previous, rows.map(row => runRow(row, row.label)), "same.json");
		expect(diff.fixed).toBe(0);
		expect(diff.regressed).toBe(0);
		expect(diff.newInterruptions).toBe(0);
		expect(diff.noise).toBe(0);
		expect(diff.lines).toHaveLength(0);
		expect(diff.verdict).toContain("no measurable effect");
	});
});
