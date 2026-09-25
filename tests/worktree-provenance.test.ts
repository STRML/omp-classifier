/**
 * Gate-measured worktree geometry (#69 slice C): what the state field
 * `gitWorktreeProvenance` measures, what its roots mean, and how the criteria
 * read it. The discipline is #63's: every field is read from git's own registry
 * at classification time, never asserted by the party whose command is judged,
 * and a repository the gate cannot measure carries no field at all.
 *
 * The path rule is the part that goes wrong quietly, so both directions are
 * pinned here: a target is inside the workspace when it IS one of the measured
 * roots or lies under one, and never because a root lies under the TARGET — the
 * main checkout contains its nested worktrees, which is exactly the trap.
 */
import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, realpathSync } from "node:fs";
import {
	JEV_POLICY_VERSION,
	JEV_V3_POLICY_VERSION,
	jevQuestions,
	measureGitWorktreeProvenance,
	type GitWorktreeProvenance,
	type JevBatteryVersion,
} from "../jev";
import { fire, jevSafeAnswer, loadPlugin, makeCtx, makeEvent, makeSettings, modelCalls, removeConfigFile, setJevAnswer, stateOf } from "./fixtures";
import { gitIn, makeWorktreeFixture, removeFixture, type WorktreeFixture } from "./git-fixture";

beforeEach(async () => {
	removeConfigFile();
	await loadPlugin(makeSettings([]));
	setJevAnswer(jevSafeAnswer());
});

/** The rule the criteria state: a target is inside the workspace when it is one
 *  of the measured roots or lies under one. */
const covered = (measured: GitWorktreeProvenance, target: string): boolean =>
	[measured.workspaceRoot, ...measured.siblingWorktreeRoots].some(root => target === root || target.startsWith(`${root}/`));

const measured = (cwd: string): GitWorktreeProvenance => {
	const value = measureGitWorktreeProvenance(cwd);
	if (value === undefined) throw new Error(`expected measured geometry for ${cwd}`);
	return value;
};

/** One fixture for the file: building it costs a dozen real git processes, and
 *  every test only reads from it. git prints physical paths, so the test
 *  compares against them (`/var` is a symlink to `/private/var` on macOS). */
const fixture: WorktreeFixture = makeWorktreeFixture();
const outside: string = `${fixture.root}/not-a-repo`;
mkdirSync(outside, { recursive: true });

afterAll(() => {
	removeFixture(fixture.root);
});

describe("the measured worktree geometry", () => {
	test("a linked worktree reports its own root, the main worktree, and its registered siblings", () => {
		const geometry = measured(fixture.feat);
		expect(geometry.workspaceRoot).toBe(realpathSync(fixture.feat));
		expect(geometry.linkedWorktree).toBe(true);
		expect(geometry.mainCheckoutRoot).toBe(realpathSync(fixture.main));
		// git's registry, minus the session's own root and the main worktree: never
		// the main checkout, and never the directory that only looks like one.
		expect([...geometry.siblingWorktreeRoots].sort()).toEqual([realpathSync(fixture.live), realpathSync(fixture.stale)].sort());
		expect(geometry.worktreeCount).toBe(4);
	});

	test("a subdirectory of a worktree answers the same geometry as its root", () => {
		// workingDirectory != workspaceRoot here, which is the case the field
		// exists for: the worktree root is a write outside workingDirectory.
		expect(measured(`${fixture.feat}/src`)).toEqual(measured(fixture.feat));
		expect(covered(measured(`${fixture.feat}/src`), realpathSync(fixture.feat))).toBe(true);
	});

	test("the roots are git's registry and the containment runs one way only", () => {
		const geometry = measured(fixture.feat);
		// Inside the workspace: the session's own worktree and paths inside it.
		expect(covered(geometry, realpathSync(fixture.feat))).toBe(true);
		expect(covered(geometry, `${realpathSync(fixture.feat)}/src/app.ts`)).toBe(true);
		// A sibling worktree the repository registered: the `git worktree remove`
		// shape from #69's table is covered by the registry, not by workingDirectory.
		expect(covered(geometry, realpathSync(fixture.stale))).toBe(true);
		// A path that only looks like a worktree, a separate checkout of the same
		// project, and the main checkout that CONTAINS this worktree: none covered.
		expect(covered(geometry, realpathSync(fixture.pretend))).toBe(false);
		expect(covered(geometry, realpathSync(fixture.clone))).toBe(false);
		expect(covered(geometry, realpathSync(fixture.main))).toBe(false);
		expect(covered(geometry, `${realpathSync(fixture.main)}/notes.txt`)).toBe(false);
		// The trap this pins: the main checkout contains the worktree, so a rule
		// written the other way round would mark every path in it as inside.
		expect(`${geometry.workspaceRoot}/`.startsWith(`${geometry.mainCheckoutRoot}/`)).toBe(true);
		expect(geometry.siblingWorktreeRoots).not.toContain(geometry.mainCheckoutRoot);
	});

	test("the main checkout is measured as its own workspace, with no main above it", () => {
		const geometry = measured(fixture.main);
		expect(geometry.workspaceRoot).toBe(realpathSync(fixture.main));
		expect(geometry.linkedWorktree).toBe(false);
		expect(geometry.mainCheckoutRoot).toBeNull();
		// Its nested worktrees are still registered roots of this repository, so
		// work on them is covered from the main checkout too.
		expect(covered(geometry, realpathSync(fixture.stale))).toBe(true);
		expect(covered(geometry, realpathSync(fixture.clone))).toBe(false);
	});

	test("a separate clone of the same project is its own main worktree, with no siblings", () => {
		const geometry = measured(fixture.clone);
		expect(geometry.workspaceRoot).toBe(realpathSync(fixture.clone));
		expect(geometry.linkedWorktree).toBe(false);
		expect(geometry.mainCheckoutRoot).toBeNull();
		expect(geometry.siblingWorktreeRoots).toEqual([]);
		expect(geometry.worktreeCount).toBe(1);
	});

	test("a bare repository and a path outside any repository measure nothing", () => {
		// The open question in the issue: a bare repository has no working tree, so
		// there is no geometry to report and the state must not carry one.
		expect(measureGitWorktreeProvenance(fixture.origin)).toBeUndefined();
		expect(measureGitWorktreeProvenance(outside)).toBeUndefined();
		expect(measureGitWorktreeProvenance("/definitely/not/a/repo")).toBeUndefined();
	});
});

describe("the geometry through the gate", () => {
	let seq = 0;
	const session = (): string => `worktree-${(seq += 1)}`;

	test("the state carries the measured geometry with its authority note", async () => {
		// #69's table row, with the session in the sibling worktree.
		const ctx = makeCtx({ sessionId: session(), cwd: fixture.feat });
		await fire("tool_call", makeEvent(`git worktree remove --force ${fixture.stale}`), ctx);
		const state = stateOf(0) as { gitWorktreeProvenance?: Record<string, unknown> };
		expect(state.gitWorktreeProvenance?.workspaceRoot).toBe(realpathSync(fixture.feat));
		expect(state.gitWorktreeProvenance?.linkedWorktree).toBe(true);
		expect(state.gitWorktreeProvenance?.siblingWorktreeRoots).toContain(realpathSync(fixture.stale));
		// The tier's authority is stated in-band, as the push provenance's is.
		expect(String(state.gitWorktreeProvenance?.note)).toContain("measured by the gate");
	});

	test("a cwd with no repository carries the field not at all", async () => {
		const ctx = makeCtx({ sessionId: session(), cwd: outside });
		await fire("tool_call", makeEvent("echo no-repo-here"), ctx);
		expect(stateOf(0).gitWorktreeProvenance).toBeUndefined();
	});

	test("a worktree registered between two identical calls publishes a new cache key", async () => {
		const id = session();
		const command = "git status";
		await fire("tool_call", makeEvent(command), makeCtx({ sessionId: id, cwd: fixture.main }));
		expect(modelCalls).toHaveLength(1);
		// Same command, same session, same evidence: only the repository's worktree
		// registry moved, and it is part of what the judge read.
		const late = `${fixture.main}/.claude/worktrees/late`;
		gitIn(fixture.main, `git worktree add -q ${JSON.stringify(late)} -b late`);
		await fire("tool_call", makeEvent(command), makeCtx({ sessionId: id, cwd: fixture.main }));
		expect(modelCalls).toHaveLength(2);
		const geometry = stateOf(1).gitWorktreeProvenance as { worktreeCount?: number; siblingWorktreeRoots?: string[] };
		expect(geometry.worktreeCount).toBe(5);
		expect(geometry.siblingWorktreeRoots).toContain(realpathSync(late));
	});
});

describe("the criteria name the measured field", () => {
	const writesQuestion = (version: JevBatteryVersion): { instructions: string; criteria: { true: string; false: string } } => {
		const questions = jevQuestions(version) as Record<string, { instructions: string; criteria: { true: string; false: string } }>;
		return questions.writes_outside_working_directory;
	};

	for (const version of [JEV_POLICY_VERSION, JEV_V3_POLICY_VERSION] as const) {
		test(`${version} reads gitWorktreeProvenance in the writes hazard and the verdict`, () => {
			const question = writesQuestion(version);
			const text = `${question.instructions} ${question.criteria.true} ${question.criteria.false}`;
			// A field the criteria do not name by backticked path is a field the
			// model does not use: the lesson from the force-push landing.
			for (const field of ["gitWorktreeProvenance.workspaceRoot", "gitWorktreeProvenance.siblingWorktreeRoots", "gitWorktreeProvenance.mainCheckoutRoot"]) {
				expect(text).toContain(field);
			}
			const verdict = (jevQuestions(version) as { verdict: { instructions: string } }).verdict.instructions;
			expect(verdict).toContain("`gitWorktreeProvenance.linkedWorktree`");
		});
	}
});
