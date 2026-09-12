/**
 * Refusal memory across rewording (issue #30): a command this session refused
 * (UNSAFE / human denial / critical / cap / a refusal-shaped PARSE_ERROR) is
 * remembered by
 * normalized target, injected into the next classify record as priorRefusal,
 * and a SAFE that lands anyway on a refused target still prompts. A user
 * approval lifts the memory; the store holds 20 targets per session, oldest
 * dropped.
 *
 * Unique sessions per test — the module-level refusal store outlives a test.
 */
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { normalizeRefusalTarget, parseJudgement, refusalWorthRemembering } from "../index";
import type { DecisionRecord } from "../index";
import {
	selectCalls,
	ALLOW_ONCE,
	DENY,
	fire,
	loadPlugin,
	makeCtx,
	makeEvent,
	makeSettings,
	modelCalls,
	setClassifierReply,
} from "./fixtures";

let dir = "";
let seq = 0;

const decisionsPath = (): string => path.join(dir, "decisions.jsonl");

const readDecisions = (): DecisionRecord[] =>
	fs
		.readFileSync(decisionsPath(), "utf8")
		.split("\n")
		.filter(line => line.trim() !== "")
		.map(line => JSON.parse(line) as DecisionRecord);

beforeEach(async () => {
	dir = fs.mkdtempSync(path.join(os.tmpdir(), "omp-refusal-"));
	process.env.OMP_CLASSIFIER_CONFIG = path.join(dir, "omp-classifier.json");
	await loadPlugin(makeSettings([]));
	setClassifierReply("SAFE");
});

afterEach(() => {
	fs.rmSync(dir, { recursive: true, force: true });
});

/** Fresh session id per test; the plugin's stores are module-level. */
const nextSession = (): string => `refusal-memory-${(seq += 1)}`;

/** The JSON record line inside the classifier prompt message. */
const recordOf = (callIndex: number): Record<string, unknown> => {
	const content = modelCalls[callIndex].request.messages[0].content;
	const line = content.split("\n").find(candidate => candidate.startsWith("{"));
	return JSON.parse(line ?? "{}") as Record<string, unknown>;
};

describe("normalizeRefusalTarget", () => {
	test("case, whitespace, flags, cd-prefix, git verbs", () => {
		expect(normalizeRefusalTarget("rm -rf x")).toBe("rm x");
		expect(normalizeRefusalTarget("rm -rf ./x")).toBe("rm x");
		expect(normalizeRefusalTarget("RM   -RF\t./X")).toBe("rm x");
		expect(normalizeRefusalTarget("cd /tmp && rm -rf x")).toBe("rm x");
		expect(normalizeRefusalTarget("rm -f x")).toBe("rm x");
		expect(normalizeRefusalTarget("git push --force origin main")).toBe("git push origin");
		expect(normalizeRefusalTarget("git push origin")).toBe("git push origin");
		expect(normalizeRefusalTarget("echo hello")).toBe("echo hello");
		expect(normalizeRefusalTarget("ls -la")).toBe("ls");
		expect(normalizeRefusalTarget("")).toBe("");
	});

	test("rewordings of one action share a target; unlike actions differ", () => {
		expect(normalizeRefusalTarget("rm -rf x")).toBe(normalizeRefusalTarget("rm -f ./x"));
		expect(normalizeRefusalTarget("rm -rf x")).not.toBe(normalizeRefusalTarget("git reset --hard"));
	});
});

describe("refusalWorthRemembering", () => {
	test("UNSAFE always; PARSE_ERROR only when refusal-shaped and verdict-free", () => {
		expect(refusalWorthRemembering({ verdict: "UNSAFE", reason: "x" })).toBe(true);
		expect(refusalWorthRemembering({ verdict: "SAFE", reason: "" })).toBe(false);
		expect(refusalWorthRemembering({ verdict: "UNSURE", reason: "x" })).toBe(false);
		expect(refusalWorthRemembering({ verdict: "PARSE_ERROR", reason: "no content", rawReply: "(empty reply)" })).toBe(false);
		expect(refusalWorthRemembering({ verdict: "PARSE_ERROR", reason: "not a verdict", rawReply: "" })).toBe(false);
		expect(refusalWorthRemembering({ verdict: "PARSE_ERROR", reason: "not a verdict" })).toBe(false);
		expect(refusalWorthRemembering({ verdict: "PARSE_ERROR", reason: "not a verdict", rawReply: "I cannot assist with that." })).toBe(true);
	});

	test("PARSE_ERROR carrying a VERDICT label is never remembered", () => {
		// Measured 2026-09-11: inline-verdict analyses that read SAFE were
		// recorded as refusals, poisoning targets ("const {") and forcing
		// "despite prior refusal" dialogs on routine re-runs.
		expect(refusalWorthRemembering({
			verdict: "PARSE_ERROR",
			reason: "classifier reply had no VERDICT line",
			rawReply: "Writes nothing, deletes nothing. VERDICT: SAFE REASON: read-only.",
		})).toBe(false);
	});
	test("a late VERDICT label beyond the 200-char rawReply window still blocks memory", () => {
		// The field is decided on the full reply; the truncated window cannot
		// re-admit a refusal-shaped reply whose label it never sees.
		expect(refusalWorthRemembering({
			verdict: "PARSE_ERROR",
			reason: "classifier reply had no VERDICT line",
			rawReply: "I cannot assist with that.",
			hasVerdictToken: true,
		})).toBe(false);
	});

	test("a refusal that merely mentions the VERDICT format is remembered", () => {
		// Suppression requires a verdict assertion (label + SAFE/UNSAFE/
		// UNSURE), not the bare word: a refusal talking about the format is
		// refusal-shaped and keeps prior-refusal protection.
		expect(refusalWorthRemembering({
			verdict: "PARSE_ERROR",
			reason: "classifier reply had no VERDICT line",
			rawReply: "I cannot assist. The VERDICT format is required, but I will not provide one.",
			hasVerdictToken: false,
		})).toBe(true);
	});
	test("a quoted format spec is not a verdict assertion", () => {
		// The assertion rule rejects the spec echo (a second alternative
		// follows the first), so this refusal keeps prior-refusal protection.
		expect(refusalWorthRemembering({
			verdict: "PARSE_ERROR",
			reason: "classifier reply had no VERDICT line",
			rawReply: "I cannot assist. Required format: VERDICT: SAFE|UNSAFE|UNSURE",
		})).toBe(true);
	});
	test("refusal language beyond the 200-char window is remembered", () => {
		const j = parseJudgement(`${"The command reads repository files and prints statistics. ".repeat(8)}I cannot assist with that.`);
		expect(j.refusalShaped).toBe(true);
		expect(refusalWorthRemembering(j)).toBe(true);
	});
	test("word-joined format alternatives are not a verdict assertion", () => {
		// Codex round 4: "SAFE or UNSAFE or UNSURE" is the spec in prose.
		expect(refusalWorthRemembering({
			verdict: "PARSE_ERROR",
			reason: "classifier reply had no VERDICT line",
			rawReply: "I cannot decide. Required format: VERDICT: SAFE or UNSAFE or UNSURE.",
		})).toBe(true);
	});
	test("analysis prose with unable-to is not a refusal", () => {
		// Refusal language needs a first-person subject: "the command is
		// unable to connect" is an analysis statement, not a refusal.
		expect(refusalWorthRemembering({
			verdict: "PARSE_ERROR",
			reason: "classifier reply had no VERDICT line",
			rawReply: "The command is unable to connect.",
		})).toBe(false);
	});
	test("a terminal spec echo through the production path is remembered", () => {
		// Codex round 6: the production parseJudgement sets hasVerdictToken
		// from the terminal boundary — but a spec echo is the format, not a
		// decision, so suppression must not fire and the refusal is kept.
		const j = parseJudgement("I cannot assist. VERDICT: SAFE|UNSAFE|UNSURE");
		expect(j.verdict).toBe("PARSE_ERROR");
		expect(j.hasVerdictToken).toBe(false);
		expect(refusalWorthRemembering(j)).toBe(true);
	});
	test("gerund refusal forms are refusal-shaped", () => {
		expect(refusalWorthRemembering({
			verdict: "PARSE_ERROR",
			reason: "classifier reply had no VERDICT line",
			rawReply: "I am refusing to assist.",
		})).toBe(true);
		expect(refusalWorthRemembering({
			verdict: "PARSE_ERROR",
			reason: "classifier reply had no VERDICT line",
			rawReply: "I am declining to assist.",
		})).toBe(true);
	});
	test("subjectless cannot is analysis prose, not a refusal", () => {
		expect(refusalWorthRemembering({
			verdict: "PARSE_ERROR",
			reason: "classifier reply had no VERDICT line",
			rawReply: "This command cannot modify files.",
		})).toBe(false);
	});
	test("decline language is refusal-shaped", () => {
		expect(refusalWorthRemembering({
			verdict: "PARSE_ERROR",
			reason: "classifier reply had no VERDICT line",
			rawReply: "I must decline to assist.",
		})).toBe(true);
	});
});

describe("refusal memory", () => {
	test("reworded command carries priorRefusal into the classify record", async () => {
		const sid = nextSession();
		setClassifierReply("UNSAFE | deletes files");
		await fire("tool_call", makeEvent("rm -rf x"), makeCtx({ sessionId: sid }));
		expect(modelCalls.length).toBe(1);
		setClassifierReply("UNSAFE | still");
		await fire("tool_call", makeEvent("rm -rf ./x"), makeCtx({ sessionId: sid }));
		expect(modelCalls.length).toBe(2);
		const record = recordOf(1);
		const prior = record.priorRefusal as { target: string; why: string; when: string };
		expect(prior.target).toBe("rm x");
		expect(prior.why).toBe("deletes files");
		expect(new Date(prior.when).getTime()).toBeGreaterThan(0);
		// The first, unrefused classification carries no such field.
		expect(recordOf(0).priorRefusal).toBeUndefined();
	});

	test("a SAFE that lands despite a prior refusal still prompts", async () => {
		const sid = nextSession();
		const ctx = makeCtx({ sessionId: sid, hasUI: true, selectResult: DENY });
		setClassifierReply("UNSAFE | not this session");
		await fire("tool_call", makeEvent("echo bye"), ctx);
		// echo is not a moderate-risk token, so without the refusal memory a
		// SAFE here would auto-run; the dialog proves the refusal decided.
		setClassifierReply("SAFE | harmless rewording");
		const result = await fire("tool_call", makeEvent("echo bye again"), ctx);
		expect(selectCalls(ctx).length).toBe(2);
		const payload = JSON.parse(
			(result as { block: true; reason: string }).reason,
		) as { layer: string };
		expect(payload.layer).toBe("dialog");
		expect(readDecisions().some(line => line.why.startsWith("despite prior refusal"))).toBe(true);
	});

	test("user approval lifts the refusal for the target", async () => {
		const sid = nextSession();
		setClassifierReply("UNSAFE | deletes files");
		await fire("tool_call", makeEvent("rm -rf x"), makeCtx({ sessionId: sid, hasUI: true }));
		setClassifierReply("SAFE | routine");
		const approved = await fire(
			"tool_call",
			makeEvent("rm -rf ./x"),
			makeCtx({ sessionId: sid, hasUI: true, selectResult: ALLOW_ONCE }),
		);
		expect(approved).toBeUndefined();
		await fire("tool_call", makeEvent("rm -r x"), makeCtx({ sessionId: sid, hasUI: true, selectResult: ALLOW_ONCE }));
		expect(modelCalls.length).toBe(3);
		expect(recordOf(2).priorRefusal).toBeUndefined();
	});

	test("store caps at 20 per session and drops the oldest", async () => {
		const sid = nextSession();
		setClassifierReply("UNSAFE | no");
		for (let i = 1; i <= 21; i++) {
			await fire(
				"tool_call",
				makeEvent(`rm -rf f${String(i).padStart(2, "0")}`),
				makeCtx({ sessionId: sid }),
			);
		}
		setClassifierReply("UNSAFE | no");
		// Oldest target (rm f01) was evicted: its rewording classifies bare.
		await fire("tool_call", makeEvent("rm -f f01"), makeCtx({ sessionId: sid }));
		expect(recordOf(21).priorRefusal).toBeUndefined();
		// Newest target (rm f21) is still remembered.
		await fire("tool_call", makeEvent("rm -f f21"), makeCtx({ sessionId: sid }));
		const prior = recordOf(22).priorRefusal as { target: string };
		expect(prior.target).toBe("rm f21");
	});

});
