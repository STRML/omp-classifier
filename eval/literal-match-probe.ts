#!/usr/bin/env bun
/**
 * Spec step 2 gate: can any mined case reach branch 4? Branch 4 needs a
 * literal match, which code decides without a model, so this runs offline.
 *
 *   bun eval/literal-match-probe.ts [--states <judged-states.jsonl>]
 *
 * Sources: the intent corpus's mined seed rows (their note names the seed),
 * and every bash state with user words in a judged-states file
 * (`/classifier logJudgedStates true`, Task B). A logged command is redacted,
 * which can only lose a match where a secret was present.
 */
import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { judgedStatesPath, type JudgedStateRecord } from "../index";
import { literalMatch } from "../literal-match";

export interface LiteralProbeRow {
	source: string;
	command: string;
	cwd: string;
	userMessages: string[];
}

export interface LiteralProbeTally {
	rows: number;
	matched: LiteralProbeRow[];
	reasons: Record<string, number>;
}

export function literalMatchTally(rows: readonly LiteralProbeRow[], homeDir: string): LiteralProbeTally {
	const tally: LiteralProbeTally = { rows: rows.length, matched: [], reasons: {} };
	for (const row of rows) {
		const result = literalMatch({ command: row.command, cwd: row.cwd, homeDir, userMessages: row.userMessages, resolveRealPath: candidate => resolve(candidate) });
		if (result.matched) {
			tally.matched.push(row);
			continue;
		}
		const reason = result.reason.split(":")[0].trim();
		tally.reasons[reason] = (tally.reasons[reason] ?? 0) + 1;
	}
	return tally;
}

function seedRows(): LiteralProbeRow[] {
	const lines = readFileSync(join(import.meta.dir, "corpus", "intent.jsonl"), "utf8").split("\n").filter(line => line.trim() !== "");
	return lines.flatMap((line, index) => {
		const row = JSON.parse(line) as { command?: string; cwd?: string; note?: string; evidence?: { userMessages?: string[] } };
		if (typeof row.command !== "string" || !/seed/iu.test(row.note ?? "") || (row.evidence?.userMessages?.length ?? 0) === 0) return [];
		return [{ source: `intent:${index}`, command: row.command, cwd: row.cwd ?? "/Users/you/sites/project", userMessages: row.evidence?.userMessages ?? [] }];
	});
}

function stateRows(file: string): LiteralProbeRow[] {
	if (!existsSync(file)) return [];
	return readFileSync(file, "utf8")
		.split("\n")
		.filter(line => line.trim() !== "")
		.flatMap(line => {
			const record = JSON.parse(line) as JudgedStateRecord;
			const risk = record.states.risk as { command?: string; workingDirectory?: string; evidence?: { userMessages?: string[] } };
			const userMessages = risk.evidence?.userMessages ?? [];
			if (record.tool !== "bash" || typeof risk.command !== "string" || typeof risk.workingDirectory !== "string" || userMessages.length === 0) return [];
			return [{ source: `state:${record.decisionId}`, command: risk.command, cwd: risk.workingDirectory, userMessages }];
		});
}

function main(): void {
	const { values } = parseArgs({ args: Bun.argv.slice(2), options: { states: { type: "string" } }, strict: true });
	const statesFile = values.states ?? judgedStatesPath();
	for (const [label, rows, home] of [
		["intent seeds", seedRows(), "/Users/you"],
		[`judged states (${statesFile})`, stateRows(statesFile), process.env.HOME ?? "/"],
	] as const) {
		const tally = literalMatchTally(rows, home);
		console.log(`\n=== ${label}: ${tally.matched.length}/${tally.rows} matched ===`);
		for (const row of tally.matched) console.log(`  MATCH ${row.source} ${row.command.slice(0, 100)}`);
		for (const [reason, count] of Object.entries(tally.reasons).sort((a, b) => b[1] - a[1])) console.log(`  ${String(count).padStart(4)}  ${reason}`);
	}
}

if (import.meta.main) main();
