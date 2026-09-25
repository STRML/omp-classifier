/**
 * Log-side secret redaction (issue #71). Two writers put the command on disk —
 * the decisions.jsonl `cmd` field and the `~/.omp/logs` verdict line — and both
 * truncate to 120 flattened characters, which is enough to swallow a bearer
 * token or a `--password` value sitting in a flag. Both now run the text
 * through redact.ts first, and decisions.jsonl is created 0600.
 *
 * The judged command is deliberately NOT redacted (redact.ts header: hiding the
 * key would hide the hazard), so the first test also pins that the request
 * state still carries the value verbatim while the on-disk copies do not.
 */
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
	fire,
	jevSafeAnswer,
	loadPlugin,
	loggerInfos,
	makeCtx,
	makeEvent,
	makeSettings,
	removeConfigFile,
	setJevAnswer,
	stateOf,
	useTempConfigFile,
} from "./fixtures";
import type { DecisionRecord } from "../index";
import { REDACTED } from "../redact";

let dir = "";
let seq = 0;

const decisionsPath = (): string => path.join(dir, "decisions.jsonl");

const lastDecision = (): DecisionRecord => {
	const lines = fs
		.readFileSync(decisionsPath(), "utf8")
		.split("\n")
		.filter(line => line.trim() !== "");
	const last = lines[lines.length - 1];
	if (last === undefined) throw new Error("no decisions.jsonl line was written");
	return JSON.parse(last) as DecisionRecord;
};

beforeEach(async () => {
	removeConfigFile();
	dir = fs.mkdtempSync(path.join(os.tmpdir(), "omp-redact-"));
	process.env.OMP_JEV_CONFIG = path.join(dir, "omp-classifier.json");
	await loadPlugin(makeSettings([]));
	setJevAnswer(jevSafeAnswer());
});

afterEach(() => {
	process.env.OMP_JEV_CONFIG = useTempConfigFile();
	fs.rmSync(dir, { recursive: true, force: true });
});

describe("log-side secret redaction", () => {
	test("decisions.jsonl keeps the command shape but not the flag's value", async () => {
		seq += 1;
		const marker = `redact-marker-${seq}`;
		const secret = `hunter2-do-not-log-${seq}`;
		const command = `echo ${marker} --password ${secret}`;
		await fire("tool_call", makeEvent(command), makeCtx({ sessionId: `redact-cmd-${seq}` }));

		// The judge still sees the real command; only the disk copy is redacted.
		expect(stateOf(0).command).toBe(command);

		const record = lastDecision();
		expect(record.cmd).toContain(marker);
		expect(record.cmd).toContain("--password");
		expect(record.cmd).toContain(REDACTED);
		expect(record.cmd).not.toContain(secret);
	});

	test("the OMP log line and the audit record both drop a bearer token", async () => {
		seq += 1;
		const marker = `log-marker-${seq}`;
		const token = `sk-live-redaction-probe-${seq}`;
		const command = `echo ${marker} -H "Authorization: Bearer ${token}"`;
		await fire("tool_call", makeEvent(command), makeCtx({ sessionId: `redact-log-${seq}` }));

		const log = loggerInfos.join("\n");
		expect(log).toContain("verdict=SAFE");
		expect(log).toContain(marker);
		expect(log).toContain("Authorization:");
		expect(log).not.toContain(token);
		expect(lastDecision().cmd).not.toContain(token);
	});

	test("a truncated multi-line command still redacts the value on its own line", async () => {
		seq += 1;
		const marker = `multiline-marker-${seq}`;
		const secret = `ghp_${"a".repeat(30)}${seq}`;
		const command = `echo ${marker}\nexport GH_TOKEN=${secret}`;
		await fire("tool_call", makeEvent(command), makeCtx({ sessionId: `redact-multi-${seq}` }));

		const record = lastDecision();
		expect(record.cmd).toContain(marker);
		expect(record.cmd).not.toContain(secret);
	});

	test("decisions.jsonl is created with mode 0600", async () => {
		seq += 1;
		await fire("tool_call", makeEvent(`echo mode-marker-${seq}`), makeCtx({ sessionId: `redact-mode-${seq}` }));
		expect(fs.statSync(decisionsPath()).mode & 0o777).toBe(0o600);
	});
});
