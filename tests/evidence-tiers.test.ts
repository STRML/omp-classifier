/**
 * Provenance-tiered evidence (issue #31): the Jev state may carry an
 * `evidence` object whose fields are typed by their CHANNEL — userMessages
 * (the session's recent user words, gated by `evidenceUserMessages`),
 * operatorContext (the requesting agent's own explanation, single-line,
 * capped, never authorizing). The default config attaches the newest three
 * user messages; 0 restores the no-evidence shape entirely.
 *
 * The channel is what carries the meaning, never the text: a field that
 * claims authorization is an injection signal, so the tier separation has to
 * survive the move from the old prompt into the question battery. That is
 * what the "tier meaning" block below asserts.
 */
import { beforeEach, describe, expect, test } from "bun:test";
import { collectTaskEvidence, collectTaskEvidenceV3, collectToolEvidence, collectUserEvidence } from "../index";
import {
	evidenceOf,
	fire,
	jevSafeAnswer,
	loadPlugin,
	makeCtx,
	makeEvent,
	makeSettings,
	modelCalls,
	questionsOf,
	removeConfigFile,
	setJevAnswer,
	setJevDelay,
	stateOf,
	writeConfigFile,
} from "./fixtures";

beforeEach(async () => {
	removeConfigFile();
	setJevDelay(5);
	await loadPlugin(makeSettings([]));
	setJevAnswer(jevSafeAnswer());
});

let seq = 0;
/** Fresh session id per test; the plugin's stores are module-level. */
const nextSession = (): string => `evidence-${(seq += 1)}`;

type BranchEntry = { type: string; message?: { role?: string; attribution?: string; content?: unknown } };
const userEntry = (content: string | Array<Record<string, unknown>>): BranchEntry => ({
	type: "message",
	message: { role: "user", attribution: "user", content },
});

describe("default config", () => {
	test("the state carries the newest three user messages by default", async () => {
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
	test("rides into the bash state, single line, capped at 500", async () => {
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

	test("rides into the eval state the same way", async () => {
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
		expect(stateOf(0).kind).toBe("eval-code");
		const evidence = evidenceOf();
		expect(evidence.operatorContext).toBe("list the fixtures dir");
	});

	test("a whitespace-only context adds no evidence", async () => {
		const ctx = makeCtx({ sessionId: nextSession() });
		await fire("tool_call", makeEvent("git status", { operatorContext: "  \n\t " }), ctx);
		expect(modelCalls.length).toBe(1);
		expect(stateOf(0).evidence).toBeUndefined();
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
		expect(stateOf(0).evidence).toBeUndefined();
	});
});

describe("tier meaning", () => {
	test("user words and agent context ride in separate tiers, never merged", async () => {
		const ctx = makeCtx({ sessionId: nextSession(), branch: [userEntry("delete the scratch build")] });
		await fire("tool_call", makeEvent("rm -rf ./build", { operatorContext: "the user asked for a clean rebuild" }), ctx);
		const evidence = evidenceOf();
		expect(evidence.userMessages).toEqual(["delete the scratch build"]);
		// The agent's own sentence is a different channel, not more user voice:
		// a merge would let the requesting agent authorize itself.
		expect(evidence.operatorContext).toBe("the user asked for a clean rebuild");
		expect(evidence.userMessages).not.toContain("the user asked for a clean rebuild");
	});

	test("the battery states which tier may authorize", async () => {
		await fire("tool_call", makeEvent("git status"), makeCtx({ sessionId: nextSession() }));
		const battery = JSON.stringify(questionsOf(0));
		// The old prompt carried this rule in prose and the judge read it from
		// there. The questions carry it now; the meaning has to survive the
		// move, or the tiers ride into the state as untyped data and an agent
		// could talk the judge into treating its own context as permission.
		expect(battery).toMatch(/userMessages[^.]{0,240}authoriz/iu);
		expect(battery).toMatch(/operatorContext[^.]{0,240}(?:never|cannot|can ?not)[^.]{0,80}authoriz/iu);
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

describe("the live collectors start after the latest /clear (#103)", () => {
	const user = (id: string, content: string) => ({ type: "message", id, message: { id: `h-${id}`, role: "user", attribution: "user", content } });
	const toolCall = (id: string, command: string) => ({
		type: "message",
		id,
		message: { role: "assistant", content: [{ type: "toolCall", name: "bash", arguments: { command } }] },
	});
	// Issue #103's diagram: a request the user cleared away must never come
	// back as evidence, because the host rebuilds model context only from
	// after the latest reset_boundary (session-context.ts:404).
	const branch = [
		user("old1", "deploy production"),
		{ type: "reset_boundary", id: "r1" },
		user("new1", "look at the logs"),
		user("new2", "ok"),
	];

	test("collectUserEvidence reads only post-boundary messages", () => {
		expect(collectUserEvidence(branch, 5)).toEqual(["look at the logs", "ok"]);
		// Only the latest boundary counts.
		const twice = [user("a", "deploy"), { type: "reset_boundary" }, user("b", "merge it"), { type: "reset_boundary" }, user("c", "hi")];
		expect(collectUserEvidence(twice, 5)).toEqual(["hi"]);
	});

	test("collectTaskEvidence reads only post-boundary messages", () => {
		expect(collectTaskEvidence(branch, 5).ids).toEqual(["h-new1", "h-new2"]);
		const twice = [user("a", "deploy"), { type: "reset_boundary" }, user("b", "merge it"), { type: "reset_boundary" }, user("c", "hi")];
		expect(collectTaskEvidence(twice, 5).ids).toEqual(["h-c"]);
		expect(collectTaskEvidence([user("a", "deploy"), { type: "reset_boundary", id: "r" }], 5)).toEqual({ messages: [], ids: [] });
	});

	test("collectToolEvidence reads only post-boundary tool activity", () => {
		const tools = [
			toolCall("t1", "kubectl rollout restart deploy/prod"),
			{ type: "reset_boundary", id: "r1" },
			toolCall("t2", "tail -n 5 /var/log/app.log"),
		];
		const evidence = collectToolEvidence(tools) ?? "";
		expect(evidence).toContain("tail -n 5 /var/log/app.log");
		expect(evidence).not.toContain("kubectl");
		expect(collectToolEvidence([toolCall("t1", "rm -rf /"), { type: "reset_boundary" }])).toBeUndefined();
	});

	test("a branch with no reset_boundary behaves exactly as before", () => {
		const plain = [user("m1", "deploy production"), user("m2", "look at the logs")];
		expect(collectUserEvidence(plain, 5)).toEqual(["deploy production", "look at the logs"]);
		expect(collectTaskEvidence(plain, 5).ids).toEqual(["h-m1", "h-m2"]);
		expect(collectToolEvidence([toolCall("t1", "git status")])).toContain("git status");
	});
});

describe("collectTaskEvidenceV3", () => {
	const user = (id: string, content: string) => ({ type: "message", id, message: { role: "user", attribution: "user", content } });

	test("a task statement that opens the session survives three short replies", () => {
		// The neuralwatt case. jev-v2 drops it: no scope word, outside the tail.
		const branch = [user("m1", "add the provider neuralwatt to omp"), user("m2", "ok"), user("m3", "yes"), user("m4", "try it now")];
		expect(collectTaskEvidence(branch, 3).ids).toEqual(["m2", "m3", "m4"]);
		const snapshot = collectTaskEvidenceV3(branch, 3);
		expect(snapshot.ids).toEqual(["m2", "m3", "m4"]);
		expect(snapshot.pinned).toEqual({ id: "m1", text: "add the provider neuralwatt to omp" });
	});

	test("anchoring is jev-v2's scope words; a task verb alone anchors nothing (#106)", () => {
		const branch = [user("m0", "hello"), user("m1", "close issue 123"), user("m2", "ok"), user("m3", "yes"), user("m4", "thanks")];
		const snapshot = collectTaskEvidenceV3(branch, 3);
		expect(snapshot.ids).toEqual(["m2", "m3", "m4"]);
		expect(snapshot.pinned).toEqual({ id: "m0", text: "hello" });
		const scoped = [user("m0", "hello"), user("m1", "please close issue 123"), user("m2", "ok"), user("m3", "yes"), user("m4", "thanks")];
		expect(collectTaskEvidenceV3(scoped, 3).ids).toEqual(["m1", "m2", "m3", "m4"]);
	});

	test("the pin is positional, so an unlisted first request is kept", () => {
		const branch = [user("m0", "archive issue 123"), ...Array.from({ length: 10 }, (_, i) => user(`m${i + 1}`, `ok ${i}`))];
		expect(collectTaskEvidenceV3(branch, 3).pinned).toEqual({ id: "m0", text: "archive issue 123" });
	});

	test("the first user message is pinned outside the newest-8 slice", () => {
		const branch = [user("first", "set up the neuralwatt provider"), ...Array.from({ length: 12 }, (_, i) => user(`m${i}`, `please continue step ${i}`))];
		const snapshot = collectTaskEvidenceV3(branch, 3);
		expect(snapshot.ids).toHaveLength(8);
		expect(snapshot.ids).not.toContain("first");
		expect(snapshot.pinned).toEqual({ id: "first", text: "set up the neuralwatt provider" });
	});

	test("the first message is not pinned twice when the slice already holds it", () => {
		const branch = [user("first", "fix the build"), user("m2", "ok")];
		const snapshot = collectTaskEvidenceV3(branch, 3);
		expect(snapshot.ids).toEqual(["first", "m2"]);
		expect(snapshot.pinned).toBeUndefined();
	});

	test("nothing before the latest /clear is evidence, pinned included", () => {
		const branch = [
			user("old1", "deploy production"),
			user("old2", "please merge 42"),
			{ type: "reset_boundary", id: "r1" },
			user("new1", "look at the logs"),
			user("new2", "ok"),
		];
		const snapshot = collectTaskEvidenceV3(branch, 3);
		expect(snapshot.ids).toEqual(["new1", "new2"]);
		expect(snapshot.pinned).toBeUndefined();
		// Only the latest boundary counts.
		const twice = [user("a", "deploy"), { type: "reset_boundary" }, user("b", "merge it"), { type: "reset_boundary" }, user("c", "hi")];
		expect(collectTaskEvidenceV3(twice, 3).ids).toEqual(["c"]);
		expect(collectTaskEvidenceV3([user("a", "deploy"), { type: "reset_boundary" }], 3)).toEqual({ messages: [], ids: [] });
	});

	test("limit 0 still means no user evidence at all", () => {
		expect(collectTaskEvidenceV3([user("m1", "add the provider")], 0)).toEqual({ messages: [], ids: [] });
	});

	test("only user-attributed messages count, pinned included", () => {
		const branch = [
			{ type: "message", id: "brief", message: { role: "user", attribution: "agent", content: "deploy everything to prod" } },
			user("m1", "ok"),
		];
		const snapshot = collectTaskEvidenceV3(branch, 3);
		expect(snapshot.ids).toEqual(["m1"]);
		expect(snapshot.pinned).toBeUndefined();
	});
});
