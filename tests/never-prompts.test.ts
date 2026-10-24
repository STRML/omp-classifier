/**
 * The gate never prompts (https://github.com/STRML/omp-classifier/issues/184).
 *
 * Every path that used to open a dialog blocks instead, with a refusal payload
 * whose `layer` names the cause and whose `next` tells the agent what to do.
 * The user unblocks a refused target by saying so in chat: on the retry, a SAFE
 * verdict whose authorization is grounded in user words, after a user message
 * newer than the refusal, lifts it.
 *
 * Every ctx here has a UI and a `select` that fails the test if called.
 */
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { ExtensionContext } from "@oh-my-pi/pi-coding-agent";
import type { DecisionRecord } from "../index";
import { jevQuestionsHash } from "../jev";
import {
	fire,
	fireCommand,
	jevSafeAnswer,
	jevUnsafeAnswer,
	jevUnsureAnswer,
	loadPlugin,
	makeCtx,
	makeEvent,
	makeSettings,
	modelCalls,
	notifyCalls,
	refusalOf,
	removeConfigFile,
	resultText,
	setJevAnswer,
	setJevUnavailable,
	stateOf,
} from "./fixtures";

type Branch = ReadonlyArray<{ type: string; id?: string; message?: { role?: string; attribution?: string; content?: unknown } }>;

let dir = "";
let seq = 0;
let dialogs = 0;
const nextSession = (): string => `never-prompts-${(seq += 1)}`;

const userMessage = (id: string, content: string) => ({ type: "message", id, message: { role: "user", attribution: "user", content } });

/** A UI session whose dialog is a test failure. */
function uiCtx(sessionId: string, branch: Branch = [], hasUI = true): ExtensionContext {
	const ctx = makeCtx({ sessionId, hasUI, branch });
	(ctx.ui as unknown as { select: () => Promise<string | undefined> }).select = () => {
		dialogs += 1;
		return Promise.resolve("Allow once");
	};
	return ctx;
}

const readDecisions = (): DecisionRecord[] =>
	fs
		.readFileSync(path.join(dir, "decisions.jsonl"), "utf8")
		.split("\n")
		.filter(line => line.trim() !== "")
		.map(line => JSON.parse(line) as DecisionRecord);

const evalEvent = (code: string) => ({ toolName: "eval", input: { code, language: "js" } });

beforeEach(async () => {
	removeConfigFile();
	dir = fs.mkdtempSync(path.join(os.tmpdir(), "omp-never-prompts-"));
	process.env.OMP_JEV_CONFIG = path.join(dir, "omp-classifier.json");
	await loadPlugin(makeSettings([]));
	dialogs = 0;
});

afterEach(() => {
	expect(dialogs).toBe(0);
	fs.rmSync(dir, { recursive: true, force: true });
});

describe("every former dialog blocks with a cause", () => {
	test("a critical pattern tells the agent to ask the user to run it", async () => {
		const result = await fire("tool_call", makeEvent("rm -rf /"), uiCtx(nextSession()));
		const payload = refusalOf(result);
		expect(payload.layer).toBe("critical");
		expect(payload.next).toContain("run the command themselves");
		expect(modelCalls).toHaveLength(0);
	});

	test("a caller-supplied env blocks", async () => {
		const result = await fire("tool_call", makeEvent("ls", { env: { FOO: "1" } }), uiCtx(nextSession()));
		expect(refusalOf(result).layer).toBe("environment");
	});

	test("UNSAFE blocks and tells the agent to ask in chat", async () => {
		setJevAnswer(jevUnsafeAnswer());
		const payload = refusalOf(await fire("tool_call", makeEvent("git branch -D feature-x"), uiCtx(nextSession())));
		expect(payload.layer).toBe("unsafe");
		expect(payload.next).toContain("ask the user in chat");
	});

	test("UNSURE blocks", async () => {
		setJevAnswer(jevUnsureAnswer());
		const payload = refusalOf(await fire("tool_call", makeEvent("git branch -D feature-y"), uiCtx(nextSession())));
		expect(payload.layer).toBe("unsure");
	});

	test("UNAVAILABLE blocks, and the agent is told about /classifier off", async () => {
		setJevUnavailable(true);
		const payload = refusalOf(await fire("tool_call", makeEvent("git branch -D feature-z"), uiCtx(nextSession())));
		expect(payload.layer).toBe("unavailable");
		expect(payload.next).toContain("/classifier off");
	});

	test("SAFE with an overlay flag blocks and names the flag", async () => {
		setJevAnswer(jevSafeAnswer());
		const payload = refusalOf(await fire("tool_call", makeEvent("rm -r build"), uiCtx(nextSession())));
		expect(payload.layer).toBe("flagged");
		expect(payload.why).toContain("rm");
		expect(payload.why).toContain("trash");
	});

	test("SAFE with an overlay flag still blocks after the user asks for it", async () => {
		setJevAnswer(jevSafeAnswer());
		const sid = nextSession();
		await fire("tool_call", makeEvent("rm -r build"), uiCtx(sid, [userMessage("u1", "clean up")]));
		const branch = [userMessage("u1", "clean up"), userMessage("u2", "yes, run rm -r build")];
		const payload = refusalOf(await fire("tool_call", makeEvent("rm -r build"), uiCtx(sid, branch)));
		expect(payload.layer).toBe("flagged");
	});

	test("eval: UNSAFE blocks without a dialog", async () => {
		setJevAnswer(jevUnsafeAnswer());
		const code = `require("child_process").exec("git branch -D feature-eval")`;
		expect(refusalOf(await fire("tool_call", evalEvent(code), uiCtx(nextSession()))).layer).toBe("unsafe");
	});

	test("eval: an unreadable spawn cwd blocks", async () => {
		const code = `const cp = require("child_process");\ncp.exec("echo hi", { cwd: process.env.TARGET });`;
		expect(refusalOf(await fire("tool_call", evalEvent(code), uiCtx(nextSession()))).layer).toBe("cwd");
		expect(modelCalls).toHaveLength(0);
	});

	test("eval: SAFE with a flag blocks", async () => {
		setJevAnswer(jevSafeAnswer());
		const code = `require("child_process").exec("rm -rf build")`;
		expect(refusalOf(await fire("tool_call", evalEvent(code), uiCtx(nextSession()))).layer).toBe("flagged");
	});

	test("a verdict block writes the lead line and one blocked line after it", async () => {
		setJevAnswer(jevUnsafeAnswer());
		await fire("tool_call", makeEvent("git branch -D feature-audit"), uiCtx(nextSession()));
		const lines = readDecisions();
		expect(lines.map(line => line.layer)).toEqual(["verdict", "blocked"]);
		expect(lines[1].followsDecisionId).toBe(lines[0].decisionId);
		expect(lines[1].approval).toBeUndefined();
	});

	test("dry-run reports a block, not a prompt", async () => {
		setJevAnswer(jevUnsafeAnswer());
		const ctx = makeCtx({ sessionId: nextSession() });
		await fireCommand("classifier", "dry-run rm -rf /", ctx);
		const report = JSON.parse(notifyCalls(ctx).at(-1)?.[0] ?? "{}") as Record<string, unknown>;
		expect(report.would).toBe("block");
		expect(String(report.why)).not.toContain("would prompt");
	});
});

describe("control flow only", () => {
	test("the battery hash is the one main shipped before the change", () => {
		// 0561a20b8f3df930 is jev-v2.17's hash (CHANGELOG, 2026-10-24). This
		// change moves no question, option or threshold.
		expect(jevQuestionsHash()).toBe("0561a20b8f3df930");
	});
});

describe("a refusal and the user's words", () => {
	const refusedBranch = "git branch -D topic";

	test("a cap refusal never yields, even when the user names the target", async () => {
		const sid = nextSession();
		const before = [userMessage("u1", "clean up the logs")];
		// Refused by the length cap under the key `trash old.log`.
		const longTrash = `trash old.log ${"x ".repeat(4100)}`;
		expect(refusalOf(await fire("tool_call", makeEvent(longTrash), uiCtx(sid, before))).layer).toBe("cap");

		setJevAnswer(jevSafeAnswer());
		const after = [...before, userMessage("u2", "yes, delete old.log")];
		const payload = refusalOf(await fire("tool_call", makeEvent("trash old.log"), uiCtx(sid, after)));
		expect(payload.layer).toBe("prior-refusal");
		expect(payload.next).toContain("run the command themselves");
	});

	test("a critical pattern stays blocked after the user says go ahead", async () => {
		const sid = nextSession();
		await fire("tool_call", makeEvent("rm -rf /"), uiCtx(sid, [userMessage("u1", "clean up")]));
		const after = [userMessage("u1", "clean up"), userMessage("u2", "go ahead, run rm -rf /")];
		expect(refusalOf(await fire("tool_call", makeEvent("rm -rf /"), uiCtx(sid, after))).layer).toBe("critical");
	});

	test("an unrelated new message does not let a SAFE past a model refusal", async () => {
		const sid = nextSession();
		const before = [userMessage("u1", "tidy up the repo")];
		setJevAnswer(jevUnsafeAnswer());
		expect(refusalOf(await fire("tool_call", makeEvent(refusedBranch), uiCtx(sid, before))).layer).toBe("unsafe");

		setJevAnswer(jevSafeAnswer());
		const after = [...before, userMessage("u2", "thanks, looks good")];
		expect(refusalOf(await fire("tool_call", makeEvent(refusedBranch), uiCtx(sid, after))).layer).toBe("prior-refusal");
	});

	test("a newer message that names the target runs this call only", async () => {
		const sid = nextSession();
		const before = [userMessage("u1", "tidy up the repo")];
		setJevAnswer(jevUnsafeAnswer());
		await fire("tool_call", makeEvent(refusedBranch), uiCtx(sid, before));

		setJevAnswer(jevSafeAnswer());
		const named = [...before, userMessage("u2", "yes, delete the branch topic")];
		expect(resultText(await fire("tool_call", makeEvent(refusedBranch), uiCtx(sid, named)))).toBe("ALLOWED");

		// The record stays: the next call still carries the refusal to the judge
		// and meets the same check.
		const calls = modelCalls.length;
		await fire("tool_call", makeEvent(`${refusedBranch} `), uiCtx(sid, [...named, userMessage("u3", "and again")]));
		expect(modelCalls.length).toBe(calls + 1);
		expect(JSON.stringify(stateOf(calls))).toContain("priorRefusal");
	});

	test("words from before the refusal do not count", async () => {
		const sid = nextSession();
		const before = [userMessage("u1", "delete the branch topic")];
		setJevAnswer(jevUnsafeAnswer());
		await fire("tool_call", makeEvent(refusedBranch), uiCtx(sid, before));
		setJevAnswer(jevSafeAnswer());
		const after = [...before, userMessage("u2", "ok")];
		expect(refusalOf(await fire("tool_call", makeEvent(refusedBranch), uiCtx(sid, after))).layer).toBe("prior-refusal");
	});

	test("a headless session cannot get past a refusal", async () => {
		const sid = nextSession();
		setJevAnswer(jevUnsafeAnswer());
		await fire("tool_call", makeEvent(refusedBranch), uiCtx(sid, [], false));
		setJevAnswer(jevSafeAnswer());
		const branch = [userMessage("u1", "yes, delete the branch topic")];
		// A trailing space is a new cache key but the same refusal target.
		expect(refusalOf(await fire("tool_call", makeEvent(`${refusedBranch} `), uiCtx(sid, branch, false))).layer).toBe("prior-refusal");
	});

	test("with evidenceUserMessages 0 the judge sees no user words, so nothing yields", async () => {
		fs.writeFileSync(path.join(dir, "omp-classifier.json"), JSON.stringify({ evidenceUserMessages: 0 }));
		const sid = nextSession();
		setJevAnswer(jevUnsafeAnswer());
		await fire("tool_call", makeEvent(refusedBranch), uiCtx(sid, [userMessage("u1", "tidy up")]));
		setJevAnswer(jevSafeAnswer());
		const after = [userMessage("u1", "tidy up"), userMessage("u2", "yes, delete the branch topic")];
		expect(refusalOf(await fire("tool_call", makeEvent(`${refusedBranch} `), uiCtx(sid, after))).layer).toBe("prior-refusal");
	});
});
