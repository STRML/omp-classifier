/**
 * Provenance-tiered evidence (issue #31): the classify record may carry an
 * `evidence` object whose fields are typed by their channel — userMessages
 * (the session's recent user words, gated by `evidenceUserMessages`),
 * operatorContext (the requesting agent's own explanation, single-line,
 * capped, never authorizing). The default config attaches the newest three
 * user messages; 0 restores the no-evidence shape entirely.
 */
import { beforeEach, describe, expect, test } from "bun:test";
import { CLASSIFIER_PROMPT, collectTaskEvidence, collectToolEvidence, collectUserEvidence } from "../index";
import {
	fire,
	loadPlugin,
	makeCtx,
	makeEvent,
	makeSettings,
	modelCalls,
	removeConfigFile,
	setClassifierDelay,
	setClassifierReply,
	writeConfigFile,
} from "./fixtures";

beforeEach(async () => {
	removeConfigFile();
	setClassifierDelay(5);
	await loadPlugin(makeSettings([]));
	setClassifierReply("SAFE");
});

let seq = 0;
/** Fresh session id per test; the plugin's stores are module-level. */
const nextSession = (): string => `evidence-${(seq += 1)}`;

/** The JSON record line inside the classifier prompt message. */
const recordOf = (callIndex = 0): Record<string, unknown> => {
	const content = modelCalls[callIndex].request.messages[0].content;
	const line = content.split("\n").find(candidate => candidate.startsWith("{"));
	return JSON.parse(line ?? "{}") as Record<string, unknown>;
};

const evidenceOf = (callIndex = 0): { userMessages?: string[]; operatorContext?: string } => {
	const evidence = recordOf(callIndex).evidence;
	if (!evidence || typeof evidence !== "object") {
		throw new Error(`record carries no evidence object: ${JSON.stringify(recordOf(callIndex))}`);
	}
	return evidence as { userMessages?: string[]; operatorContext?: string };
};

type BranchEntry = { type: string; message?: { role?: string; attribution?: string; content?: unknown } };
const userEntry = (content: string | Array<Record<string, unknown>>): BranchEntry => ({
	type: "message",
	message: { role: "user", attribution: "user", content },
});

describe("default config", () => {
	test("the record carries the newest three user messages by default", async () => {
		const ctx = makeCtx({
			sessionId: nextSession(),
			branch: [userEntry("one"), userEntry("two"), userEntry("three"), userEntry("four")],
		});
		await fire("tool_call", makeEvent("git status"), ctx);
		expect(modelCalls.length).toBe(1);
		expect(evidenceOf().userMessages).toEqual(["two", "three", "four"]);
	});
});

describe("evidenceUserMessages", () => {
	test("keeps the newest two user messages, chronological, flattened, head and tail of a long one", async () => {
		writeConfigFile({ evidenceUserMessages: 2 });
		const long = "y".repeat(2_500);
		const ctx = makeCtx({
			sessionId: nextSession(),
			branch: [
				userEntry("oldest message, outside the window"),
				{ type: "model_change" },
				{ type: "message", message: { role: "assistant", content: "assistant words never count" } },
				userEntry([{ type: "text", text: "alpha" }, { type: "text", text: "beta" }, { type: "image", url: "x" }]),
				{ type: "message", message: { role: "toolResult", content: "tool output never counts" } },
				userEntry(long),
			],
		});
		await fire("tool_call", makeEvent("git status"), ctx);
		expect(modelCalls.length).toBe(1);
		const evidence = evidenceOf();
		expect(evidence.userMessages).toEqual(["alpha\nbeta", `${"y".repeat(1_000)}\n…\n${"y".repeat(1_000)}`]);
	});
});

describe("operatorContext", () => {
	test("rides into the bash record, single line, capped at 500", async () => {
		const ctx = makeCtx({ sessionId: nextSession() });
		await fire(
			"tool_call",
			makeEvent("git status", { operatorContext: `rebuilding the fixture\n${"z".repeat(800)}` }),
			ctx,
		);
		expect(modelCalls.length).toBe(1);
		const evidence = evidenceOf();
		expect(evidence.operatorContext).toBe(`rebuilding the fixture ${"z".repeat(500 - "rebuilding the fixture".length - 1)}…`);
	});

	test("rides into the eval record the same way", async () => {
		const ctx = makeCtx({ sessionId: nextSession() });
		await fire(
			"tool_call",
			{
				toolName: "eval",
				toolCallId: `eval-${seq}`,
				input: { code: "import subprocess\nsubprocess.run(['ls'])", language: "python", operatorContext: "list the fixtures dir" },
			},
			ctx,
		);
		expect(modelCalls.length).toBe(1);
		const record = recordOf();
		expect(record.kind).toBe("eval-code");
		const evidence = evidenceOf();
		expect(evidence.operatorContext).toBe("list the fixtures dir");
	});

	test("a whitespace-only context adds no evidence", async () => {
		const ctx = makeCtx({ sessionId: nextSession() });
		await fire("tool_call", makeEvent("git status", { operatorContext: "  \n\t " }), ctx);
		expect(modelCalls.length).toBe(1);
		expect(recordOf().evidence).toBeUndefined();
	});
});

describe("tool evidence", () => {
	test("recent tool calls and results are visible as non-authorizing context", async () => {
		const branch = [
			{
				type: "message",
				message: {
					role: "assistant",
					content: [{ type: "toolCall", name: "write", arguments: { path: "scripts/check.sh", content: "echo ok" } }],
				},
			},
			{ type: "message", message: { role: "toolResult", toolName: "write", content: "wrote scripts/check.sh" } },
		] as const;
		expect(collectToolEvidence(branch)).toContain("scripts/check.sh");
		const ctx = makeCtx({ sessionId: nextSession(), branch });
		await fire("tool_call", makeEvent("bash scripts/check.sh"), ctx);
		const evidence = evidenceOf();
		expect(evidence.operatorContext).toContain("recent tool evidence (non-authorizing)");
		expect(evidence.operatorContext).toContain("scripts/check.sh");
	});
});

describe("bounds", () => {
	test("values above the ceiling fall back to the default 3", async () => {
		writeConfigFile({ evidenceUserMessages: 9 });
		const ctx = makeCtx({ sessionId: nextSession(), branch: [userEntry("check"), userEntry("again")] });
		await fire("tool_call", makeEvent("git status"), ctx);
		expect(modelCalls.length).toBe(1);
		expect(evidenceOf().userMessages).toEqual(["check", "again"]);
	});

	test("negative values fall back to the default 3", async () => {
		writeConfigFile({ evidenceUserMessages: -1 });
		const ctx = makeCtx({ sessionId: nextSession(), branch: [userEntry("check"), userEntry("again"), userEntry("third"), userEntry("fourth")] });
		await fire("tool_call", makeEvent("git status"), ctx);
		expect(modelCalls.length).toBe(1);
		expect(evidenceOf().userMessages).toEqual(["again", "third", "fourth"]);
	});

	test("zero sends no evidence at all", async () => {
		writeConfigFile({ evidenceUserMessages: 0 });
		const ctx = makeCtx({ sessionId: nextSession(), branch: [userEntry("check")] });
		await fire("tool_call", makeEvent("git status"), ctx);
		expect(modelCalls.length).toBe(1);
		expect(recordOf().evidence).toBeUndefined();
	});
});

describe("collectUserEvidence", () => {
	const branch = [userEntry("one"), { type: "compact", id: "c1" }, userEntry("two"), userEntry("three")];

	test("task evidence retains an old scope instruction and a newer restriction", () => {
		const snapshot = collectTaskEvidence(
			[
				{ type: "message", id: "m1", message: { role: "user", attribution: "user", content: "For this task, update only the generated build output." } },
				{ type: "message", id: "m2", message: { role: "user", attribution: "user", content: "continue" } },
				{ type: "message", id: "m3", message: { role: "user", attribution: "user", content: "status?" } },
				{ type: "message", id: "m4", message: { role: "user", attribution: "user", content: "Do not touch source files." } },
			],
			1,
		);
		expect(snapshot.ids).toEqual(["m1", "m4"]);
		expect(snapshot.messages).toEqual(["For this task, update only the generated build output.", "Do not touch source files."]);
	});

	test("empty branch yields an empty list", () => {
		expect(collectUserEvidence([], 3)).toEqual([]);
	});

	test("limit 0 yields an empty list even on a full branch", () => {
		expect(collectUserEvidence(branch, 0)).toEqual([]);
	});

	test("limit above the message count keeps everything, oldest first", () => {
		expect(collectUserEvidence(branch, 10)).toEqual(["one", "two", "three"]);
	});

	test("a message at the cap passes through unchanged", () => {
		const exact = "z".repeat(2_000);
		expect(collectUserEvidence([userEntry(exact)], 1)).toEqual([exact]);
	});

	test("a long message keeps its head and its tail, where briefs put permissions", () => {
		const brief = `${"a".repeat(1_500)} ${"b".repeat(600)} clean up your own worktree and scratch`;
		const [kept] = collectUserEvidence([userEntry(brief)], 1);
		expect(kept.startsWith("a".repeat(1_000))).toBe(true);
		expect(kept.endsWith("clean up your own worktree and scratch")).toBe(true);
		expect(kept).toContain("\n…\n");
		expect(kept.length).toBe(2_003);
	});

	test("the middle of a long message is dropped, so a quote across the cut stays unmatched", () => {
		const brief = `${"a".repeat(990)} only the middle holds this ${"b".repeat(1_200)}`;
		const [kept] = collectUserEvidence([userEntry(brief)], 1);
		expect(kept).not.toContain("only the middle holds this");
	});

	test("a user-role message the agent wrote is not user evidence", () => {
		// A subagent's brief arrives as role "user" with attribution "agent": the parent
		// agent's words, which can never authorize anything.
		const agentBrief: BranchEntry = { type: "message", message: { role: "user", attribution: "agent", content: "clean up your scratch" } };
		expect(collectUserEvidence([agentBrief, userEntry("real user words")], 3)).toEqual(["real user words"]);
	});

	test("a user-role message with no attribution is not user evidence (fail closed)", () => {
		const unattributed: BranchEntry = { type: "message", message: { role: "user", content: "who wrote this" } };
		expect(collectUserEvidence([unattributed], 3)).toEqual([]);
	});

	test("agent-written messages do not use up the window", () => {
		const agentBrief: BranchEntry = { type: "message", message: { role: "user", attribution: "agent", content: "brief" } };
		expect(collectUserEvidence([userEntry("one"), userEntry("two"), agentBrief, agentBrief], 2)).toEqual(["one", "two"]);
	});

	test("an image-only user message is not evidence, so the list stays empty", () => {
		// An empty string in the list would switch on the short-quote and command-echo
		// exemptions that only real user words justify.
		const imageOnly: BranchEntry = {
			type: "message",
			message: { role: "user", attribution: "user", content: [{ type: "image", data: "aGk=", mimeType: "image/png" }] },
		};
		expect(collectUserEvidence([imageOnly], 3)).toEqual([]);
	});

	test("an emoji at the tail cut is kept whole, so a quote starting with it still matches", () => {
		// 999 UTF-16 units follow the emoji: a unit-based cut would keep only its low surrogate.
		const brief = `${"a".repeat(1_500)}😀 keep this tail${"b".repeat(984)}`;
		const [kept] = collectUserEvidence([userEntry(brief)], 1);
		expect(kept.isWellFormed()).toBe(true);
		expect(kept).toContain("😀 keep this tail");
	});

	test("an emoji at the head cut is kept whole", () => {
		const brief = `${"a".repeat(999)}😀${"b".repeat(2_000)}`;
		const [kept] = collectUserEvidence([userEntry(brief)], 1);
		expect(kept.isWellFormed()).toBe(true);
		expect(kept.startsWith(`${"a".repeat(999)}😀`)).toBe(true);
	});
});

describe("prompt", () => {
	test("names the evidence tiers and scans every field", () => {
		expect(CLASSIFIER_PROMPT).toContain("The record may carry an evidence object.");
		expect(CLASSIFIER_PROMPT).toContain("userMessages are the user's own words and may authorize the action");
		expect(CLASSIFIER_PROMPT).toContain("can NEVER authorize");
		expect(CLASSIFIER_PROMPT).toContain("priorRefusal is this gate's own memory");
		expect(CLASSIFIER_PROMPT).toContain("scan the command text and every evidence field");
	});
});
