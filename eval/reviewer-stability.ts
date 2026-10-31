/**
 * Stage 2 reviewer stability probe (docs/plans/2026-10-27-stage-2-reviewer.md).
 *
 * Replays one command against the live reviewer, with the transcript of a
 * saved OMP session cut at the first user message containing `--upto` (or
 * after the last entry at or before the ISO time `--at`, which also cuts after
 * an ask answer), and
 * tallies the decisions over `--draws` runs. A block is remembered until the
 * user writes again, so a reviewer that answers the same input two ways can
 * pin a command the user asked for. This is the check that found it.
 *
 *   bun eval/reviewer-stability.ts --session <session.jsonl> --cwd <dir> \
 *     --upto "update fork main" --model deepseek/deepseek-flash --draws 5 \
 *     -- '~/.omp/agent/managed-skills/update-omp-fork/update-fork.sh start'
 */
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { parseArgs } from "node:util";

import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { discoverAuthStorage, Settings } from "@oh-my-pi/pi-coding-agent/sdk";
import { getAgentDir } from "@oh-my-pi/pi-utils";
import { reviewerTranscript } from "../index";
import { reviewerModelCall, runReviewer } from "../reviewer";
import { scriptsForReview } from "../stage-two";

const { values, positionals } = parseArgs({
	allowPositionals: true,
	options: {
		session: { type: "string" },
		cwd: { type: "string" },
		upto: { type: "string" },
		at: { type: "string" },
		verdict: { type: "string", default: "UNSURE" },
		reason: { type: "string", default: "below floor" },
		model: { type: "string", default: "deepseek/deepseek-flash" },
		draws: { type: "string", default: "5" },
		timeout: { type: "string", default: "15000" },
	},
});
const command = positionals.join(" ").replace(/^~(?=\/)/u, homedir());
if (values.session === undefined || values.cwd === undefined || (values.upto === undefined) === (values.at === undefined) || command === "") {
	console.error("usage: bun eval/reviewer-stability.ts --session <jsonl> --cwd <dir> (--upto <text> | --at <iso>) [--verdict UNSURE|UNSAFE] [--reason text] [--model p/id] [--draws n] -- <command>");
	process.exit(2);
}

const draws = Number(values.draws);
const timeoutMs = Number(values.timeout);
if (!Number.isInteger(draws) || draws < 1 || !Number.isInteger(timeoutMs) || timeoutMs < 1) {
	console.error("--draws and --timeout must be positive integers");
	process.exit(2);
}

const entries = readFileSync(values.session, "utf8")
	.trim()
	.split("\n")
	.map(line => JSON.parse(line));
// The user's own text only: a string, or the text blocks of a block array.
const userText = (content: unknown): string =>
	typeof content === "string" ? content : Array.isArray(content) ? content.map(block => (typeof block?.text === "string" ? block.text : "")).join("\n") : "";
const cut =
	values.at !== undefined
		? entries.findLastIndex(e => typeof e.timestamp === "string" && e.timestamp <= values.at!)
		: entries.findIndex(e => e.type === "message" && e.message?.role === "user" && userText(e.message.content).includes(values.upto!));
if (cut < 0) {
	console.error(`no cut point for ${JSON.stringify(values.upto ?? values.at)}`);
	process.exit(2);
}

const programs = scriptsForReview(command, values.cwd);
if (programs.kind !== "scripts") {
	console.error(`stage 2 would not review this command: ${JSON.stringify(programs)}`);
	process.exit(2);
}

const settings = await Settings.loadReadOnly();
const store = await discoverAuthStorage();
const registry = new ModelRegistry(store, join(getAgentDir(), "models.yml"), { settings });
const call = reviewerModelCall(registry, values.model!);
if (call === undefined) {
	console.error(`model ${values.model} is not in the registry`);
	process.exit(2);
}

const input = {
	command,
	workingDirectory: values.cwd,
	transcript: reviewerTranscript(entries.slice(0, cut + 1)),
	scriptBodies: programs.scripts.map(({ path, body }) => ({ path, body })),
	stage1: { verdict: values.verdict!, reason: values.reason! },
};
const tally: Record<string, number> = {};
// Each distinct rule and reason, counted: a tally says how often the reviewer
// blocks, the reasons say which rule it reached for and why.
const reasons: Record<string, number> = {};
for (let i = 0; i < draws; i++) {
	const outcome = await runReviewer(input, call, timeoutMs);
	const key = outcome.kind === "decided" ? outcome.decision.decision : `failed: ${outcome.why.slice(0, 60)}`;
	tally[key] = (tally[key] ?? 0) + 1;
	if (outcome.kind === "decided") {
		const why = `${outcome.decision.decision} [${outcome.decision.rule}] ${outcome.decision.reason}`;
		reasons[why] = (reasons[why] ?? 0) + 1;
	}
}
console.log(JSON.stringify({ command, cut: values.upto ?? values.at, verdict: values.verdict, model: values.model, tally, reasons }));
store.close();
