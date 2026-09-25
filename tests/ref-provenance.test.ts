/**
 * Gate-measured ref state (#69 slice D): what `gitRefProvenance` measures for a
 * branch delete, a path restore, and a rebase, and what the criteria do with it.
 * Same discipline as #63's push tier and slice C's geometry: read from git at
 * classification time, never asserted by the party being judged, and absent
 * rather than guessed when the gate cannot measure it.
 *
 * The pairs that have to be measurably different are the point of the slice: a
 * delete of a merged branch versus one nothing else points at, and a path
 * restore on a clean tree versus a dirty one.
 */
import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync } from "node:fs";
import { JEV_POLICY_VERSION, JEV_V3_POLICY_VERSION, jevQuestions, measureGitRefProvenance, type GitRefProvenance, type JevBatteryVersion } from "../jev";
import { fire, jevSafeAnswer, loadPlugin, makeCtx, makeEvent, makeSettings, modelCalls, removeConfigFile, setJevAnswer, stateOf } from "./fixtures";
import { gitIn, makeWorktreeFixture, removeFixture } from "./git-fixture";

beforeEach(async () => {
	removeConfigFile();
	await loadPlugin(makeSettings([]));
	setJevAnswer(jevSafeAnswer());
});

const measured = (command: string, cwd: string): GitRefProvenance => {
	const value = measureGitRefProvenance(command, cwd);
	if (value === undefined) throw new Error(`expected measured ref state for ${command}`);
	return value;
};

/** One fixture for the read-only tests; the mutating ones build their own, so a
 *  failure cannot leave a dirty tree behind for the next test. */
const fixture = makeWorktreeFixture();
const outside: string = `${fixture.root}/not-a-repo`;
mkdirSync(outside, { recursive: true });

afterAll(() => {
	removeFixture(fixture.root);
});

describe("the measured ref state", () => {
	test("only the three shapes carry a field, and the ambiguous spellings carry none", () => {
		for (const command of [
			"git status",
			"echo hi",
			"git push origin main",
			"git branch",
			// Two targets: measuring the first would answer a question the command
			// did not ask.
			"git branch -D old scratch",
			// A different base for the same verb: ahead/behind against the wrong ref
			// is worse than nothing.
			"git rebase --onto main live",
			// Not a path restore: these touch no tracked working-tree content.
			"git checkout -b feature",
			"git checkout main",
			// Resuming a rebase is not starting one.
			"git rebase --continue",
			"git rebase --abort",
		]) {
			expect(measureGitRefProvenance(command, fixture.main)).toBeUndefined();
		}
	});

	test("a delete of a merged branch is measurably different from one nothing else holds", () => {
		const merged = measured("git branch -D old", fixture.main);
		expect(merged.kind).toBe("branch-delete");
		expect(merged.target).toBe("old");
		// `old` stops at the base commit: main, the worktree branches, and the
		// pushed origin/main all still hold it, so the delete orphans nothing.
		expect(merged.containedIn).toContain("refs/heads/main");
		expect(merged.containedIn).toContain("refs/remotes/origin/main");
		expect(merged.containedIn).not.toContain("refs/heads/old");
		expect(merged.mergedIntoHead).toBe(true);

		const unmerged = measured("git branch -D scratch", fixture.main);
		// The branch is the only reference to its commit: an empty list, not a
		// missing field, which is the difference the criteria read.
		expect(unmerged.containedIn).toEqual([]);
		expect(unmerged.mergedIntoHead).toBe(false);
	});

	test("a path restore on a clean tree is measurably different from one on a dirty tree", () => {
		const own = makeWorktreeFixture();
		try {
			const clean = measured("git checkout -- .", own.main);
			expect(clean.kind).toBe("checkout-paths");
			expect(clean.target).toBe(".");
			expect(clean.unstagedChanges).toBe(false);
			expect(clean.stashCount).toBe(0);

			// The only copy of this edit is the working tree the restore would reset.
			gitIn(own.main, "echo dirty >> notes.txt");
			expect(measured("git checkout -- .", own.main).unstagedChanges).toBe(true);

			// A stash is another snapshot, not a copy of what the restore discards:
			// the tree is clean again after it, and the count moves.
			gitIn(own.main, "git stash push -q -m probe");
			const stashed = measured("git checkout -- .", own.main);
			expect(stashed.unstagedChanges).toBe(false);
			expect(stashed.stashCount).toBe(1);
		} finally {
			removeFixture(own.root);
		}
	});

	test("a rebase carries the counts against the ref it names", () => {
		// main and origin/main diverged: one commit each way.
		const diverged = measured("git rebase origin/main", fixture.main);
		expect(diverged.kind).toBe("rebase");
		expect(diverged.target).toBe("origin/main");
		expect(diverged.behind).toBe(1);
		expect(diverged.ahead).toBe(1);
		// A target HEAD already contains: behind 0, so the rebase brings in nothing.
		const contained = measured("git rebase old", fixture.main);
		expect(contained.behind).toBe(0);
		expect(contained.ahead).toBe(2);
		// No ref named: git would use the configured upstream, which is measurable.
		expect(measured("git rebase", fixture.feat).target).toBe("@{upstream}");
	});

	test("a recognized shape in a directory that is not a repository measures null, never a guess", () => {
		// Same contract as the push tier: the shape was read, the refs were not,
		// and an empty `containedIn` here would be a claim nobody made.
		const nowhere = measured("git branch -D some-branch", outside);
		expect(nowhere.containedIn).toBeNull();
		expect(nowhere.mergedIntoHead).toBeNull();
		const mystery = measured("git branch -D no-such-ref", fixture.main);
		expect(mystery.containedIn).toBeNull();
		expect(mystery.mergedIntoHead).toBeNull();
	});
});

describe("the ref state through the gate", () => {
	let seq = 0;
	const session = (): string => `ref-${(seq += 1)}`;

	const stateFor = async (command: string, cwd: string): Promise<Record<string, unknown> | undefined> => {
		const before = modelCalls.length;
		await fire("tool_call", makeEvent(command), makeCtx({ sessionId: session(), cwd }));
		return stateOf(before).gitRefProvenance as Record<string, unknown> | undefined;
	};

	test("the deleted-branch row carries the measured refs with the authority note", async () => {
		const measuredState = await stateFor("git branch -D old", fixture.main);
		expect(measuredState?.kind).toBe("branch-delete");
		expect(measuredState?.mergedIntoHead).toBe(true);
		expect(measuredState?.containedIn).toContain("refs/remotes/origin/main");
		expect(String(measuredState?.note)).toContain("measured by the gate");
	});

	test("the restore row carries the clean-tree measurement", async () => {
		const measuredState = await stateFor("git checkout -- .", fixture.main);
		expect(measuredState?.kind).toBe("checkout-paths");
		expect(measuredState?.unstagedChanges).toBe(false);
	});

	test("the rebase row carries the counts", async () => {
		const measuredState = await stateFor("git rebase origin/main", fixture.main);
		expect(measuredState?.behind).toBe(1);
		expect(measuredState?.ahead).toBe(1);
	});

	test("a command of another shape carries the field not at all", async () => {
		expect(await stateFor("git status", fixture.main)).toBeUndefined();
	});

	test("a recognized shape with no repository to measure carries null fields, not a guess", async () => {
		const measuredState = await stateFor("git branch -D old", outside);
		expect(measuredState?.kind).toBe("branch-delete");
		expect(measuredState?.target).toBe("old");
		expect(measuredState?.containedIn).toBeNull();
		expect(measuredState?.mergedIntoHead).toBeNull();
		expect(String(measuredState?.note)).toContain("measured by the gate");
	});

	test("a tree that becomes dirty between two identical calls publishes a new cache key", async () => {
		const own = makeWorktreeFixture();
		try {
			const id = session();
			const command = "git checkout -- .";
			await fire("tool_call", makeEvent(command), makeCtx({ sessionId: id, cwd: own.main }));
			expect(modelCalls).toHaveLength(1);
			// Same command, same session, same evidence: only the tree moved, and
			// the judge read the tree.
			gitIn(own.main, "echo dirty >> notes.txt");
			await fire("tool_call", makeEvent(command), makeCtx({ sessionId: id, cwd: own.main }));
			expect(modelCalls).toHaveLength(2);
			expect((stateOf(1).gitRefProvenance as { unstagedChanges?: boolean }).unstagedChanges).toBe(true);
		} finally {
			removeFixture(own.root);
		}
	});
});

describe("the criteria name the measured fields", () => {
	const question = (version: JevBatteryVersion, id: string): { instructions: string; criteria: { true: string; false: string } } => {
		const questions = jevQuestions(version) as Record<string, { instructions: string; criteria: { true: string; false: string } }>;
		return questions[id];
	};

	for (const version of [JEV_POLICY_VERSION, JEV_V3_POLICY_VERSION] as const) {
		test(`${version} reads gitRefProvenance in the destructive hazard, the verdict, and the ladder`, () => {
			const destructive = question(version, "destructive_or_irreversible");
			for (const field of ["gitRefProvenance.containedIn", "gitRefProvenance.unstagedChanges"]) {
				expect(`${destructive.instructions} ${destructive.criteria.true} ${destructive.criteria.false}`).toContain(field);
			}
			const verdict = (jevQuestions(version) as { verdict: { instructions: string; criteria: Record<string, string> } }).verdict;
			// Every option that has to read it names it: safe, unsafe, and the
			// blast-radius ladder's recoverable and unrecoverable rungs.
			expect(verdict.criteria.safe).toContain("gitRefProvenance.containedIn");
			expect(verdict.criteria.unsafe).toContain("gitRefProvenance.unstagedChanges");
			expect(verdict.instructions).toContain("`gitRefProvenance.behind`");
			const levels = (jevQuestions(version) as { blast_radius: { criteria: string[] } }).blast_radius.criteria;
			expect(levels[1]).toContain("gitRefProvenance.containedIn");
			expect(levels[2]).toContain("gitRefProvenance.unstagedChanges");
		});
	}

	test("every measured ref field is cited, or listed here as descriptive", () => {
		// The enumeration the issue asks for, kept mechanical: a field added to
		// the state without a citation has to be declared descriptive on purpose.
		const fields = ["kind", "target", "containedIn", "mergedIntoHead", "unstagedChanges", "stashCount", "behind", "ahead"];
		// Nothing is descriptive here yet: every field of this tier is a fact a
		// question reads by name.
		const descriptive: Record<string, true> = {};
		const text = JSON.stringify(jevQuestions());
		for (const field of fields) {
			expect(text.includes(`gitRefProvenance.${field}`) || descriptive[field] === true).toBe(true);
		}
	});
});
