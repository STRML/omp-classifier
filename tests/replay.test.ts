import { describe, expect, test } from "bun:test";
import { annotateJudgement, replayDecision } from "../index";

describe("shared replay decision pipeline", () => {
	test("missing model is unavailable, never an allow", () => {
		expect(replayDecision({ tool: "bash", command: "git status", cwd: "/repo", headless: true })).toMatchObject({
			decision: "block",
			layer: "unclassified",
			hostHandoff: "headless-block",
		});
	});

	test("a safe read reaches the host as a run", () => {
		const judgement = annotateJudgement({ verdict: "SAFE", reason: "read-only inspection" });
		expect(replayDecision({ tool: "bash", command: "git status", cwd: "/repo", judgement })).toMatchObject({
			decision: "allow",
			layer: "verdict",
			hostHandoff: "run",
		});
	});

	test("risk overlays remain a permission outcome even after SAFE", () => {
		const judgement = annotateJudgement({ verdict: "SAFE", reason: "routine" });
		expect(replayDecision({ tool: "bash", command: "rm -rf ./build", cwd: "/repo", judgement, riskFlags: ["rm"] })).toMatchObject({
			decision: "block",
			layer: "verdict",
			hostHandoff: "permission",
		});
	});

	test("a prior refusal blocks a changed syntax in the same scope", () => {
		const judgement = annotateJudgement({ verdict: "SAFE", reason: "looks routine" });
		expect(replayDecision({ tool: "bash", command: "git diff --name-only", cwd: "/repo", judgement, priorRefusal: true, headless: true })).toMatchObject({
			decision: "block",
			layer: "verdict",
			hostHandoff: "headless-block",
		});
	});

	test("a scoped grant runs before model replay, but below critical overlays", () => {
		const judgement = annotateJudgement({ verdict: "UNSAFE", reason: "remote write" });
		expect(replayDecision({ tool: "bash", command: "git push", cwd: "/repo", judgement, grant: "session" })).toMatchObject({
			decision: "allow",
			layer: "granted",
		});
		expect(replayDecision({ tool: "bash", command: "rm -rf /", cwd: "/repo", judgement, grant: "session", riskFlags: ["critical"], headless: true })).toMatchObject({
			decision: "block",
			layer: "critical",
		});
	});

	test("an interactive approval is an explicit final override; headless cannot invent one", () => {
		const judgement = annotateJudgement({ verdict: "UNSURE", reason: "ambiguous" });
		expect(replayDecision({ tool: "bash", command: "git push", cwd: "/repo", judgement, approval: "allow-once" })).toMatchObject({
			decision: "allow",
			layer: "approval",
			hostHandoff: "run",
		});
		expect(replayDecision({ tool: "bash", command: "git push", cwd: "/repo", judgement, approval: "allow-once", headless: true })).toMatchObject({
			decision: "block",
			hostHandoff: "headless-block",
		});
	});

	test("replay preserves host precedence and static-rule handoff", () => {
		expect(replayDecision({ tool: "bash", command: "rm -rf /", cwd: "/repo", staticRule: "deny", riskFlags: ["critical"], headless: false })).toMatchObject({
			decision: "block",
			layer: "rule",
			hostHandoff: "headless-block",
		});
		expect(replayDecision({ tool: "bash", command: "rm -rf /", cwd: "/repo", envKeys: ["PATH"], riskFlags: ["critical"], headless: false })).toMatchObject({
			decision: "block",
			layer: "critical",
			hostHandoff: "permission",
		});
		expect(replayDecision({ tool: "bash", command: "git status", cwd: "/repo", staticRule: "prompt" })).toMatchObject({
			decision: "block",
			layer: "rule",
			hostHandoff: "permission",
		});
	});
});
