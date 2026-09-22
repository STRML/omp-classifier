/**
 * eval/live-report.ts: the shadow-week disagreement report (plan Phase 2
 * step 8). Counting is on terminal lines, one per gated call.
 */
import { describe, expect, test } from "bun:test";
import type { DecisionRecord, ShadowV3 } from "../index";
import { summarizeShadow } from "../eval/live-report";

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
});
