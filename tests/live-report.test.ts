/**
 * eval/live-report.ts: the shadow-week disagreement report (plan Phase 2
 * step 8). Counting is on terminal lines, one per gated call.
 */
import { describe, expect, test } from "bun:test";
import type { DecisionRecord, ShadowV3 } from "../index";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { readDecisionLog, summarizeShadow } from "../eval/live-report";

const NOW = Date.parse("2026-09-22T12:00:00Z");
const v3 = (verdict: "SAFE" | "UNSURE" | "UNSAFE", branch: 3 | 4 | 5 | 7): ShadowV3 => ({
	verdict,
	branch,
	reasonCode: `jev-v3:${branch}:x`,
	authorization: "named",
	namedFirm: true,
	literalMatched: true,
	overlay: [],
	ms: 5,
	live: "UNSURE",
});
const line = (over: Partial<DecisionRecord>): DecisionRecord => ({
	ts: "2026-09-22T11:00:00Z",
	tool: "bash",
	decision: "block",
	layer: "dialog",
	why: "",
	cmd: "cmd",
	cwd: "/repo",
	verdict: null,
	cached: 0,
	ms: 1,
	...over,
});

describe("summarizeShadow", () => {
	test("every live outcome lands in its cell, once per call", () => {
		const report = summarizeShadow(
			[
				line({ decision: "allow", layer: "verdict", verdict: "SAFE", v3: v3("SAFE", 3) }),
				line({ decision: "allow", layer: "verdict", verdict: "SAFE", v3: v3("UNSURE", 5) }),
				// A flagged verdict line, then its dialog line: only the dialog counts.
				line({ decision: "block", layer: "verdict", verdict: "UNSURE", v3: v3("SAFE", 4) }),
				line({ decision: "allow", approval: "allow-once", v3: v3("SAFE", 4) }),
				line({ approval: "deny", cmd: "trash build", v3: v3("SAFE", 4) }),
				line({ approval: "headless", cmd: "gh pr merge 42", v3: v3("SAFE", 4) }),
				line({ approval: "headless", v3: v3("UNSAFE", 7) }),
			],
			NOW - 24 * 3_600_000,
		);
		expect(report.calls).toBe(6);
		expect(report.matrix["auto-allowed"]).toEqual({ v3Allow: 1, v3Ask: 1 });
		expect(report.matrix["user-approved"]).toEqual({ v3Allow: 1, v3Ask: 0 });
		expect(report.matrix["user-denied"]).toEqual({ v3Allow: 1, v3Ask: 0 });
		expect(report.matrix["headless-blocked"]).toEqual({ v3Allow: 1, v3Ask: 1 });
		expect(report.byBranch).toEqual({ "3": 1, "4": 3, "5": 1, "7": 1 });
		// The flip criterion's violation is listed, with the branch that caused it.
		expect(report.regressions).toEqual([{ ts: "2026-09-22T11:00:00Z", cmd: "trash build", branch: 4, reasonCode: "jev-v3:4:x" }]);
		expect(report.unblocked.map(row => row.cmd)).toEqual(["gh pr merge 42"]);
	});

	test("cached lines, lines outside the window, and lines without v3 are not calls", () => {
		const report = summarizeShadow(
			[
				line({ decision: "allow", layer: "cached", cached: 1, v3: v3("SAFE", 3) }),
				line({ ts: "2026-09-20T00:00:00Z", decision: "allow", layer: "verdict", v3: v3("SAFE", 3) }),
				line({ decision: "allow", layer: "verdict" }),
			],
			NOW - 24 * 3_600_000,
		);
		expect(report.calls).toBe(0);
	});

	test("a shadow error counts as a call and as an error, and in no cell", () => {
		const report = summarizeShadow([line({ decision: "allow", layer: "verdict", v3: { error: "timeout", ms: 25_000 } })], NOW - 3_600_000 * 24);
		expect(report.calls).toBe(1);
		expect(report.shadowErrors).toBe(1);
		expect(report.matrix["auto-allowed"]).toEqual({ v3Allow: 0, v3Ask: 0 });
	});

	test("a denial after a live outage is its own bucket, never a regression (#110 gate round 1)", () => {
		const outage = { ...v3("SAFE", 4), live: "UNAVAILABLE" as const };
		const report = summarizeShadow([line({ approval: "deny", cmd: "trash build", v3: outage })], NOW - 24 * 3_600_000);
		expect(report.regressions).toEqual([]);
		expect(report.matrix.unavailable).toEqual({ v3Allow: 1, v3Ask: 0 });
		expect(report.deniedDuringOutage.map(row => row.cmd)).toEqual(["trash build"]);
	});

	test("a denial whose v3 has no live verdict is not counted (#110 gate round 2)", () => {
		const report = summarizeShadow([line({ approval: "deny", v3: { ...v3("SAFE", 4), live: undefined } })], NOW - 24 * 3_600_000);
		expect(report.calls).toBe(0);
		expect(report.regressions).toEqual([]);
	});
});

describe("readDecisionLog", () => {
	test("a missing log is an error, never an empty report (#110 gate round 1)", () => {
		expect(() => readDecisionLog(path.join(os.tmpdir(), "no-such-omp-decisions.jsonl"))).toThrow(/no decision log/u);
	});

	test("every line that fails to parse is reported, not skipped", () => {
		const dir = fs.mkdtempSync(path.join(os.tmpdir(), "omp-report-"));
		try {
			const file = path.join(dir, "decisions.jsonl");
			const good = JSON.stringify(line({ decision: "allow", layer: "verdict", v3: v3("SAFE", 3) }));
			fs.writeFileSync(file, `${good}\n{"broken\n${good}\n`);
			const log = readDecisionLog(file);
			expect(log.lines).toHaveLength(2);
			expect(log.malformed).toEqual([2]);
			// Valid JSON that is no decision line, and a v3 with no live verdict
			// (#110 gate round 2): both unreadable, neither counted.
			const noLive = JSON.stringify(line({ approval: "deny", v3: { ...v3("SAFE", 4), live: undefined } }));
			fs.writeFileSync(file, `{}\n${noLive}\n${good}\n`);
			const strict = readDecisionLog(file);
			expect(strict.malformed).toEqual([1, 2]);
			expect(strict.lines).toHaveLength(1);
			// An approval or verdict outside the type's values (#110 gate round 3).
			const bogusApproval = JSON.stringify({ ...line({ v3: v3("SAFE", 4) }), approval: "bogus" });
			const bogusVerdict = JSON.stringify({ ...line({ decision: "allow", layer: "verdict", v3: v3("SAFE", 3) }), verdict: "MAYBE" });
			fs.writeFileSync(file, `${bogusApproval}\n${bogusVerdict}\n${good}\n`);
			expect(readDecisionLog(file).malformed).toEqual([1, 2]);
			const bogusBranch = JSON.stringify(line({ decision: "allow", layer: "verdict", v3: { ...v3("SAFE", 3), branch: 9 as 3 } }));
			fs.writeFileSync(file, `${bogusBranch}\n${good}\n`);
			expect(readDecisionLog(file).malformed).toEqual([1]);
			// Both shapes at once (#113): an error that also carries a decision,
			// and a decision that also carries an error.
			const errorAndDecision = JSON.stringify(line({ approval: "deny", v3: { ...v3("SAFE", 4), error: "timeout" } as never }));
			const errorOnly = JSON.stringify(line({ decision: "allow", layer: "verdict", v3: { error: "timeout", ms: 25_000, live: "SAFE" } }));
			fs.writeFileSync(file, `${errorAndDecision}\n${errorOnly}\n`);
			const both = readDecisionLog(file);
			expect(both.malformed).toEqual([1]);
			expect(both.lines).toHaveLength(1);
		} finally {
			fs.rmSync(dir, { recursive: true, force: true });
		}
	});
});
