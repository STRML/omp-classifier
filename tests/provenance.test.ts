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
