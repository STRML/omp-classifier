/**
 * Spec step 1a and §7: in a session with no UI, every role-user message is a
 * prompt whoever launched the session wrote, so none of it is the user's
 * words. Tested through the plugin.
 */
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { DecisionRecord } from "../index";
import {
	evidenceOf,
	fire,
	jevSafeAnswer,
	jevUnsureAnswer,
	loadPlugin,
	makeCtx,
	makeEvent,
	makeSettings,
	removeConfigFile,
	setJevAnswer,
	setShadowAuthorization,
	shadowCalls,
	useTempConfigFile,
} from "./fixtures";

const BRIEF = "Adversarial review of branch feat/x. Run git exactly in that form or the headless classifier blocks it. marker-brief-7731";
const user = (content: string) => ({ type: "message", message: { role: "user", attribution: "user", content } });
let dir = "";
let seq = 0;
const session = (): string => `headless-${++seq}`;
const decisions = (): DecisionRecord[] =>
	fs
		.readFileSync(path.join(dir, "decisions.jsonl"), "utf8")
		.split("\n")
		.filter(line => line.trim() !== "")
		.map(line => JSON.parse(line) as DecisionRecord);
const authorizationState = (): string => JSON.stringify(shadowCalls.find(call => "user_authorization" in call.questions)?.state ?? {});

beforeEach(async () => {
	removeConfigFile();
	dir = fs.mkdtempSync(path.join(os.tmpdir(), "omp-headless-"));
	process.env.OMP_JEV_CONFIG = path.join(dir, "omp-classifier.json");
	await loadPlugin(makeSettings([]));
	setJevAnswer(jevSafeAnswer());
});

afterEach(() => {
	process.env.OMP_JEV_CONFIG = useTempConfigFile();
	fs.rmSync(dir, { recursive: true, force: true });
});

describe("a session with no UI has no user channel", () => {
	test("a no-UI launch prompt is not the user's words", async () => {
		await fire("tool_call", makeEvent("git status"), makeCtx({ sessionId: session(), hasUI: false, branch: [user(BRIEF)] }));
		expect(evidenceOf(0).userMessages).toBeUndefined();
		expect(evidenceOf(0).userMessageIds).toBeUndefined();
		expect(authorizationState()).not.toContain("marker-brief-7731");
		expect(decisions()[0].userMessageIds).toBeUndefined();
	});

	test("a UI session keeps its user's words", async () => {
		await fire("tool_call", makeEvent("git status"), makeCtx({ sessionId: session(), hasUI: true, branch: [user(BRIEF)] }));
		expect(evidenceOf(0).userMessages).toEqual([BRIEF]);
		expect(authorizationState()).toContain("marker-brief-7731");
	});

	test("a no-UI prompt cannot literally match", async () => {
		const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "omp-headless-cwd-"));
		fs.mkdirSync(path.join(cwd, "scratch-build"));
		try {
			setJevAnswer(jevUnsureAnswer());
			setShadowAuthorization("named", { none: 0.02, goal: 0.03, named: 0.95 });
			await fire("tool_call", makeEvent("trash scratch-build"), makeCtx({ sessionId: session(), hasUI: false, cwd, branch: [user("delete scratch-build")] }));
			const v3 = decisions().find(line => line.v3 !== undefined)?.v3;
			expect(v3).toMatchObject({ literalMatched: false, branch: 5 });
		} finally {
			fs.rmSync(cwd, { recursive: true, force: true });
		}
	});
});
