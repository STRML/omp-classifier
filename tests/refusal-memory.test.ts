/**
 * Refusal memory across rewording (issue #30): a command this session refused
 * — an UNSAFE verdict, a human denial, a critical pattern, a cap — is
 * remembered by normalized target, injected into the next state as
 * priorRefusal, and a SAFE that lands anyway on a refused target still prompts.
 * A user approval lifts the memory; the store holds 20 targets per session,
 * oldest dropped.
 *
 * The trigger moved with the port: a text judge's refusal-shaped prose no
 * longer exists, so memory keys off the VERDICT. UNSAFE is the only verdict
 * that both judged the content and said no — UNSURE is undecided, and
 * UNAVAILABLE judged nothing at all, so neither is evidence about the command.
 * A human denial of an undecided command is still a refusal, and the dialog
 * path records that itself.
 *
 * Unique sessions per test — the module-level refusal store outlives a test.
 */
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { normalizeRefusalTarget } from "../index";
import type { DecisionRecord } from "../index";
import {
	selectCalls,
	ALLOW_ONCE,
	DENY,
	fire,
	jevSafeAnswer,
	jevUnsureAnswer,
	jevUnsafeAnswer,
	loadPlugin,
	makeCtx,
	makeEvent,
	makeSettings,
	modelCalls,
	refusalOf,
	setJevAnswer,
	setJevAnsweringApi,
	stateOf,
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
	process.env.OMP_JEV_CONFIG = path.join(dir, "omp-classifier.json");
	await loadPlugin(makeSettings([]));
	setJevAnswer(jevSafeAnswer());
});

afterEach(() => {
	fs.rmSync(dir, { recursive: true, force: true });
});

/** Fresh session id per test; the plugin's stores are module-level. */
const nextSession = (): string => `refusal-memory-${(seq += 1)}`;

/** The prior-refusal field of one captured request's state, if it carried one. */
const priorRefusalOf = (callIndex: number): { target: string; why: string; when: string } | undefined =>
	stateOf(callIndex).priorRefusal as { target: string; why: string; when: string } | undefined;

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

describe("refusal memory", () => {
	test("reworded command carries priorRefusal into the state", async () => {
		const sid = nextSession();
		setJevAnswer(jevUnsafeAnswer());
		await fire("tool_call", makeEvent("rm -rf x"), makeCtx({ sessionId: sid }));
		expect(modelCalls.length).toBe(1);
		setJevAnswer(jevUnsafeAnswer());
		await fire("tool_call", makeEvent("rm -rf ./x"), makeCtx({ sessionId: sid }));
		expect(modelCalls.length).toBe(2);
		const prior = priorRefusalOf(1);
		expect(prior?.target).toBe("rm x");
		// The stored why is the refusal's machine reason, not model prose: with
		// no text reply there is nothing else it could be.
		expect(prior?.why).toContain("unsafe 0.96");
		expect(new Date(prior?.when ?? "").getTime()).toBeGreaterThan(0);
		// The first, unrefused classification carries no such field.
		expect(priorRefusalOf(0)).toBeUndefined();
	});

	test("a one-hot UNSAFE asks but is not remembered as a refusal (jev-v2.1)", async () => {
		// The keyword bridge answers 0/1 with no distribution behind it. Its
		// UNSAFE still asks; it must not pin the target for the session.
		const sid = nextSession();
		setJevAnsweringApi("chat");
		setJevAnswer(jevUnsafeAnswer());
		await fire("tool_call", makeEvent("rm -rf x"), makeCtx({ sessionId: sid }));
		setJevAnsweringApi();
		setJevAnswer(jevUnsafeAnswer());
		await fire("tool_call", makeEvent("rm -rf ./x"), makeCtx({ sessionId: sid }));
		expect(modelCalls.length).toBe(2);
		expect(priorRefusalOf(1)).toBeUndefined();
	});

	test("an UNSURE verdict is undecided, so it is not remembered as a refusal", async () => {
		// An undecided judgement is not evidence about the command. If it were
		// remembered, a single ambiguous verdict would pin every rewording of
		// that target to a dialog for the rest of the session.
		const sid = nextSession();
		setJevAnswer(jevUnsureAnswer());
		await fire("tool_call", makeEvent("git diff --stat"), makeCtx({ sessionId: sid }));
		setJevAnswer(jevSafeAnswer());
		await fire("tool_call", makeEvent("git diff --name-only"), makeCtx({ sessionId: sid }));
		expect(priorRefusalOf(1)).toBeUndefined();
	});

	test("an UNAVAILABLE verdict judged nothing, so it is not remembered either", async () => {
		const sid = nextSession();
		setJevAnswer(jevUnsureAnswer());
		await fire("tool_call", makeEvent("git diff --stat"), makeCtx({ sessionId: sid }));
		setJevAnswer(jevSafeAnswer());
		const ctx = makeCtx({ sessionId: sid });
		expect(await fire("tool_call", makeEvent("git diff --name-only"), ctx)).toBeUndefined();
		expect(priorRefusalOf(1)).toBeUndefined();
	});

	test("a SAFE that lands despite a prior refusal still prompts", async () => {
		const sid = nextSession();
		const ctx = makeCtx({ sessionId: sid, hasUI: true, selectResult: DENY });
		setJevAnswer(jevUnsafeAnswer());
		await fire("tool_call", makeEvent("echo bye"), ctx);
		// echo is not a moderate-risk token, so without the refusal memory a
		// SAFE here would auto-run; the dialog proves the refusal decided.
		setJevAnswer(jevSafeAnswer());
		const result = await fire("tool_call", makeEvent("echo bye again"), ctx);
		expect(selectCalls(ctx).length).toBe(2);
		const payload = JSON.parse((result as { block: true; reason: string }).reason) as { layer: string };
		expect(payload.layer).toBe("dialog");
		expect(readDecisions().some(line => line.why.startsWith("despite prior refusal"))).toBe(true);
	});

	test("machine refusals are scoped to the reviewed directory", async () => {
		const sid = nextSession();
		setJevAnswer(jevUnsafeAnswer());
		await fire("tool_call", makeEvent("git diff --stat"), makeCtx({ sessionId: sid, cwd: "/workspace" }));

		setJevAnswer(jevSafeAnswer());
		const elsewhere = makeCtx({ sessionId: sid, cwd: "/elsewhere" });
		const result = await fire("tool_call", makeEvent("git diff --name-only"), elsewhere);
		expect(result).toBeUndefined();
		expect(selectCalls(elsewhere)).toHaveLength(0);
		expect(modelCalls.length).toBe(2);
	});

	test("approval in one directory does not erase a refusal in another", async () => {
		const sid = nextSession();
		setJevAnswer(jevUnsafeAnswer());
		await fire("tool_call", makeEvent("git diff --stat"), makeCtx({ sessionId: sid, cwd: "/workspace" }));

		const elsewhereDenied = makeCtx({ sessionId: sid, cwd: "/elsewhere", hasUI: true, selectResult: DENY });
		await fire("tool_call", makeEvent("git diff --stat"), elsewhereDenied);
		setJevAnswer(jevSafeAnswer());
		const elsewhere = makeCtx({ sessionId: sid, cwd: "/elsewhere", hasUI: true, selectResult: ALLOW_ONCE });
		expect(await fire("tool_call", makeEvent("git diff --name-only"), elsewhere)).toBeUndefined();

		const original = makeCtx({ sessionId: sid, cwd: "/workspace", hasUI: true });
		const result = await fire("tool_call", makeEvent("git diff --name-only"), original);
		expect(refusalOf(result).layer).toBe("dialog");
	});

	test("user approval lifts the refusal for the target", async () => {
		const sid = nextSession();
		setJevAnswer(jevUnsafeAnswer());
		await fire("tool_call", makeEvent("rm -rf x"), makeCtx({ sessionId: sid, hasUI: true }));
		setJevAnswer(jevSafeAnswer());
		const approved = await fire(
			"tool_call",
			makeEvent("rm -rf ./x"),
			makeCtx({ sessionId: sid, hasUI: true, selectResult: ALLOW_ONCE }),
		);
		expect(approved).toBeUndefined();
		await fire("tool_call", makeEvent("rm -r x"), makeCtx({ sessionId: sid, hasUI: true, selectResult: ALLOW_ONCE }));
		expect(modelCalls.length).toBe(3);
		expect(priorRefusalOf(2)).toBeUndefined();
	});

	test("store caps at 20 per session and drops the oldest", async () => {
		const sid = nextSession();
		setJevAnswer(jevUnsafeAnswer());
		for (let i = 1; i <= 21; i++) {
			await fire(
				"tool_call",
				makeEvent(`rm -rf f${String(i).padStart(2, "0")}`),
				makeCtx({ sessionId: sid }),
			);
		}
		setJevAnswer(jevUnsafeAnswer());
		// Oldest target (rm f01) was evicted: its rewording classifies bare.
		await fire("tool_call", makeEvent("rm -f f01"), makeCtx({ sessionId: sid }));
		expect(priorRefusalOf(21)).toBeUndefined();
		// Newest target (rm f21) is still remembered.
		await fire("tool_call", makeEvent("rm -f f21"), makeCtx({ sessionId: sid }));
		const prior = priorRefusalOf(22);
		expect(prior?.target).toBe("rm f21");
	});
});
