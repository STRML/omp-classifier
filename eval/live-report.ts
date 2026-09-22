#!/usr/bin/env bun
/**
 * Where the jev-v3 shadow disagrees with the live jev-v2 gate (plan
 * `docs/plans/2026-09-19-intent-aware-judgment.md`, Phase 2 step 8).
 *
 *   bun eval/live-report.ts [--hours 24] [--file <decisions.jsonl>]
 *
 * It reads the decision log and counts terminal lines only: every gated call
 * ends in exactly one, either an auto-allow (`layer: verdict`, decision allow)
 * or a line carrying `approval` (a human's answer, or `headless`). Lines have
 * no shared id to join a verdict to its dialog, and the terminal line carries
 * the same `v3` as the verdict line before it, so counting terminals counts
 * each call once. Cached lines are skipped: their `v3` belongs to the call
 * that filled the cache.
 *
 * The flip criterion (plan "Flip"): no call the user denied under jev-v2 that
 * jev-v3 would have allowed. Those rows are listed in full.
 */
import * as fs from "node:fs";
import { parseArgs } from "node:util";
import { decisionsLogPath, type DecisionRecord } from "../index";

/** How the live gate ended one call. */
export type LiveOutcome = "auto-allowed" | "user-approved" | "user-denied" | "headless-blocked" | "unavailable";

export interface ShadowReport {
	since: string;
	/** Terminal lines in the window that carried a v3 decision. */
	calls: number;
	/** Of those, the shadow failed and logged `{ error }`. */
	shadowErrors: number;
	byBranch: Record<string, number>;
	/** live outcome -> v3 allow/ask counts. */
	matrix: Record<LiveOutcome, { v3Allow: number; v3Ask: number }>;
	/** The flip criterion's violations: denied live, allowed by v3. */
	regressions: Array<{ ts: string; cmd: string; branch: number; reasonCode: string }>;
	/** Blocked headless live, allowed by v3: the subagent case the plan targets. */
	unblocked: Array<{ ts: string; cmd: string; branch: number; reasonCode: string }>;
}

function liveOutcome(line: DecisionRecord): LiveOutcome | undefined {
	if (line.cached === 1) return undefined;
	switch (line.approval) {
		case "allow-once":
		case "allow-session":
		case "always-allow":
			return "user-approved";
		case "deny":
			return "user-denied";
		case "headless":
			return "headless-blocked";
		case "unavailable":
			return "unavailable";
		case undefined:
			return line.decision === "allow" && line.layer === "verdict" ? "auto-allowed" : undefined;
	}
}

export function summarizeShadow(lines: readonly DecisionRecord[], sinceMs: number): ShadowReport {
	const outcomes: LiveOutcome[] = ["auto-allowed", "user-approved", "user-denied", "headless-blocked", "unavailable"];
	const report: ShadowReport = {
		since: new Date(sinceMs).toISOString(),
		calls: 0,
		shadowErrors: 0,
		byBranch: {},
		matrix: Object.fromEntries(outcomes.map(outcome => [outcome, { v3Allow: 0, v3Ask: 0 }])) as ShadowReport["matrix"],
		regressions: [],
		unblocked: [],
	};
	for (const line of lines) {
		if (line.v3 === undefined || Date.parse(line.ts) < sinceMs) continue;
		const outcome = liveOutcome(line);
		if (outcome === undefined) continue;
		report.calls++;
		if ("error" in line.v3) {
			report.shadowErrors++;
			continue;
		}
		const v3 = line.v3;
		report.byBranch[String(v3.branch)] = (report.byBranch[String(v3.branch)] ?? 0) + 1;
		const allows = v3.verdict === "SAFE";
		report.matrix[outcome][allows ? "v3Allow" : "v3Ask"]++;
		const row = { ts: line.ts, cmd: line.cmd, branch: v3.branch, reasonCode: v3.reasonCode };
		if (allows && outcome === "user-denied") report.regressions.push(row);
		if (allows && outcome === "headless-blocked") report.unblocked.push(row);
	}
	return report;
}

export function readDecisionLog(file: string): DecisionRecord[] {
	if (!fs.existsSync(file)) return [];
	const lines: DecisionRecord[] = [];
	for (const raw of fs.readFileSync(file, "utf8").split("\n")) {
		if (raw.trim() === "") continue;
		try {
			lines.push(JSON.parse(raw) as DecisionRecord);
		} catch {
			// A torn last line from a concurrent write is not a decision.
		}
	}
	return lines;
}

function render(report: ShadowReport): string {
	const rows = Object.entries(report.matrix).map(
		([outcome, cell]) => `  ${outcome.padEnd(17)} ${String(cell.v3Allow).padStart(9)} ${String(cell.v3Ask).padStart(9)}`,
	);
	const branches = Object.entries(report.byBranch)
		.sort(([a], [b]) => Number(a) - Number(b))
		.map(([branch, count]) => `  branch ${branch}: ${count}`);
	const list = (title: string, items: ShadowReport["regressions"]) =>
		items.length === 0 ? [`${title}: none`] : [`${title}: ${items.length}`, ...items.map(item => `  ${item.ts}  b${item.branch} ${item.reasonCode}  ${item.cmd}`)];
	return [
		`jev-v3 shadow since ${report.since}: ${report.calls} calls, ${report.shadowErrors} shadow errors`,
		"",
		`  live outcome      v3 allow    v3 ask`,
		...rows,
		"",
		...branches,
		"",
		...list("REGRESSIONS (denied live, v3 would allow)", report.regressions),
		...list("headless blocks v3 would allow", report.unblocked),
	].join("\n");
}

if (import.meta.main) {
	const { values } = parseArgs({ args: Bun.argv.slice(2), options: { hours: { type: "string" }, file: { type: "string" } }, strict: true });
	const hours = values.hours === undefined ? 24 : Number(values.hours);
	if (!Number.isFinite(hours) || hours <= 0) throw new Error(`--hours must be a positive number; got '${values.hours}'`);
	const file = values.file ?? decisionsLogPath();
	console.log(render(summarizeShadow(readDecisionLog(file), Date.now() - hours * 3_600_000)));
}
