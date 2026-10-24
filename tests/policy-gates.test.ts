/**
 * The decision boundaries at the plugin level: what the gate does with the
 * numbers, as opposed to tests/jev.test.ts's unit table over
 * deriveJevDecision. What matters here is the wiring the plugin owns — the
 * configured policy actually reaching the derivation, a judgement that fails a
 * floor never becoming a silent run, the hazard split deciding what may gate,
 * and the policy being part of the cache's trust state.
 *
 * The battery asked is pinned here too, from the request side: the fixture
 * answers are keyed by exactly these ids, so a battery change must show up as
 * an edited expectation rather than a silently mismatched stub.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
	fire,
	JEV_FIXTURE_HAZARDS,
	jevHazardousAnswer,
	jevNoul,
	jevSafeAnswer,
	jevWeakSafeAnswer,
	loadPlugin,
	makeCtx,
	makeEvent,
	makeSettings,
	modelCalls,
	questionsOf,
	refusalOf,
	removeConfigFile,
	resultText,
	setJevAnswer,
	setJevUnavailable,
	writeConfigFile,
} from "./fixtures";

beforeEach(async () => {
	removeConfigFile();
	await loadPlugin(makeSettings([]));
	setJevAnswer(jevSafeAnswer());
});
// Producer-side cleanup (issue #107): this file writes the config file, so it
// removes it after itself instead of relying on the next consumer's reset.
afterEach(removeConfigFile);

let seq = 0;
/** Fresh session per test; the gate's cache is module-level and per-session. */
const nextSession = (): string => `policy-${(seq += 1)}`;

const gate = async (command: string, opts: Parameters<typeof makeCtx>[0] = {}): Promise<string> =>
	resultText(await fire("tool_call", makeEvent(command), makeCtx({ sessionId: nextSession(), ...opts })));

describe("the floor that lets a safe answer run", () => {
	test("p(safe) and confidence above both floors auto-run, and the verdict is cached", async () => {
		const session = nextSession();
		const command = `echo policy-safe-${seq}`;
		const first = makeCtx({ sessionId: session, hasUI: true });
		expect(await fire("tool_call", makeEvent(command), first)).toBeUndefined();
		expect(modelCalls).toHaveLength(1);

		const repeat = makeCtx({ sessionId: session, hasUI: true });
		expect(await fire("tool_call", makeEvent(command), repeat)).toBeUndefined();
		expect(modelCalls).toHaveLength(1); // the cached verdict answered, silently
	});

	test("a safe answer below the confidence floor blocks instead", async () => {
		// The live measured shape this floor exists for: Jev said "safe" while
		// unsafe held .43, and the argmax alone would have auto-run it.
		setJevAnswer(jevWeakSafeAnswer());
		const ctx = makeCtx({ sessionId: nextSession(), hasUI: true });
		const payload = refusalOf(await fire("tool_call", makeEvent("git branch -D policy-weak"), ctx));
		expect(payload.layer).toBe("unsure");
		// The block must say which floor failed, or the agent cannot tell a
		// weak answer from an ambiguous one.
		expect(payload.why).toContain("below floor");
	});

	test("a below-floor answer never becomes a silent run on a repeat", async () => {
		setJevAnswer(jevWeakSafeAnswer());
		const session = nextSession();
		const command = "git branch -D policy-repeat";
		const first = makeCtx({ sessionId: session, hasUI: true });
		expect(refusalOf(await fire("tool_call", makeEvent(command), first)).layer).toBe("unsure");

		// Whatever the cache holds, it may never hold an allow: the second call
		// blocks again.
		const second = makeCtx({ sessionId: session, hasUI: true });
		const result = await fire("tool_call", makeEvent(command), second);
		expect(refusalOf(result).layer).toBe("unsure");
	});

	test("headless, the same below-floor answer blocks", async () => {
		setJevAnswer(jevWeakSafeAnswer());
		const result = await gate("git branch -D policy-headless");
		expect(result).toContain("classifier unsure");
		expect(refusalOf(result).layer).toBe("unsure");
	});
});

describe("the configured jevPolicy is the policy that decides", () => {
	test("raising safeMinProbability turns an auto-running answer into a block", async () => {
		expect(await gate("git status")).toBe("ALLOWED"); // default floors: .95 clears .80
		writeConfigFile({ jevPolicy: { safeMinProbability: 0.99 } });
		const ctx = makeCtx({ sessionId: nextSession(), hasUI: true });
		setJevAnswer(jevSafeAnswer()); // same answer, stricter policy
		expect(resultText(await fire("tool_call", makeEvent("git status"), ctx))).not.toBe("ALLOWED");
	});

	test("lowering hazardBlock lets a hazard the default tolerates gate the command", async () => {
		// .60 is a review-level hazard under the default (block .90), but the
		// point here is that the THRESHOLD is configurable: at .55 it is UNSAFE.
		setJevAnswer(jevHazardousAnswer("exposes_secrets", 0.6));
		writeConfigFile({ jevPolicy: { hazardBlock: 0.55 } });
		const result = await gate("cat ~/.ssh/id_rsa");
		expect(result).toContain("classified unsafe");
		expect(refusalOf(result).layer).toBe("unsafe");
	});

	test("changing jevPolicy invalidates cached verdicts", async () => {
		const session = nextSession();
		const command = "git status";
		await fire("tool_call", makeEvent(command), makeCtx({ sessionId: session }));
		await fire("tool_call", makeEvent(command), makeCtx({ sessionId: session }));
		expect(modelCalls).toHaveLength(1); // cached by the second call

		// The policy is part of the trust state a verdict was made under: a SAFE
		// decided at .80 may not survive a floor of .99.
		writeConfigFile({ jevPolicy: { safeMinProbability: 0.99 } });
		const after = makeCtx({ sessionId: session, hasUI: true });
		const blocked = await fire("tool_call", makeEvent(command), after);
		expect(modelCalls).toHaveLength(2);
		expect(resultText(blocked)).not.toBe("ALLOWED"); // and the new floor is honored
	});
});

describe("gating and descriptive hazards", () => {
	test("a gating hazard at or above hazardBlock is UNSAFE", async () => {
		setJevAnswer(jevHazardousAnswer("exposes_secrets", 0.97));
		const result = await gate("cat ~/.ssh/id_rsa");
		expect(result).toContain("classified unsafe");
		expect(refusalOf(result).layer).toBe("unsafe");
	});

	test("the hazard that decided is named for the agent", async () => {
		// Jev writes no prose, so the reason is assembled from the answer. It
		// has to reach the refusal: "unsafe" with no hazard named would leave
		// the agent nothing to tell the user.
		setJevAnswer(jevHazardousAnswer("exposes_secrets", 0.97));
		const ctx = makeCtx({ sessionId: nextSession(), hasUI: true });
		const payload = refusalOf(await fire("tool_call", makeEvent("cat ~/.ssh/id_rsa"), ctx));
		expect(payload.why).toContain("exposes_secrets");
		expect(payload.why).toContain("0.97");
	});

	test("a gating hazard between the review and block floors blocks, never auto-runs", async () => {
		setJevAnswer(jevHazardousAnswer("destructive_or_irreversible", 0.7));
		const ctx = makeCtx({ sessionId: nextSession(), hasUI: true });
		const payload = refusalOf(await fire("tool_call", makeEvent("git reset --hard HEAD~1"), ctx));
		expect(payload.layer).toBe("unsure");
		expect(payload.why).toContain("destructive_or_irreversible");
	});

	test("a descriptive hazard above both floors never decides anything", async () => {
		// The split's whole point: these are reported for context (the reason,
		// the audit line, the dialog body) but a rule that let them gate would
		// re-prompt every networked read and every push.
		setJevAnswer(
			jevSafeAnswer({
				writes_outside_working_directory: jevNoul(0.99),
				affects_shared_or_remote_state: jevNoul(0.99),
				contacts_remote_endpoint: jevNoul(0.99),
			}),
		);
		expect(await gate("git push origin main")).toBe("ALLOWED");
	});
});

describe("UNAVAILABLE", () => {
	test("never runs the command", async () => {
		setJevUnavailable();
		const headless = await gate("git status");
		expect(refusalOf(headless).layer).toBe("unavailable");
		expect(headless).toContain("classifier unavailable");

		// With a UI it blocks the same way: nobody is asked.
		const ctx = makeCtx({ sessionId: nextSession(), hasUI: true });
		const asked = await fire("tool_call", makeEvent("git status"), ctx);
		expect(refusalOf(asked).layer).toBe("unavailable");
	});
});

describe("the battery", () => {
	test("asks the frozen question set, one question per hazard", async () => {
		await gate("git status");
		const questions = questionsOf(0);
		const expected = ["verdict", ...JEV_FIXTURE_HAZARDS, "blast_radius"];
		expect(Object.keys(questions).sort()).toEqual([...expected].sort());
		expect((questions.verdict as { type?: string }).type).toBe("choice");
		expect((questions.blast_radius as { type?: string }).type).toBe("score");
		for (const hazard of JEV_FIXTURE_HAZARDS) {
			expect((questions[hazard] as { type?: string }).type).toBe("noul");
		}
	});
});
