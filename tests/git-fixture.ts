/**
 * A real repository on disk for the #69 slices, built with real git plumbing
 * rather than synthetic state: the measured fields are only meaningful if the
 * fixture hands them what git would hand a live gate.
 *
 * The shapes, and the direction each one pins:
 *   main                       the main checkout (it CONTAINS the worktrees
 *                              below, which is exactly the prefix trap slice C
 *                              must not fall into)
 *   .claude/worktrees/feat     a linked worktree, with a src/ subdirectory
 *   .claude/worktrees/stale    a linked worktree on a branch already merged
 *   .claude/worktrees/live     a linked worktree on a branch merged nowhere
 *   .claude/worktrees/pretend  a directory that merely LOOKS like a worktree:
 *                              created with mkdir, never registered with git
 *   clone                      a separate clone of the same project (its own
 *                              repository), which no measured root may cover
 *
 * Branches, for the ref measurements: `old` stops at the base commit and is
 * contained in every branch that came after it; `scratch` goes one commit past
 * the base that no other ref shares. Both are absent from every worktree, so
 * they are deletable. main is ahead 1 / behind 1 against origin/main.
 */
import { execSync } from "node:child_process";
import { mkdirSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// The runner has no global identity and may default to a branch other than main,
// so pin both, and ignore the host's git config (signing, hooks, templates) so
// the fixture is the same everywhere.
export const GIT_ENV = {
	...process.env,
	GIT_CONFIG_GLOBAL: "/dev/null",
	GIT_CONFIG_NOSYSTEM: "1",
	GIT_AUTHOR_NAME: "test",
	GIT_AUTHOR_EMAIL: "test@example.com",
	GIT_COMMITTER_NAME: "test",
	GIT_COMMITTER_EMAIL: "test@example.com",
};

/** Run a git command (or a small shell script) in `cwd`. */
export function gitIn(cwd: string, script: string): void {
	execSync(script, { cwd, env: GIT_ENV, stdio: "pipe" });
}

export interface WorktreeFixture {
	root: string;
	main: string;
	feat: string;
	stale: string;
	live: string;
	pretend: string;
	clone: string;
	/** The bare repository the main checkout pushes to. */
	origin: string;
	/** A tracked file in the main checkout, for the clean/dirty cases. */
	tracked: string;
}

export function makeWorktreeFixture(): WorktreeFixture {
	const root = mkdtempSync(join(tmpdir(), "jev69-"));
	const main = join(root, "repo");
	const worktrees = join(main, ".claude", "worktrees");
	const feat = join(worktrees, "feat");
	const stale = join(worktrees, "stale");
	const live = join(worktrees, "live");
	const pretend = join(worktrees, "pretend");
	const origin = join(root, "origin.git");
	const clone = join(root, "clone");
	const tracked = join(main, "notes.txt");

	gitIn(root, `git init -q -b main ${JSON.stringify(main)}`);
	gitIn(main, "git commit -q --allow-empty -m base");
	// `old` stops at the base commit, so every branch that came later holds it.
	gitIn(main, "git branch old");
	gitIn(main, "echo second > notes.txt && git add notes.txt && git commit -q -m second");
	gitIn(main, "git branch stale && git branch live");
	// `scratch` goes one commit past the base that no other ref shares.
	gitIn(main, "git checkout -q -b scratch && git commit -q --allow-empty -m scratch-only && git checkout -q main");
	gitIn(root, `git init -q --bare -b main ${JSON.stringify(origin)}`);
	gitIn(main, `git remote add origin ${JSON.stringify(origin)}`);
	gitIn(main, "git push -q origin main");
	gitIn(main, "git fetch -q origin");
	gitIn(main, `git worktree add -q ${JSON.stringify(feat)} -b feat`);
	gitIn(main, `git worktree add -q ${JSON.stringify(stale)} stale`);
	gitIn(main, `git worktree add -q ${JSON.stringify(live)} live`);
	// A path that looks like a worktree and is not one: the measured roots come
	// from git's registry, so this must be covered by nothing.
	mkdirSync(pretend, { recursive: true });
	mkdirSync(join(feat, "src"), { recursive: true });
	// A separate clone of the same project: another checkout, its own repository.
	gitIn(root, `git clone -q ${JSON.stringify(origin)} ${JSON.stringify(clone)}`);
	// Local work the upstream lacks, and upstream work the local branch lacks.
	gitIn(main, "git commit -q --allow-empty -m local-only");
	gitIn(clone, "git commit -q --allow-empty -m remote-only && git push -q origin main");
	gitIn(main, "git fetch -q origin");
	return { root, main, feat, stale, live, pretend, clone, origin, tracked };
}

/** Remove a fixture. `trash` keeps a mistaken path recoverable; the fallback
 *  matters only where trash is unavailable. */
export function removeFixture(root: string): void {
	execSync(`trash ${JSON.stringify(root)} 2>/dev/null || rm -rf ${JSON.stringify(root)}`);
}
