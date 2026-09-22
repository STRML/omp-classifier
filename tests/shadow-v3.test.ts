/**
 * The jev-v3 shadow (plan `docs/plans/2026-09-19-intent-aware-judgment.md`,
 * Phase 2 step 8). It runs beside the live jev-v2 judgment on every fresh
 * classification, logs its decision on the same line as `v3`, and changes
 * nothing live: the verdict, the dialog, the cache, and the live request
 * count all read the same with it on or off.
 */
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { DecisionRecord } from "../index";
import {
	fire,
	jevSafeAnswer,
	jevUnsureAnswer,
	loadPlugin,
	makeCtx,
	makeEvent,
	makeSettings,
	modelCalls,
	removeConfigFile,
	setJevAnswer,
	setShadowAuthorization,
	setShadowFailure,
	shadowCalls,
	useTempConfigFile,
} from "./fixtures";

let dir = "";
let seq = 0;
const session = (): string => `shadow-${++seq}`;
const user = (content: string) => ({ type: "message", message: { role: "user", attribution: "user", content } });

const readDecisions = (): DecisionRecord[] =>
	fs
		.readFileSync(path.join(dir, "decisions.jsonl"), "utf8")
		.split("\n")
		.filter(line => line.trim() !== "")
		.map(line => JSON.parse(line) as DecisionRecord);

const last = (): DecisionRecord => {
	const lines = readDecisions();
	return lines[lines.length - 1];
};

beforeEach(async () => {
	removeConfigFile();
	dir = fs.mkdtempSync(path.join(os.tmpdir(), "omp-shadow-"));
	process.env.OMP_JEV_CONFIG = path.join(dir, "omp-classifier.json");
	await loadPlugin(makeSettings([]));
	setJevAnswer(jevSafeAnswer());
});

afterEach(() => {
	process.env.OMP_JEV_CONFIG = useTempConfigFile();
	fs.rmSync(dir, { recursive: true, force: true });
});

describe("the shadow rides the live classification", () => {
	test("a fresh classification asks the two shadow requests and logs v3 beside the live verdict", async () => {
		const result = await fire("tool_call", makeEvent(`echo shadow-${seq}`), makeCtx({ sessionId: session(), hasUI: true }));
		expect(result).toBeUndefined();
		// One live request, exactly as before; the shadow's two are separate.
		expect(modelCalls).toHaveLength(1);
		expect(shadowCalls).toHaveLength(2);
		const line = last();
		expect(line.verdict).toBe("SAFE");
		expect(line.v3).toMatchObject({ verdict: "SAFE", branch: 3, reasonCode: "jev-v3:3:safe", authorization: "none", literalMatched: false });
	});

	test("the shadow's record holds labels and numbers, never message text", async () => {
		const ctx = makeCtx({ sessionId: session(), hasUI: true, branch: [user("please ship the release notes, secret word pineapple")] });
		await fire("tool_call", makeEvent("echo notes"), ctx);
		const v3 = last().v3;
		expect(v3).toBeDefined();
		expect(JSON.stringify(v3)).not.toContain("pineapple");
		expect(Object.keys(v3 ?? {}).sort()).toEqual(["authorization", "branch", "literalMatched", "live", "ms", "namedFirm", "overlay", "reasonCode", "verdict"]);
	});

	test("shadowV3 false: no shadow requests and no v3 field", async () => {
		// This file's own config path, so the decision log stays in `dir`.
		fs.writeFileSync(path.join(dir, "omp-classifier.json"), JSON.stringify({ shadowV3: false }));
		await fire("tool_call", makeEvent("echo off"), makeCtx({ sessionId: session(), hasUI: true }));
		expect(shadowCalls).toHaveLength(0);
		expect(modelCalls).toHaveLength(1);
		expect(last().v3).toBeUndefined();
	});

	test("a failing shadow changes nothing live and logs its error", async () => {
		setShadowFailure(true);
		const result = await fire("tool_call", makeEvent("echo still-runs"), makeCtx({ sessionId: session(), hasUI: true }));
		expect(result).toBeUndefined();
		const line = last();
		expect(line.verdict).toBe("SAFE");
		expect(line.v3).toMatchObject({ error: expect.stringContaining("shadow judge unavailable") });
	});

	test("a cached verdict's dialog line carries no shadow (#110 gate round 1)", async () => {
		setJevAnswer(jevUnsureAnswer());
		const ctx = makeCtx({ sessionId: session(), hasUI: false });
		await fire("tool_call", makeEvent("echo cached-dialog"), ctx);
		const firstCount = readDecisions().length;
		await fire("tool_call", makeEvent("echo cached-dialog"), ctx);
		const second = readDecisions().slice(firstCount);
		expect(second.length).toBeGreaterThan(0);
		for (const entry of second) expect(entry.v3).toBeUndefined();
		expect(shadowCalls).toHaveLength(2);
	});

	test("the shadow records the live verdict it ran beside", async () => {
		await fire("tool_call", makeEvent("echo live-verdict"), makeCtx({ sessionId: session(), hasUI: true }));
		expect(last().v3).toMatchObject({ live: "SAFE" });
	});

	test("a cached verdict asks nothing, shadow included", async () => {
		const ctx = makeCtx({ sessionId: session(), hasUI: true });
		await fire("tool_call", makeEvent("echo cached-twice"), ctx);
		await fire("tool_call", makeEvent("echo cached-twice"), ctx);
		expect(modelCalls).toHaveLength(1);
		expect(shadowCalls).toHaveLength(2);
	});
});

describe("the shadow decides by the jev-v3 order", () => {
	test("a named, literally matched delete takes branch 4 in shadow while live still asks", async () => {
		const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "omp-shadow-cwd-"));
		fs.mkdirSync(path.join(cwd, "scratch-build"));
		try {
			setJevAnswer(jevUnsureAnswer());
			setShadowAuthorization("named", { none: 0.02, goal: 0.03, named: 0.95 });
			const ctx = makeCtx({ sessionId: session(), hasUI: false, cwd, branch: [user("delete scratch-build")] });
			const result = await fire("tool_call", makeEvent("trash scratch-build"), ctx);
			// Live: jev-v2 is unsure and nobody can answer a dialog.
			expect(result).toMatchObject({ block: true });
			const v3 = readDecisions().find(line => line.v3 !== undefined)?.v3;
			expect(v3).toMatchObject({ branch: 4, verdict: "SAFE", authorization: "named", namedFirm: true, literalMatched: true });
		} finally {
			fs.rmSync(cwd, { recursive: true, force: true });
		}
	});

	test("a named delete inside the session's artifacts dir can match (#110 gate round 1)", async () => {
		const artifacts = fs.mkdtempSync(path.join(os.tmpdir(), "omp-shadow-artifacts-"));
		fs.mkdirSync(path.join(artifacts, "scratch"));
		try {
			setJevAnswer(jevUnsureAnswer());
			setShadowAuthorization("named", { none: 0.02, goal: 0.03, named: 0.95 });
			const ctx = makeCtx({ sessionId: session(), hasUI: false, artifactsDir: artifacts, branch: [user("delete the scratch dir")] });
			await fire("tool_call", makeEvent(`trash ${path.join(artifacts, "scratch")}`), ctx);
			const v3 = readDecisions().find(entry => entry.v3 !== undefined)?.v3;
			expect(v3).toMatchObject({ literalMatched: true, branch: 4 });
		} finally {
			fs.rmSync(artifacts, { recursive: true, force: true });
		}
	});

	test("the dialog line that follows a verdict carries v3 too", async () => {
		setJevAnswer(jevUnsureAnswer());
		await fire("tool_call", makeEvent("echo needs-a-human"), makeCtx({ sessionId: session(), hasUI: false }));
		const lines = readDecisions();
		expect(lines.length).toBeGreaterThanOrEqual(1);
		for (const line of lines) expect(line.v3).toBeDefined();
	});

	test("the pinned first message reaches the authorization request", async () => {
		const branch = [user("set up the neuralwatt provider"), ...Array.from({ length: 12 }, (_, i) => user(`ok ${i}`))];
		await fire("tool_call", makeEvent("echo pin"), makeCtx({ sessionId: session(), hasUI: true, branch }));
		const authorization = shadowCalls.find(call => "user_authorization" in call.questions);
		expect(JSON.stringify(authorization?.state)).toContain("set up the neuralwatt provider");
	});
});

describe("the eval tool path", () => {
	test("eval code gets a shadow with no literal match", async () => {
		const event = { toolName: "eval", input: { code: "import subprocess\nsubprocess.run(['ls'])", language: "py" } };
		await fire("tool_call", event, makeCtx({ sessionId: session(), hasUI: true }));
		const v3 = readDecisions().find(line => line.v3 !== undefined)?.v3;
		expect(v3).toMatchObject({ literalMatched: null });
		expect(shadowCalls).toHaveLength(2);
	});
});
