import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import {
	answerCacheKey,
	caseState,
	parseJsonl,
	type Case,
	validateCase,
} from "../eval/run";

const validTiers = {
	gitPushProvenance: { remoteTip: "abc", localTip: "def", ahead: 1, behind: 0, forwardOnly: true },
	gitWorktreeProvenance: {
		workspaceRoot: "/repo/work",
		linkedWorktree: true,
		mainCheckoutRoot: "/repo",
		siblingWorktreeRoots: ["/repo/other"],
		worktreeCount: 3,
	},
	gitRefProvenance: [{ kind: "branch-delete", target: "topic", containedIn: ["refs/heads/main"], mergedIntoHead: true }],
	networkProvenance: { localPorts: [3000], knownHosts: [], dockerNetworks: [] },
	deleteTargets: [
		{ target: "/tmp/a", underTempRoot: true },
		{ target: "src/index.ts", underTempRoot: false },
		{ target: "$TMPDIR/b", underTempRoot: null },
	],
} satisfies NonNullable<Case["provenance"]>;

const baseCase = (overrides: Partial<Case> = {}): Case => ({
	command: "git status --short",
	label: "allow",
	family: "provenance-test",
	...overrides,
});

describe("eval provenance", () => {
	test("validateCase accepts each production provenance tier", () => {
		for (const [key, value] of Object.entries(validTiers)) {
			expect(() => validateCase(baseCase({ provenance: { [key]: value } as Case["provenance"] }))).not.toThrow();
		}
	});

	test("validateCase rejects unknown keys and malformed tier values", () => {
		expect(() => validateCase(baseCase({ provenance: { gitPushProvenance: validTiers.gitPushProvenance, unknown: true } as never }))).toThrow(/provenance.*unknown/i);
		expect(() => validateCase(baseCase({ provenance: { gitPushProvenance: { behind: "zero" } } as never }))).toThrow(/provenance\.gitPushProvenance/);
		expect(() => validateCase(baseCase({ provenance: { deleteTargets: [{ target: "/tmp/a", underTempRoot: "yes" }] } as never }))).toThrow(/provenance\.deleteTargets/);
		expect(() => validateCase(baseCase({ provenance: { deleteTargets: [{ target: "/tmp/a" }] } as never }))).toThrow(/provenance\.deleteTargets/);
		expect(() => validateCase(baseCase({ provenance: { deleteTargets: [{ target: "/tmp/a", underTempRoot: true, extra: 1 }] } as never }))).toThrow(/provenance\.deleteTargets/);
	});

	test("caseState forwards each present tier to buildJevState", () => {
		const state = caseState(baseCase({ provenance: validTiers }), "/repo") as Record<string, unknown>;
		expect(state.gitPushProvenance).toMatchObject(validTiers.gitPushProvenance);
		expect(state.gitWorktreeProvenance).toMatchObject(validTiers.gitWorktreeProvenance);
		expect(state.gitRefProvenance).toMatchObject(validTiers.gitRefProvenance);
		expect(state.networkProvenance).toMatchObject(validTiers.networkProvenance);
		expect(state.deleteTargets).toMatchObject(validTiers.deleteTargets);
	});

	test("answerCacheKey changes when only provenance changes", () => {
		const common = { battery: "battery", model: "model", cwd: "/repo", sample: 0 };
		expect(answerCacheKey({ ...common, testCase: baseCase() })).not.toBe(
			answerCacheKey({ ...common, testCase: baseCase({ provenance: { gitRefProvenance: validTiers.gitRefProvenance } }) }),
		);
	});

	test("every allow row with provenance has an ask twin with the same command", async () => {
		const rows = await parseJsonl<Case>(join(process.cwd(), "eval/corpus/gitflow.jsonl"));
		for (const row of rows.filter(candidate => candidate.provenance !== undefined && candidate.label === "allow")) {
				expect(
					rows.some(twin => twin.label === "ask" && twin.command === row.command && twin.provenance !== undefined && JSON.stringify(twin.provenance) !== JSON.stringify(row.provenance) && twin.note !== row.note),
				`missing ask twin for ${row.command}`,
			).toBe(true);
		}
	});
});
