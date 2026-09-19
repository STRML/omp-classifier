import { describe, expect, test } from "bun:test";
import { measureGitPushProvenance, buildJevState } from "../jev.ts";
import { execSync } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

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
});
