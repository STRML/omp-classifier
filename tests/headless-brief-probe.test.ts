/**
 * The spec step 1 probe's pure parts: the states each arm sends, and the
 * decision rule that picks (a) or (b). The live run is not a test: it needs a
 * TypeSafe credential and the network.
 */
import { describe, expect, test } from "bun:test";
import { chooseHeadlessArm, LAUNCH_PROMPT_LABEL, launchPromptOperatorContext, reviewBrief, stateFor } from "../eval/headless-brief-probe";

const BRIEF = reviewBrief({ repo: "/Users/you/git/oss/project", branch: "feat/example", head: "0123456789abcdef0123456789abcdef01234567", base: "main", round: 1, max: 3 });
const evidence = (state: unknown): Record<string, unknown> => ((state as { evidence?: Record<string, unknown> }).evidence ?? {});

describe("the probe's arms", () => {
	test("the brief mirrors the review script, including its words about this classifier", () => {
		expect(BRIEF).toContain("Adversarial review, round 1 of 3, of branch feat/example");
		expect(BRIEF).toContain("the headless classifier blocks it");
		expect(BRIEF).toContain("REVIEW-GATE-RESULT");
	});

	test("user carries the brief as the user's words; omitted carries nothing; operator carries it labelled", () => {
		const command = "git -C /Users/you/git/oss/project diff main...HEAD";
		expect(evidence(stateFor("user", command, BRIEF)).userMessages).toEqual([BRIEF]);
		expect(evidence(stateFor("omitted", command, BRIEF))).toEqual({});
		const operator = evidence(stateFor("operator", command, BRIEF));
		expect(operator.userMessages).toBeUndefined();
		expect(String(operator.operatorContext).startsWith(LAUNCH_PROMPT_LABEL)).toBe(true);
	});

	test("the operator context is capped and redacted", () => {
		const long = `token sk-ant-api03-abcdefghijklmnopqrstuvwxyz0123456789 ${"x".repeat(5_000)}`;
		const context = launchPromptOperatorContext(long);
		expect(context).not.toContain("sk-ant-api03");
		expect(context.length).toBeLessThanOrEqual(LAUNCH_PROMPT_LABEL.length + 1 + 2_000 + 3);
	});
});

describe("chooseHeadlessArm", () => {
	test("(b) when the operator arm is as clean as omitting the brief", () => {
		expect(chooseHeadlessArm({ user: 0.6, omitted: 0, operator: 0.05 })).toBe("b");
	});
	test("(a) when carrying the brief as operator context does not help", () => {
		expect(chooseHeadlessArm({ user: 0.6, omitted: 0, operator: 0.4 })).toBe("a");
	});
	test("unconfirmed when the brief does not raise the hazard, or omitting it does not lower it", () => {
		expect(chooseHeadlessArm({ user: 0, omitted: 0, operator: 0 })).toBe("unconfirmed");
		expect(chooseHeadlessArm({ user: 0.6, omitted: 0.3, operator: 0.3 })).toBe("unconfirmed");
	});
	test("an arm with no answers cannot be selected", () => {
		expect(chooseHeadlessArm({ user: Number.NaN, omitted: 0, operator: 0 })).toBe("unconfirmed");
	});
});
