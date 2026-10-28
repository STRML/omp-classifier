/**
 * Stage 2 reviewer stability probe (docs/plans/2026-10-27-stage-2-reviewer.md).
 *
 * Replays one command against the live reviewer, with the transcript of a
 * saved OMP session cut at the first user message containing `--upto`, and
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
		model: { type: "string", default: "deepseek/deepseek-flash" },
		draws: { type: "string", default: "5" },
		timeout: { type: "string", default: "15000" },
	},
});
const command = positionals.join(" ").replace(/^~(?=\/)/u, homedir());
if (values.session === undefined || values.cwd === undefined || values.upto === undefined || command === "") {
	console.error("usage: bun eval/reviewer-stability.ts --session <jsonl> --cwd <dir> --upto <text> [--model p/id] [--draws n] -- <command>");
	process.exit(2);
}

const entries = readFileSync(values.session, "utf8")
	.trim()
	.split("\n")
	.map(line => JSON.parse(line));
const cut = entries.findIndex(e => e.type === "message" && e.message?.role === "user" && JSON.stringify(e.message.content).includes(values.upto!));
if (cut < 0) {
	console.error(`no user message contains ${JSON.stringify(values.upto)}`);
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
	stage1: { verdict: "UNSURE" as const, reason: "below floor" },
};
const tally: Record<string, number> = {};
for (let i = 0; i < Number(values.draws); i++) {
	const outcome = await runReviewer(input, call, Number(values.timeout));
	const key = outcome.kind === "decided" ? outcome.decision.decision : `failed: ${outcome.why.slice(0, 60)}`;
	tally[key] = (tally[key] ?? 0) + 1;
}
console.log(JSON.stringify({ command, upto: values.upto, model: values.model, tally }));
store.close();
