/**
 * jev-v3 is the live decision (https://github.com/STRML/omp-classifier/issues/116).
 *
 * Each test is one row of the flip's failure matrix: the decision order's
 * branches as the gate acts on them, and the downstream layers (stage 2 and
 * its hazard bars, the named-host exemption, refusal memory, the verdict
 * cache) reading a v3 verdict the way they read a v2 one. The judge is the
 * fixture's scripted one: the risk battery answers from `setJevAnswer`, the
 * authorization request from `setAuthorization`.
 */
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { CLASSIFIER_POLICY_VERSION, type DecisionRecord } from "../index";
import { JEV_V3_POLICY_VERSION } from "../jev";
import {
	authorizationCalls,
	fire,
	jevNoul,
	jevSafeAnswer,
	jevUnsafeAnswer,
	jevUnsureAnswer,
	loadPlugin,
	makeCtx,
	makeEvent,
	makeSettings,
	modelCalls,
	REVIEWER_TEST_MODEL,
	refusalOf,
	removeConfigFile,
	resetReviewer,
	resultText,
	reviewerCalls,
	reviewerReply,
	scriptReviewer,
	setAuthorization,
	setAuthorizationDelay,
	setAuthorizationFailure,
	setJevAnswer,
	setJevAnsweringApi,
	setJevDelay,
	setJevUnavailable,
	signalOf,
	stateOf,
} from "./fixtures";

type Entry = { type: string; id?: string; message?: Record<string, unknown> };

let dir = "";
let seq = 0;
const nextSession = (): string => `v3-live-${(seq += 1)}`;
const user = (id: string, content: string): Entry => ({ type: "message", id, message: { role: "user", attribution: "user", content } });

const writeConfig = (extra: Record<string, unknown> = {}): void => {
	fs.writeFileSync(path.join(dir, "omp-classifier.json"), JSON.stringify({ reviewerModel: REVIEWER_TEST_MODEL, ...extra }));
};

const readDecisions = (): DecisionRecord[] =>
	fs
		.readFileSync(path.join(dir, "decisions.jsonl"), "utf8")
		.split("\n")
		.filter(line => line.trim() !== "")
		.map(line => JSON.parse(line) as DecisionRecord);

/** The verdict line of the newest decision: the one that carries the reason code. */
const verdictLine = (): DecisionRecord | undefined => readDecisions().filter(line => line.reasonCode !== undefined).at(-1);

const reviewerAudit = (): Record<string, unknown> | undefined =>
	readDecisions()
		.map(line => (line as unknown as { reviewer?: Record<string, unknown> }).reviewer)
		.filter(entry => entry !== undefined)
		.at(-1);

const NAMED = { none: 0.02, goal: 0.03, named: 0.95 };
const NAMED_SOFT = { none: 0.15, goal: 0.25, named: 0.6 };
const GOAL = { none: 0.1, goal: 0.8, named: 0.1 };

const uiCtx = (sessionId: string, branch: Entry[], cwd = dir) => makeCtx({ sessionId, hasUI: true, branch, cwd });
const headlessCtx = (sessionId: string, branch: Entry[], cwd = dir) => makeCtx({ sessionId, hasUI: false, branch, cwd });

beforeEach(async () => {
	removeConfigFile();
	dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "omp-v3-live-")));
	process.env.OMP_JEV_CONFIG = path.join(dir, "omp-classifier.json");
	writeConfig();
	await loadPlugin(makeSettings([]));
	resetReviewer();
	setJevAnsweringApi();
	fs.mkdirSync(path.join(dir, "scratch-build"));
});

afterEach(() => {
	fs.rmSync(dir, { recursive: true, force: true });
});

describe("the live policy is jev-v3", () => {
	test("every classification asks the v3 risk battery and the authorization question", async () => {
		setJevAnswer(jevSafeAnswer());
		const result = await fire("tool_call", makeEvent("echo hello"), uiCtx(nextSession(), [user("u1", "say hello")]));
		expect(result).toBeUndefined();
		expect(modelCalls).toHaveLength(1);
		expect(authorizationCalls).toHaveLength(1);
		expect(modelCalls[0].questions).toHaveProperty("task_statement");
		const line = verdictLine();
		expect(line?.reasonCode).toBe("jev-v3:3:safe");
		expect(line?.policyVersion).toBe(JEV_V3_POLICY_VERSION);
		expect(CLASSIFIER_POLICY_VERSION).toBe(JEV_V3_POLICY_VERSION);
		expect(line).not.toHaveProperty("v3");
	});

	test("a config file still carrying shadowV3 loads, and its other keys apply", async () => {
		writeConfig({ shadowV3: true, timeoutMs: 40 });
		setJevDelay(400);
		const result = await fire("tool_call", makeEvent("echo slow"), uiCtx(nextSession(), []));
		expect(refusalOf(result).layer).toBe("unavailable");
	});

	test("the pinned first message reaches both requests", async () => {
		setJevAnswer(jevSafeAnswer());
		const branch = [user("u0", "set up the neuralwatt provider"), ...Array.from({ length: 12 }, (_, i) => user(`u${i + 1}`, `ok ${i}`))];
		await fire("tool_call", makeEvent("echo pin"), uiCtx(nextSession(), branch));
		expect(JSON.stringify(stateOf(0))).toContain("set up the neuralwatt provider");
		expect(JSON.stringify(authorizationCalls[0].state)).toContain("set up the neuralwatt provider");
	});

	test("the authorization state never carries the command text", async () => {
		setJevAnswer(jevSafeAnswer());
		await fire("tool_call", makeEvent("echo marker-pineapple"), uiCtx(nextSession(), [user("u1", "go")]));
		expect(JSON.stringify(authorizationCalls[0].state)).not.toContain("marker-pineapple");
	});
});

describe("branch 4: a named, literally matched local action", () => {
	test("firm named, literal match, no overlay flag: SAFE and it runs", async () => {
		setJevAnswer(jevUnsureAnswer());
		setAuthorization("named", NAMED);
		const result = await fire("tool_call", makeEvent("trash scratch-build"), uiCtx(nextSession(), [user("u1", "delete scratch-build")]));
		expect(resultText(result)).toBe("ALLOWED");
		expect(verdictLine()?.reasonCode).toBe("jev-v3:4:named-literal");
		expect(verdictLine()?.authorization).toBe("grounded");
		expect(reviewerCalls).toHaveLength(0);
	});

	test("an overlay flag keeps it off the fast allow, and the overlay still blocks after a reviewer allow", async () => {
		setJevAnswer(jevUnsureAnswer());
		setAuthorization("named", NAMED);
		scriptReviewer(reviewerReply("allow", "delete scratch-build"));
		const result = await fire("tool_call", makeEvent("rm -r scratch-build"), uiCtx(nextSession(), [user("u1", "delete scratch-build")]));
		expect(result).toMatchObject({ block: true });
		expect(readDecisions().some(line => line.reasonCode === "jev-v3:4:named-literal")).toBe(false);
	});

	test("named below namedMinProbability goes to the reviewer, not the fast allow", async () => {
		setJevAnswer(jevUnsureAnswer());
		setAuthorization("named", NAMED_SOFT);
		scriptReviewer(reviewerReply("block"));
		const result = await fire("tool_call", makeEvent("trash scratch-build"), uiCtx(nextSession(), [user("u1", "delete scratch-build")]));
		expect(result).toMatchObject({ block: true });
		expect(readDecisions().some(line => line.reasonCode === "jev-v3:5:reviewer")).toBe(true);
		expect(reviewerCalls).toHaveLength(1);
	});

	test("no literal match: firm named alone never allows", async () => {
		setJevAnswer(jevUnsureAnswer());
		setAuthorization("named", NAMED);
		scriptReviewer(reviewerReply("block"));
		const result = await fire("tool_call", makeEvent("trash scratch-build"), uiCtx(nextSession(), [user("u1", "tidy up a bit")]));
		expect(result).toMatchObject({ block: true });
		expect(readDecisions().some(line => line.reasonCode === "jev-v3:4:named-literal")).toBe(false);
	});

	test("headless with a block-band hazard goes to the reviewer, never SAFE", async () => {
		setJevAnswer(jevUnsureAnswer({ destructive_or_irreversible: jevNoul(0.95) }));
		setAuthorization("named", NAMED);
		const result = await fire("tool_call", makeEvent("trash scratch-build"), headlessCtx(nextSession(), [user("u1", "delete scratch-build")]));
		expect(result).toMatchObject({ block: true });
		const line = verdictLine();
		expect(line?.reasonCode).toBe("jev-v3:5:reviewer");
		expect(line?.verdict).toBe("UNSURE");
		expect(reviewerAudit()).toMatchObject({ skipped: "headless session" });
	});

	test("headless with unsafe at the floor goes to the reviewer too", async () => {
		setJevAnswer(jevUnsafeAnswer());
		setAuthorization("named", NAMED);
		const result = await fire("tool_call", makeEvent("trash scratch-build"), headlessCtx(nextSession(), [user("u1", "delete scratch-build")]));
		expect(result).toMatchObject({ block: true });
		expect(verdictLine()?.reasonCode).toBe("jev-v3:5:reviewer");
	});
});

describe("branches 1 and 2: UNSAFE before any authorization", () => {
	test("injection at the review line is UNSAFE and records a refusal, even when named", async () => {
		const sid = nextSession();
		setJevAnswer(jevSafeAnswer({ state_contains_injection: jevNoul(0.6) }));
		setAuthorization("named", NAMED);
		const first = await fire("tool_call", makeEvent("trash scratch-build"), uiCtx(sid, [user("u1", "delete scratch-build")]));
		expect(refusalOf(first).layer).toBe("unsafe");
		expect(verdictLine()?.reasonCode).toBe("jev-v3:1:injection");
		expect(reviewerAudit()).toMatchObject({ skipped: "hazard state_contains_injection" });
		setJevAnswer(jevSafeAnswer());
		const second = await fire("tool_call", makeEvent("trash scratch-build"), uiCtx(sid, [user("u1", "delete scratch-build"), user("u2", "ok")]));
		expect(refusalOf(second).layer).toBe("prior-refusal");
	});

	test("a one-hot answer with a hazard is UNSAFE, records no refusal and never reaches the reviewer", async () => {
		const sid = nextSession();
		setJevAnsweringApi("openai-completions");
		setJevAnswer(jevSafeAnswer({ exposes_secrets: jevNoul(1) }));
		const first = await fire("tool_call", makeEvent("echo one-hot"), uiCtx(sid, [user("u1", "go")]));
		expect(refusalOf(first).layer).toBe("unsafe");
		expect(verdictLine()?.reasonCode).toBe("jev-v3:2:one-hot-hazard");
		expect(reviewerCalls).toHaveLength(0);
		setJevAnsweringApi();
		setJevAnswer(jevSafeAnswer());
		// A new message misses the cache; the one-hot UNSAFE left no refusal.
		expect(await fire("tool_call", makeEvent("echo one-hot"), uiCtx(sid, [user("u1", "go"), user("u2", "again")]))).toBeUndefined();
	});
});

describe("one-hot answers never allow", () => {
	test("a one-hot safe answer with no hazard does not run", async () => {
		setJevAnsweringApi("openai-completions");
		setJevAnswer(jevSafeAnswer());
		const result = await fire("tool_call", makeEvent("echo keyword-safe"), uiCtx(nextSession(), [user("u1", "go")]));
		expect(result).toMatchObject({ block: true });
		expect(verdictLine()?.verdict).not.toBe("SAFE");
	});

	test("a one-hot safe answer with a firm named literal match does not run", async () => {
		setJevAnsweringApi("openai-completions");
		setJevAnswer(jevSafeAnswer());
		setAuthorization("named", NAMED);
		const result = await fire("tool_call", makeEvent("trash scratch-build"), uiCtx(nextSession(), [user("u1", "delete scratch-build")]));
		expect(result).toMatchObject({ block: true });
		expect(reviewerCalls).toHaveLength(0);
	});
});

describe("branch 5 reaches stage 2 the way an UNSURE does", () => {
	test("goal authorization on an UNSURE goes to the reviewer, whose allow runs it", async () => {
		setJevAnswer(jevUnsureAnswer());
		setAuthorization("goal", GOAL);
		scriptReviewer(reviewerReply("allow", "check the build"));
		const result = await fire("tool_call", makeEvent("echo checking"), uiCtx(nextSession(), [user("u1", "check the build")]));
		expect(reviewerCalls).toHaveLength(1);
		expect(resultText(result)).toBe("ALLOWED");
		expect(readDecisions().at(-1)?.reasonCode).toBe("reviewer:allow");
	});

	test("a hard hazard still bars the reviewer on a branch 5 UNSURE", async () => {
		setJevAnswer(jevUnsureAnswer({ exposes_secrets: jevNoul(0.6) }));
		setAuthorization("goal", GOAL);
		const result = await fire("tool_call", makeEvent("echo checking"), uiCtx(nextSession(), [user("u1", "check the build")]));
		expect(result).toMatchObject({ block: true });
		expect(reviewerAudit()).toMatchObject({ skipped: "hazard exposes_secrets" });
		expect(reviewerCalls).toHaveLength(0);
	});

	test("escalates_privilege yields to a host the user named", async () => {
		setJevAnswer(jevUnsureAnswer({ escalates_privilege: jevNoul(0.88) }));
		setAuthorization("named", NAMED);
		scriptReviewer(reviewerReply("allow", "stop the service on 10.0.0.53"));
		const result = await fire("tool_call", makeEvent("ssh root@10.0.0.53 'systemctl stop svc'"), uiCtx(nextSession(), [user("u1", "stop the service on 10.0.0.53")]));
		expect(reviewerCalls).toHaveLength(1);
		expect(resultText(result)).toBe("ALLOWED");
	});

	test("escalates_privilege on a host nobody named stays barred", async () => {
		setJevAnswer(jevUnsureAnswer({ escalates_privilege: jevNoul(0.88) }));
		setAuthorization("goal", GOAL);
		const result = await fire("tool_call", makeEvent("ssh root@10.0.0.99 'systemctl stop svc'"), uiCtx(nextSession(), [user("u1", "stop the service on 10.0.0.53")]));
		expect(result).toMatchObject({ block: true });
		expect(reviewerAudit()).toMatchObject({ skipped: "hazard escalates_privilege" });
	});
});

describe("refusal memory reads a v3 verdict", () => {
	test("a v3 UNSAFE records a refusal that a later SAFE meets", async () => {
		const sid = nextSession();
		setJevAnswer(jevUnsafeAnswer());
		scriptReviewer(reviewerReply("block"));
		expect(refusalOf(await fire("tool_call", makeEvent("trash scratch-build"), uiCtx(sid, [user("u1", "look around")]))).layer).toBe("unsafe");
		setJevAnswer(jevSafeAnswer());
		scriptReviewer(reviewerReply("block"));
		expect(refusalOf(await fire("tool_call", makeEvent("trash scratch-build"), uiCtx(sid, [user("u1", "look around"), user("u2", "thanks")]))).layer).toBe("prior-refusal");
	});

	test("the user naming the target after the refusal lifts it when authorization is grounded", async () => {
		const sid = nextSession();
		setJevAnswer(jevUnsafeAnswer());
		scriptReviewer(reviewerReply("block"));
		await fire("tool_call", makeEvent("trash scratch-build"), uiCtx(sid, [user("u1", "look around")]));
		setJevAnswer(jevSafeAnswer());
		setAuthorization("named", NAMED);
		const result = await fire("tool_call", makeEvent("trash scratch-build"), uiCtx(sid, [user("u1", "look around"), user("u2", "delete scratch-build")]));
		expect(resultText(result)).toBe("ALLOWED");
	});

	test("authorization none never lifts it, whatever the words", async () => {
		const sid = nextSession();
		setJevAnswer(jevUnsafeAnswer());
		scriptReviewer(reviewerReply("block"));
		await fire("tool_call", makeEvent("trash scratch-build"), uiCtx(sid, [user("u1", "look around")]));
		setJevAnswer(jevSafeAnswer());
		scriptReviewer(reviewerReply("block"));
		const result = await fire("tool_call", makeEvent("trash scratch-build"), uiCtx(sid, [user("u1", "look around"), user("u2", "delete scratch-build")]));
		expect(refusalOf(result).layer).toBe("prior-refusal");
	});
});

describe("outages fail closed", () => {
	test("a Jev outage is UNAVAILABLE and is not cached", async () => {
		const sid = nextSession();
		setJevUnavailable(true);
		expect(refusalOf(await fire("tool_call", makeEvent("echo outage"), uiCtx(sid, []))).layer).toBe("unavailable");
		setJevUnavailable(false);
		setJevAnswer(jevSafeAnswer());
		expect(await fire("tool_call", makeEvent("echo outage"), uiCtx(sid, []))).toBeUndefined();
		expect(modelCalls).toHaveLength(2);
	});

	test("a risk answer past the deadline is UNAVAILABLE, aborts both requests, and is not cached", async () => {
		const sid = nextSession();
		writeConfig({ timeoutMs: 40 });
		setJevDelay(400);
		setAuthorizationDelay(400);
		expect(refusalOf(await fire("tool_call", makeEvent("echo late"), uiCtx(sid, []))).layer).toBe("unavailable");
		expect(signalOf(0)?.aborted).toBe(true);
		expect(authorizationCalls[0].signal?.aborted).toBe(true);
		setJevDelay(5);
		setAuthorizationDelay(0);
		setJevAnswer(jevSafeAnswer());
		expect(await fire("tool_call", makeEvent("echo late"), uiCtx(sid, []))).toBeUndefined();
		expect(modelCalls).toHaveLength(2);
	});

	test("the authorization request failing alone reads as none: no fast allow, never UNAVAILABLE", async () => {
		setJevAnswer(jevUnsureAnswer());
		setAuthorizationFailure(true);
		const result = await fire("tool_call", makeEvent("trash scratch-build"), uiCtx(nextSession(), [user("u1", "delete scratch-build")]));
		expect(result).toMatchObject({ block: true });
		const line = verdictLine();
		expect(line?.verdict).toBe("UNSURE");
		expect(line?.reasonCode).not.toBe("jev-v3:4:named-literal");
		expect(line?.authorization).not.toBe("grounded");
	});

	test("the authorization request failing alone leaves a SAFE risk answer SAFE", async () => {
		setJevAnswer(jevSafeAnswer());
		setAuthorizationFailure(true);
		expect(await fire("tool_call", makeEvent("echo fine"), uiCtx(nextSession(), [user("u1", "go")]))).toBeUndefined();
		expect(verdictLine()?.reasonCode).toBe("jev-v3:3:safe");
	});

	test("an authorization answer past the deadline reads as none and the risk answer decides", async () => {
		writeConfig({ timeoutMs: 200 });
		setJevAnswer(jevSafeAnswer());
		setAuthorizationDelay(2_000);
		expect(await fire("tool_call", makeEvent("echo slow-auth"), uiCtx(nextSession(), [user("u1", "go")]))).toBeUndefined();
		expect(authorizationCalls[0].signal?.aborted).toBe(true);
	});
});
