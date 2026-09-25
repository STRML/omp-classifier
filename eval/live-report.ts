#!/usr/bin/env bun
/**
 * Where the jev-v3 shadow disagrees with the live jev-v2 gate (plan
 * `docs/plans/2026-09-19-intent-aware-judgment.md`, Phase 2 step 8).
 *
 *   bun eval/live-report.ts [--hours 24] [--file <decisions.jsonl>] [--counts-only]
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
 * jev-v3 would have allowed. Those rows are listed in full. A call whose live
 * judgment was an outage (`v3.live` UNAVAILABLE) is its own bucket: the user
 * answered a dialog that no judge had decided.
 *
 * A missing log or any line that fails to parse makes the report INCOMPLETE,
 * and the command exits 1: a flip decision can't rest on a log it couldn't read.
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
	/** Denied during a live outage, allowed by v3: listed, but no regression,
	 *  because jev-v2 never judged them. */
	deniedDuringOutage: Array<{ ts: string; cmd: string; branch: number; reasonCode: string }>;
	/** Blocked headless live, allowed by v3: the subagent case the plan targets. */
	unblocked: Array<{ ts: string; cmd: string; branch: number; reasonCode: string }>;
}

function liveOutcome(line: DecisionRecord): LiveOutcome | undefined {
	if (line.cached === 1) return undefined;
	// A `late-verdict` allow (issue #62) is the dismissal from a judgment that
	// answered after its deadline: the human was never asked, so it is an
	// auto-allow. Its block lines — a late UNSAFE or UNSURE that left the dialog
	// open — are not terminal: the human's own dialog line, when they answer,
	// counts for that call.
	const terminal = line.approval !== undefined || (line.decision === "allow" && (line.layer === "verdict" || line.layer === "late-verdict"));
	if (!terminal) return undefined;
	// A decision with no live verdict can't be told from an outage: not counted.
	if (line.v3 !== undefined && !("error" in line.v3) && line.v3.live === undefined) return undefined;
	if (line.v3?.live === "UNAVAILABLE" || line.approval === "unavailable") return "unavailable";
	switch (line.approval) {
		case "allow-once":
		case "allow-session":
		case "always-allow":
			return "user-approved";
		case "deny":
			return "user-denied";
		case "headless":
			return "headless-blocked";
		case undefined:
			return "auto-allowed";
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
		deniedDuringOutage: [],
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
		if (allows && outcome === "unavailable" && line.approval === "deny") report.deniedDuringOutage.push(row);
		if (allows && outcome === "headless-blocked") report.unblocked.push(row);
	}
	return report;
}

const VERDICTS = new Set(["SAFE", "UNSAFE", "UNSURE", "UNAVAILABLE"]);
/** Line verdicts the log holds from before the Jev port: the prompt-era
 *  classifier wrote PARSE_ERROR when its reply had no verdict. Real history,
 *  not corruption, and it predates the shadow: a PARSE_ERROR line that
 *  carries v3 contradicts itself and is malformed. */
const LEGACY_VERDICTS = new Set(["PARSE_ERROR"]);
/** DecisionRecord["approval"], value for value: an unknown answer is no answer
 *  this report can count, so the line is unreadable rather than skipped. */
const APPROVALS = new Set(["allow-once", "allow-session", "always-allow", "deny", "headless", "unavailable"]);

/** The fields only a decision carries. An error record with any of them is
 *  both shapes at once, and neither reading of it can be trusted. */
const DECISION_FIELDS = ["verdict", "branch", "reasonCode", "authorization", "namedFirm", "literalMatched", "overlay"];

/** A v3 record this report can read: exactly one of its two shapes. An error
 *  carries only `error`, `ms` and `live`; a decision names the live verdict it
 *  ran beside and carries no `error`. A v3 without `live` can't be told from
 *  an outage, so it is unreadable rather than guessed. */
function isShadowRecord(value: unknown): boolean {
	if (typeof value !== "object" || value === null) return false;
	const record = value as Record<string, unknown>;
	if ("error" in record) {
		return (
			typeof record.error === "string" &&
			DECISION_FIELDS.every(field => !(field in record)) &&
			(record.live === undefined || (typeof record.live === "string" && VERDICTS.has(record.live)))
		);
	}
	return (
		typeof record.live === "string" &&
		VERDICTS.has(record.live) &&
		typeof record.verdict === "string" &&
		VERDICTS.has(record.verdict) &&
		typeof record.branch === "number" &&
		Number.isInteger(record.branch) &&
		record.branch >= 1 &&
		record.branch <= 7 &&
		typeof record.reasonCode === "string"
	);
}

/** The fields the counting reads, checked rather than cast: `{}` parses as
 *  JSON and is still no decision. */
function isDecisionLine(value: unknown): value is DecisionRecord {
	if (typeof value !== "object" || value === null) return false;
	const line = value as Record<string, unknown>;
	return (
		typeof line.ts === "string" &&
		!Number.isNaN(Date.parse(line.ts)) &&
		(line.tool === "bash" || line.tool === "eval") &&
		(line.decision === "allow" || line.decision === "block") &&
		typeof line.layer === "string" &&
		typeof line.cmd === "string" &&
		(line.cached === 0 || line.cached === 1) &&
		(line.approval === undefined || (typeof line.approval === "string" && APPROVALS.has(line.approval))) &&
		(line.verdict === null || line.verdict === undefined || (typeof line.verdict === "string" && (VERDICTS.has(line.verdict) || (LEGACY_VERDICTS.has(line.verdict) && line.v3 === undefined)))) &&
		(line.v3 === undefined || isShadowRecord(line.v3))
	);
}

export interface DecisionLog {
	lines: DecisionRecord[];
	/** Line numbers (1-based) that did not parse, or parsed into something
	 *  that is not a decision line this report can read. */
	malformed: number[];
}

/** Read the log strictly: a missing file throws, and every line that fails to
 *  parse is reported, never skipped in silence. */
export function readDecisionLog(file: string): DecisionLog {
	if (!fs.existsSync(file)) throw new Error(`no decision log at ${file}`);
	const log: DecisionLog = { lines: [], malformed: [] };
	fs.readFileSync(file, "utf8")
		.split("\n")
		.forEach((raw, index) => {
			if (raw.trim() === "") return;
			let parsed: unknown;
			try {
				parsed = JSON.parse(raw);
			} catch {
				log.malformed.push(index + 1);
				return;
			}
			if (isDecisionLine(parsed)) log.lines.push(parsed);
			else log.malformed.push(index + 1);
		});
	return log;
}

/**
 * `countsOnly` prints each list's size and none of its rows. The rows carry
 * logged command text, which can hold a secret (#71), so anything posted
 * somewhere public (the weekly comment on #116) uses counts only.
 */
export function render(report: ShadowReport, options: { countsOnly?: boolean } = {}): string {
	const rows = Object.entries(report.matrix).map(
		([outcome, cell]) => `  ${outcome.padEnd(17)} ${String(cell.v3Allow).padStart(9)} ${String(cell.v3Ask).padStart(9)}`,
	);
	const branches = Object.entries(report.byBranch)
		.sort(([a], [b]) => Number(a) - Number(b))
		.map(([branch, count]) => `  branch ${branch}: ${count}`);
	const list = (title: string, items: ShadowReport["regressions"]) =>
		items.length === 0
			? [`${title}: none`]
			: [`${title}: ${items.length}`, ...(options.countsOnly ? [] : items.map(item => `  ${item.ts}  b${item.branch} ${item.reasonCode}  ${item.cmd}`))];
	return [
		`jev-v3 shadow since ${report.since}: ${report.calls} calls, ${report.shadowErrors} shadow errors`,
		"",
		`  live outcome      v3 allow    v3 ask`,
		...rows,
		"",
		...branches,
		"",
		...list("REGRESSIONS (denied live, v3 would allow)", report.regressions),
		...list("denied during a live outage, v3 would allow", report.deniedDuringOutage),
		...list("headless blocks v3 would allow", report.unblocked),
	].join("\n");
}

if (import.meta.main) {
	const { values } = parseArgs({ args: Bun.argv.slice(2), options: { hours: { type: "string" }, file: { type: "string" }, "counts-only": { type: "boolean" } }, strict: true });
	const hours = values.hours === undefined ? 24 : Number(values.hours);
	if (!Number.isFinite(hours) || hours <= 0) throw new Error(`--hours must be a positive number; got '${values.hours}'`);
	const file = values.file ?? decisionsLogPath();
	const log = readDecisionLog(file);
	console.log(render(summarizeShadow(log.lines, Date.now() - hours * 3_600_000), { countsOnly: values["counts-only"] === true }));
	if (log.malformed.length > 0) {
		console.log(`\nINCOMPLETE: ${log.malformed.length} line(s) did not parse (${log.malformed.slice(0, 10).join(", ")}). Fix or remove them before reading this report.`);
		process.exit(1);
	}
}
