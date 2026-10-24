import { describe, expect, test } from "bun:test";
import { annotateJudgement, replayDecision } from "../index";

describe("shared replay decision pipeline", () => {
	test("missing model is unavailable, never an allow", () => {
		expect(replayDecision({ tool: "bash", command: "git status", cwd: "/repo" })).toMatchObject({
			decision: "block",
			layer: "unclassified",
			hostHandoff: "block",
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

	test("risk overlays block even after SAFE", () => {
		const judgement = annotateJudgement({ verdict: "SAFE", reason: "routine" });
		expect(replayDecision({ tool: "bash", command: "rm -rf ./build", cwd: "/repo", judgement, riskFlags: ["rm"] })).toMatchObject({
			decision: "block",
			layer: "verdict",
			hostHandoff: "block",
		});
	});

	test("a prior refusal the verdict did not lift blocks a changed syntax in the same scope", () => {
		const judgement = annotateJudgement({ verdict: "SAFE", reason: "looks routine" });
		expect(replayDecision({ tool: "bash", command: "git diff --name-only", cwd: "/repo", judgement, priorRefusal: true })).toMatchObject({
			decision: "block",
			layer: "verdict",
			hostHandoff: "block",
		});
	});

	test("UNSURE and UNSAFE block, with no approval to override them", () => {
		for (const verdict of ["UNSURE", "UNSAFE"] as const) {
			const judgement = annotateJudgement({ verdict, reason: "ambiguous" });
			expect(replayDecision({ tool: "bash", command: "git push", cwd: "/repo", judgement })).toMatchObject({
				decision: "block",
				layer: "verdict",
				hostHandoff: "block",
			});
		}
	});

	test("replay preserves host precedence and static-rule handoff", () => {
		expect(replayDecision({ tool: "bash", command: "rm -rf /", cwd: "/repo", staticRule: "deny", riskFlags: ["critical"] })).toMatchObject({
			decision: "block",
			layer: "rule",
			hostHandoff: "block",
		});
		expect(replayDecision({ tool: "bash", command: "rm -rf /", cwd: "/repo", envKeys: ["PATH"], riskFlags: ["critical"] })).toMatchObject({
			decision: "block",
			layer: "critical",
			hostHandoff: "block",
		});
		// A host prompt rule is the host's own dialog, not the gate's.
		expect(replayDecision({ tool: "bash", command: "git status", cwd: "/repo", staticRule: "prompt" })).toMatchObject({
			decision: "block",
			layer: "rule",
			hostHandoff: "host-prompt",
		});
	});
});
