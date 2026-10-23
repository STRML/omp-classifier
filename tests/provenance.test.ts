import { beforeEach, describe, expect, test } from "bun:test";
import { measureGitPushProvenance, buildJevState } from "../jev.ts";
import { execSync } from "node:child_process";
import { mkdirSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fire, jevSafeAnswer, loadPlugin, makeCtx, makeEvent, makeSettings, removeConfigFile, setJevAnswer, stateOf } from "./fixtures";

// Real git in a temp repo. The runner has no global identity and may default
// to a branch other than main, so pin both, and ignore the host's git config
// (signing, hooks, templates) so the fixture is the same everywhere.
const GIT_ENV = {
	...process.env,
	GIT_CONFIG_GLOBAL: "/dev/null",
	GIT_CONFIG_NOSYSTEM: "1",
	GIT_AUTHOR_NAME: "test",
	GIT_AUTHOR_EMAIL: "test@example.com",
	GIT_COMMITTER_NAME: "test",
	GIT_COMMITTER_EMAIL: "test@example.com",
};
const git = (script: string, cwd: string): void => {
	execSync(script, { cwd, env: GIT_ENV });
};

describe("gate-measured git push provenance (#63)", () => {
	test("a non-push command carries no provenance", () => {
		expect(measureGitPushProvenance("echo hello", "/tmp")).toBeUndefined();
		// A push without a refspec names nothing to measure.
		expect(measureGitPushProvenance("git push origin", "/tmp")).toBeUndefined();
		expect(measureGitPushProvenance("git push origin main", "/tmp")).toBeDefined();
	});

	test("push refs parse: remote, local, remote side, plus and flags tolerated", () => {
		// against a nonexistent cwd: plumbing returns nulls, parse still visible
		const p = measureGitPushProvenance("git push origin +feature/some:feature/some --force-with-lease", "/definitely/not/a/repo");
		expect(p?.ahead).toBeNull();
	});

	test("equal tips: forwardOnly true, ahead 0 behind 0", () => {
		const dir = mkdtempSync(join(tmpdir(), "jev63-"));
		try {
			git("git init -q -b main && git commit -q --allow-empty -m base && git branch side && git update-ref refs/remotes/origin/side HEAD", dir);
			const p = measureGitPushProvenance("git push origin +main:side --force-with-lease", dir);
			expect(p?.forwardOnly).toBe(true);
			expect(p?.ahead).toBe(0);
			expect(p?.behind).toBe(0);
			// State carries the measured tier with its authority note.
			const state = buildJevState({ command: "git push origin +main:side --force-with-lease", workingDirectory: dir, gitPushProvenance: p }) as Record<string, unknown>;
			const prov = state.gitPushProvenance as Record<string, unknown>;
			expect(prov.forwardOnly).toBe(true);
			expect(String(prov.note)).toContain("measured by the gate");
		} finally {
			execSync(`trash ${JSON.stringify(dir)} 2>/dev/null || rm -rf ${JSON.stringify(dir)}`);
		}
	});

	test("a HEAD refspec is measured against the same-named remote branch, not origin/HEAD", () => {
		// `git push origin HEAD` pushes the current branch to the remote branch of
		// the same name. Measured against refs/remotes/origin/HEAD (the default
		// branch) instead, a force push that discards the remote feature branch's
		// own commits read as forward-only whenever the branch contains main.
		const dir = mkdtempSync(join(tmpdir(), "jev63-"));
		try {
			git(
				"git init -q -b main && git commit -q --allow-empty -m base && " +
					"git update-ref refs/remotes/origin/main HEAD && git symbolic-ref refs/remotes/origin/HEAD refs/remotes/origin/main && " +
					"git switch -q -c feature && git commit -q --allow-empty -m remote-only && git update-ref refs/remotes/origin/feature HEAD && " +
					"git reset -q --hard main && git commit -q --allow-empty -m local-rewrite",
				dir,
			);
			// `+HEAD` matters most: the moderate-risk overlay flags `--force`
			// spellings, so a SAFE there still asked, but `+` reaches no overlay.
			for (const command of ["git push --force origin HEAD", "git push -u origin HEAD", "git push --force origin @", "git push origin +HEAD"]) {
				const p = measureGitPushProvenance(command, dir);
				expect(p?.forwardOnly, command).toBe(false);
				expect(p?.behind, command).toBe(1);
			}
			// `HEAD:<name>` names its remote side, so only the local side is HEAD.
			const explicit = measureGitPushProvenance("git push --force origin HEAD:feature", dir);
			expect(explicit?.behind).toBe(1);
			// `<src>:HEAD` names a destination spelled HEAD: it is not the
			// current-branch shorthand, so the current branch is not swapped in.
			const destination = measureGitPushProvenance("git push --force origin main:HEAD", dir);
			expect(destination?.remoteTip).toBe(execSync("git rev-parse refs/remotes/origin/HEAD", { cwd: dir, env: GIT_ENV }).toString().trim());
			// A branch the remote does not have yet: no remote tip, nothing compared.
			git("git switch -q -c brand-new", dir);
			const fresh = measureGitPushProvenance("git push -u origin HEAD", dir);
			expect(fresh?.remoteTip).toBeNull();
			expect(fresh?.forwardOnly).toBeUndefined();
		} finally {
			execSync(`trash ${JSON.stringify(dir)} 2>/dev/null || rm -rf ${JSON.stringify(dir)}`);
		}
	});

	test("an earlier segment that rewrites refs leaves the push unmeasured", () => {
		// The gate measures before the command runs. A segment ahead of the push
		// that rewrites the pushed ref, or moves HEAD under a HEAD refspec, makes
		// the push see refs the measurement never read: forward-only before an
		// amend or a reset says nothing about the force push after it.
		const dir = mkdtempSync(join(tmpdir(), "jev63-"));
		try {
			git(
				"git init -q -b main && git commit -q --allow-empty -m base && " +
					"git update-ref refs/remotes/origin/main HEAD && git symbolic-ref refs/remotes/origin/HEAD refs/remotes/origin/main && " +
					"git branch b && git update-ref refs/remotes/origin/b HEAD",
				dir,
			);
			for (const command of [
				"git commit --amend --no-edit && git push origin +main",
				"git commit --amen --no-edit && git push origin +main",
				"git branch --forc main HEAD~1 && git push origin +main",
				"git branch -fq main HEAD~1 && git push origin +main",
				"git reset --hard HEAD~1 && git push --force origin main",
				"git rebase -i HEAD~2 && git push --force-with-lease origin main",
				"git pull --rebase && git push --force origin main",
				"git branch -f main HEAD~1 && git push origin +main",
				"git switch b && git push origin +HEAD",
				"git checkout b && git push --force origin HEAD",
				// A global option hides which subcommand runs, and in which repository.
				"git -C . reset --hard HEAD~1 && git push origin +main",
				"git -c user.name=x rebase -i HEAD~2 && git push origin +main",
				// Anything not known to leave refs alone: an alias, a script, an export.
				"git amend && git push origin +main",
				"./rewrite.sh && git push --force origin main",
				"export GIT_DIR=/elsewhere/.git; git push --force origin main",
				"echo 1111111111111111111111111111111111111111 > .git/refs/heads/main && git push origin +main",
			]) {
				expect(measureGitPushProvenance(command, dir), command).toBeUndefined();
			}
			// Commits, merges and cherry-picks only add descendants of the measured
			// tip, so forward-only still holds after them and the push stays measured.
			expect(measureGitPushProvenance("git commit -q --allow-empty -m next && git push origin main", dir)?.forwardOnly).toBe(true);
			expect(measureGitPushProvenance("git merge -q b && git push origin main", dir)?.forwardOnly).toBe(true);
			expect(measureGitPushProvenance("git add -A && git commit -q --allow-empty -m next && git push origin main", dir)?.forwardOnly).toBe(true);
			// Without force syntax git refuses any non-fast-forward update, so what ran
			// before cannot make the push destructive and it stays measured.
			expect(measureGitPushProvenance("git switch b && git push origin main", dir)?.forwardOnly).toBe(true);
		} finally {
			execSync(`trash ${JSON.stringify(dir)} 2>/dev/null || rm -rf ${JSON.stringify(dir)}`);
		}
	});

	test("a push the parse cannot pin to one ref pair in this repository is not measured", () => {
		// Each of these would have measured the plain `feature:feature` pair as a
		// forward push, while git deletes the remote branch, pushes other refs, or
		// pushes another repository.
		const dir = mkdtempSync(join(tmpdir(), "jev63-"));
		try {
			git("git init -q -b main && git commit -q --allow-empty -m base && git branch feature && git update-ref refs/remotes/origin/feature HEAD", dir);
			for (const measured of ["git push origin feature", "git push -fu origin feature", "git push --force-with-lease=feature origin feature"]) {
				expect(measureGitPushProvenance(measured, dir)?.forwardOnly, measured).toBe(true);
			}
			for (const command of [
				"git push --delete origin feature",
				"git push -d origin feature",
				"git push origin feature --delete",
				"git push -fd origin feature",
				"git push --force origin feature main",
				"git push --force --tags origin feature",
				"git push --all origin feature",
				"git push --mirror origin feature",
				"git push -o ci.skip origin feature",
				"GIT_DIR=/elsewhere/.git git push --force origin feature",
				"git --git-dir=/elsewhere/.git push --force origin feature",
				"env GIT_DIR=/elsewhere/.git git push origin +feature",
				"command git push --force origin feature",
				// git accepts unambiguous abbreviations of long options.
				"git push --del origin feature",
				"git push --mir origin feature",
			]) {
				expect(measureGitPushProvenance(command, dir), command).toBeUndefined();
			}
		} finally {
			execSync(`trash ${JSON.stringify(dir)} 2>/dev/null || rm -rf ${JSON.stringify(dir)}`);
		}
	});

	test("a neutral subcommand with a flag that writes or rewinds, a fd-less >&, or a substitution inside the push leaves it unmeasured", () => {
		// Review of #168: `log`, `cherry-pick` and `stash` are neutral by name, but
		// `--output` writes a file (a ref file included), `--abort` restores the
		// pre-sequence HEAD, and `stash branch` checks out a new branch. `>&word`
		// with a non-number target is a file redirect, and a substitution inside
		// the push's own words runs before the push does.
		const dir = mkdtempSync(join(tmpdir(), "jev63-"));
		try {
			git(
				"git init -q -b main && git commit -q --allow-empty -m base && " +
					"git update-ref refs/remotes/origin/main HEAD && git symbolic-ref refs/remotes/origin/HEAD refs/remotes/origin/main",
				dir,
			);
			for (const command of [
				"git log -1 --format=%H --output=.git/refs/heads/main && git push origin +main",
				"git log -1 --outp=.git/refs/heads/main && git push origin +main",
				"git diff --output=.git/refs/heads/main && git push origin +main",
				"git cherry-pick --abort && git push origin +main",
				"git revert --abo && git push origin +main",
				"git merge --abort && git push origin +main",
				"git stash branch tmp && git push origin +HEAD",
				"echo 1111111111111111111111111111111111111111 >& .git/refs/heads/main && git push origin +main",
				"git push origin +$(git reset -q --hard HEAD~1; echo main)",
				"git stash show --output=.git/refs/heads/main && git push origin +main",
				"git branch -D main && git branch main HEAD~1 && git push --force origin main",
			]) {
				expect(measureGitPushProvenance(command, dir), command).toBeUndefined();
			}
			for (const command of [
				"git log --oneline -1 && git push origin main",
				"git diff --output-indicator-new=+ && git push origin main",
				"git stash -u && git push origin main",
				"git stash pop && git push origin main",
				"git status 2>&1 && git push origin main",
			]) {
				expect(measureGitPushProvenance(command, dir)?.forwardOnly, command).toBe(true);
			}
		} finally {
			execSync(`trash ${JSON.stringify(dir)} 2>/dev/null || rm -rf ${JSON.stringify(dir)}`);
		}
	});

	test("a force push is measured only as the last segment after plain cd", () => {
		// The parser flattens loops and function bodies, and `&` reads like `;`,
		// so source order is not run order: a reset written after the push can
		// still run before it.
		const dir = mkdtempSync(join(tmpdir(), "jev63-"));
		try {
			git("git init -q -b main && git commit -q --allow-empty -m base && git update-ref refs/remotes/origin/main HEAD", dir);
			for (const command of [
				"for i in 1 2; do git push origin +main; git reset --hard HEAD~1; done",
				"f(){ git push origin +main; }; git reset --hard HEAD~1; f",
				"git push origin +main & git reset --hard HEAD~1",
				"git push origin +main | git reset --hard HEAD~1",
				"( git reset --hard HEAD~1 ); git push origin +main",
				"git push --force origin main && gh pr create --fill",
				"git status && git push --force origin main",
			]) {
				expect(measureGitPushProvenance(command, dir), command).toBeUndefined();
			}
			expect(measureGitPushProvenance("cd . && git push --force origin main", dir)?.forwardOnly).toBe(true);
			expect(measureGitPushProvenance("git push -u origin main && gh pr create --fill", dir)?.forwardOnly).toBe(true);
		} finally {
			execSync(`trash ${JSON.stringify(dir)} 2>/dev/null || rm -rf ${JSON.stringify(dir)}`);
		}
	});

	test("a HEAD refspec on a detached HEAD names no remote branch, so nothing is measured", () => {
		const dir = mkdtempSync(join(tmpdir(), "jev63-"));
		try {
			git(
				"git init -q -b main && git commit -q --allow-empty -m base && " +
					"git update-ref refs/remotes/origin/main HEAD && git symbolic-ref refs/remotes/origin/HEAD refs/remotes/origin/main && git switch -q --detach",
				dir,
			);
			expect(measureGitPushProvenance("git push --force origin HEAD", dir)).toBeUndefined();
		} finally {
			execSync(`trash ${JSON.stringify(dir)} 2>/dev/null || rm -rf ${JSON.stringify(dir)}`);
		}
	});

	test("diverged tips: behind above zero, forwardOnly false", () => {
		const dir = mkdtempSync(join(tmpdir(), "jev63-"));
		try {
			git("git init -q -b main && git commit -q --allow-empty -m base", dir);
			// Remote gets its own commit; local gets a different one: a genuine
			// divergence where the push would discard the remote's commit.
			git("git checkout -q --detach HEAD && git commit -q --allow-empty -m remote-only && git update-ref refs/remotes/origin/side HEAD", dir);
			git("git checkout -q main && git commit -q --allow-empty -m local-only", dir);
			const p = measureGitPushProvenance("git push origin main:side", dir);
			expect(p?.behind).toBe(1);
			expect(p?.ahead).toBe(1);
			expect(p?.forwardOnly).toBe(false);
		} finally {
			execSync(`trash ${JSON.stringify(dir)} 2>/dev/null || rm -rf ${JSON.stringify(dir)}`);
		}
	});

	test("an untracked remote yields null tips, not a guess", () => {
		const dir = mkdtempSync(join(tmpdir(), "jev63-"));
		try {
			git("git init -q -b main && git commit -q --allow-empty -m base", dir);
			const p = measureGitPushProvenance("git push https://example.com/x.git main:main", dir);
			expect(p?.remoteTip).toBeNull();
			expect(p?.localTip).not.toBeNull();
			expect(p?.forwardOnly).toBeUndefined();
		} finally {
			execSync(`trash ${JSON.stringify(dir)} 2>/dev/null || rm -rf ${JSON.stringify(dir)}`);
		}
	});

	test("a compound command measures the one push it makes, and nothing when it makes two", () => {
		const dir = mkdtempSync(join(tmpdir(), "jev63-"));
		const origin = join(dir, "origin.git");
		const repo = join(dir, "repo");
		try {
			git(`git init -q --bare -b main ${JSON.stringify(origin)}`, dir);
			git(`git init -q -b main ${JSON.stringify(repo)}`, dir);
			git(`git commit -q --allow-empty -m base && git remote add origin ${JSON.stringify(origin)} && git push -q origin main`, repo);
			// One push in the command: it is the push the record describes.
			const after = measureGitPushProvenance("git stash push -m wip && git push origin main", repo);
			expect(after?.forwardOnly).toBe(true);
			// The separator is a separator: `main;` is not a ref name.
			expect(measureGitPushProvenance("git push origin main; git status", repo)?.forwardOnly).toBe(true);
			// Two pushes name two pairs of refs, and one measurement cannot stand
			// in for both: the force push below would otherwise be judged by the
			// forward-only numbers of the push before it.
			expect(measureGitPushProvenance("git push origin main && git push --force origin side", repo)).toBeUndefined();
			expect(measureGitPushProvenance("git push origin main; git push origin main", repo)).toBeUndefined();
		} finally {
			execSync(`trash ${JSON.stringify(dir)} 2>/dev/null || rm -rf ${JSON.stringify(dir)}`);
		}
	});
	// Round 3 review, as the neighbouring spelling of the compose `--config`
	// class: `git` runs in the command's OWN segment directory, so a `cd`
	// before the push decides which repository is measured. Reading the
	// session's own repository reported another repo's tips — and its
	// `forwardOnly` — for a push that discards work.
	test("the push is measured in the repository the command's own segment runs in", () => {
		const session = mkdtempSync(join(tmpdir(), "jev63-session-"));
		const target = mkdtempSync(join(tmpdir(), "jev63-target-"));
		try {
			// The session's own repo is a clean fast-forward (ahead 1, behind 0).
			git("git init -q -b main && git commit -q --allow-empty -m base && git update-ref refs/remotes/origin/main HEAD && git commit -q --allow-empty -m local", session);
			// The repo the command cd's into has DIVERGED: the same push there
			// discards a remote commit, which the session's numbers deny.
			git("git init -q -b main && git commit -q --allow-empty -m base && git checkout -q --detach HEAD && git commit -q --allow-empty -m remote-only && git update-ref refs/remotes/origin/main HEAD && git checkout -q main && git commit -q --allow-empty -m local-only", target);
			expect(measureGitPushProvenance("git push origin main", session)?.forwardOnly).toBe(true);
			expect(measureGitPushProvenance(`cd ${target} && git push origin main`, session)).toEqual({
				remoteTip: measureGitPushProvenance("git push origin main", target)?.remoteTip,
				localTip: measureGitPushProvenance("git push origin main", target)?.localTip,
				ahead: 1,
				behind: 1,
				forwardOnly: false,
			});
			// A directory the command's text does not pin measures nothing.
			expect(measureGitPushProvenance('cd "$REPO" && git push origin main', session)).toBeUndefined();
		} finally {
			for (const dir of [session, target]) execSync(`trash ${JSON.stringify(dir)} 2>/dev/null || rm -rf ${JSON.stringify(dir)}`);
		}
	});
	test("a heredoc push word does not steer the executable push repository", async () => {
		const session = mkdtempSync(join(tmpdir(), "jev63-heredoc-session-"));
		const repoB = mkdtempSync(join(tmpdir(), "jev63-heredoc-b-"));
		const repoC = mkdtempSync(join(tmpdir(), "jev63-heredoc-c-"));
		try {
			git("git init -q -b main && git commit -q --allow-empty -m base && git update-ref refs/remotes/origin/main HEAD && git commit -q --allow-empty -m local", repoB);
			git("git init -q -b main && git commit -q --allow-empty -m base && git checkout -q --detach HEAD && git commit -q --allow-empty -m remote-only && git update-ref refs/remotes/origin/main HEAD && git checkout -q main && git commit -q --allow-empty -m local-only", repoC);
			const command = `echo "漢字"; cd ${repoB}; cat <<'EOF'\ngit push origin main\nEOF\ncd ${repoC}; git push origin main`;
			expect(measureGitPushProvenance(command, session)).toMatchObject({ ahead: 1, behind: 1, forwardOnly: false });
			await loadPlugin(makeSettings([]));
			setJevAnswer(jevSafeAnswer());
			await fire("tool_call", makeEvent(command), makeCtx({ sessionId: "prov-heredoc-offset", cwd: session }));
			expect(stateOf(0).gitPushProvenance).toMatchObject({ ahead: 1, behind: 1, forwardOnly: false });
		} finally {
			for (const dir of [session, repoB, repoC]) execSync(`trash ${JSON.stringify(dir)} 2>/dev/null || rm -rf ${JSON.stringify(dir)}`);
		}
	});
});

// Round 4 review, as the caller half of the same class: the handler resolves a
// leading `cd X &&` into the directory the host runs the command in, and then
// handed the provenance measurements that RESOLVED directory together with the
// command text that still contains the `cd`. The walkers apply the command's
// own `cd` chain, so the extracted `cd` was applied twice and the repository
// measured was the one one directory too deep. Every caller measures from the
// directory the command's text STARTS in, which is the pairing the script-body
// reader has always taken (#67 round 1).
describe("the gate measures the push in the directory the shell runs in (#63 round 4)", () => {
	let seq = 0;
	beforeEach(async () => {
		removeConfigFile();
		await loadPlugin(makeSettings([]));
		setJevAnswer(jevSafeAnswer());
	});

	test("a leading cd is not applied twice to the measured repository", async () => {
		const session = mkdtempSync(join(tmpdir(), "jev63-caller-"));
		const child = join(session, "child");
		mkdirSync(join(child, "child"), { recursive: true });
		try {
			// Three repositories. The session's own is a clean fast-forward; the
			// one the command's `cd` reaches has DIVERGED, so the push discards a
			// remote commit; and the one a second application of that `cd` lands
			// in is another clean fast-forward — so the mistaken measurement is
			// defined and reassuring rather than absent. An absent measurement
			// would already be the safe answer; a wrong one that reads as
			// reassurance is the outcome this test exists to catch.
			git("git init -q -b main && git commit -q --allow-empty -m base && git update-ref refs/remotes/origin/main HEAD && git commit -q --allow-empty -m local", session);
			git("git init -q -b main && git commit -q --allow-empty -m base && git checkout -q --detach HEAD && git commit -q --allow-empty -m remote-only && git update-ref refs/remotes/origin/main HEAD && git checkout -q main && git commit -q --allow-empty -m local-only", child);
			git("git init -q -b main && git commit -q --allow-empty -m base && git update-ref refs/remotes/origin/main HEAD && git commit -q --allow-empty -m local", join(child, "child"));
			seq += 1;
			await fire("tool_call", makeEvent("cd child && git push origin main"), makeCtx({ sessionId: `prov-caller-${seq}`, cwd: session }));
			expect(stateOf(0).gitPushProvenance).toMatchObject({ ahead: 1, behind: 1, forwardOnly: false });
		} finally {
			execSync(`trash ${JSON.stringify(session)} 2>/dev/null || rm -rf ${JSON.stringify(session)}`);
		}
	});
});
