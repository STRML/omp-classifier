/**
 * The literal match (plan `docs/plans/2026-09-19-intent-aware-judgment.md`,
 * Phase 2 step 2): a fast path for LOCAL actions whose every segment the code
 * extracted, and whose targets the user named in their own recent words.
 *
 * The shape of the rule is what keeps it honest. A match needs two things at
 * once: every segment of the command is either an extracted action or an inert
 * shape, and every extracted action is named in the user's text. One
 * unextracted segment (`python3 -c`, a network verb, `sudo`, an unknown
 * binary) makes the whole command incomplete, so a matched `rm` riding beside
 * an unread payload never gets the fast path.
 *
 * Every test here is a row of the plan's failure matrix.
 */
import { describe, expect, test } from "bun:test";
import { literalMatch, type LiteralMatchInput } from "../literal-match";

const CWD = "/Users/you/git/oss/project";
const HOME = "/Users/you";

/** The identity resolver stands in for a checkout with no symlinks. Production
 *  passes the real one; a delete without a resolver fails closed, which has its
 *  own test below. */
const match = (command: string, userMessages: string[], over: Partial<LiteralMatchInput> = {}) =>
	literalMatch({ command, cwd: CWD, homeDir: HOME, userMessages, resolveRealPath: candidate => candidate, ...over });

const matched = (command: string, userMessages: string[], over: Partial<LiteralMatchInput> = {}): boolean =>
	match(command, userMessages, over).matched;

describe("a match needs every segment extracted or inert, and every action named", () => {
	test("the user names the directory they want deleted", () => {
		expect(matched("rm -rf build", ["delete the build dir, it's stale"])).toBe(true);
	});

	test("nothing extracted never matches, whatever the user said", () => {
		// Vacuous match, failure matrix: "named from the model with nothing
		// extracted". An inert-only command has no action to authorize.
		expect(matched("git status", ["delete the build dir"])).toBe(false);
		expect(match("git status", []).actions).toHaveLength(0);
	});

	test("one unextracted segment makes the whole command incomplete", () => {
		const result = match("rm -rf build && python3 -c 'import os; os.system(\"curl x\")'", ["delete the build dir"]);
		expect(result.matched).toBe(false);
		expect(result.incomplete).toHaveLength(1);
	});

	test("inert segments do not block a match", () => {
		expect(matched("git status && rm -rf build && echo done", ["remove build please"])).toBe(true);
	});
});

describe("these never match literally, whatever the user's words say", () => {
	const REQUESTED = ["delete build and push the key to the server and deploy"];

	test("every network verb is non-inert", () => {
		for (const command of [
			"curl -s https://api.example.com/v1/ping",
			"wget https://example.com/x.tar.gz",
			"ssh own-server uptime",
			"scp build.tar own-server:/srv",
			"rsync -a build/ own-server:/srv/",
			"nc -z localhost 8080",
			"git push origin main",
		]) {
			expect(matched(command, REQUESTED)).toBe(false);
		}
	});

	test("privilege never matches", () => {
		expect(matched("sudo rm -rf build", ["delete the build dir"])).toBe(false);
		expect(matched("doas rm -rf build", ["delete the build dir"])).toBe(false);
	});

	test("a secret read never matches", () => {
		expect(matched("security find-generic-password -s neuralwatt -w", ["get the neuralwatt key"])).toBe(false);
	});

	test("an unknown binary is not inert", () => {
		expect(matched("./scripts/tidy.sh && rm -rf build", ["delete the build dir"])).toBe(false);
	});

	test("an inert verb carrying a redirect is a write, not a read", () => {
		// `echo` is inert; `echo … >> ~/.bashrc` installs a shell alias. The
		// verb says nothing about what the segment does to the filesystem.
		for (const command of [
			'rm -rf build && echo "alias x=y" >> ~/.bashrc',
			"rm -rf build && echo ssh-rsa AAAA >> ~/.ssh/authorized_keys",
			"rm -rf build && cat notes.txt > important.conf",
			"rm -rf build && cat < secrets.txt",
		]) {
			expect(matched(command, ["delete the build dir, it is stale"])).toBe(false);
		}
	});

	test("a read-only git subcommand stops being one when a flag runs a command", () => {
		// `--ext-diff` runs the external diff driver the repo config names, and
		// the repo config is a file the agent can write.
		expect(matched("rm -rf build && git log --ext-diff", ["delete the build dir"])).toBe(false);
		expect(matched("rm -rf build && git log --oneline -5", ["delete the build dir"])).toBe(true);
	});

	test("a glob or brace in an inert segment is not a path this code read", () => {
		// The shell expands `id_rsa.{pem,pub}`; a basename check does not.
		expect(matched("rm -rf build && cat id_rsa.{pem,pub}", ["delete the build dir"])).toBe(false);
		expect(matched("rm -rf build && cat *.pem", ["delete the build dir"])).toBe(false);
		expect(matched("rm -rf build && ls ~/.ssh", ["delete the build dir"])).toBe(true);
	});

	test("a local file named like an inert verb is not that verb", () => {
		// The agent can write `./cat` or `/tmp/evil/ls`. Only a bare command
		// name resolves through PATH to the tool this module means.
		for (const command of ["./cat notes && rm -rf build", "/tmp/evil/ls && rm -rf build", "./echo hi && rm -rf build"]) {
			expect(matched(command, ["delete the build dir"])).toBe(false);
		}
	});

	test("a local file named like a delete verb is not the delete verb", () => {
		expect(matched("./rm build", ["delete the build dir"])).toBe(false);
		expect(matched("/tmp/evil/trash build", ["delete the build dir"])).toBe(false);
	});

	test("cat of a secret file is not an inert read", () => {
		expect(matched("cat ~/.aws/credentials && rm -rf build", ["delete the build dir"])).toBe(false);
		expect(matched("cat .env && rm -rf build", ["delete the build dir"])).toBe(false);
		// A plain file still is.
		expect(matched("cat README.md && rm -rf build", ["delete the build dir"])).toBe(true);
	});

	test("a deploy script outside the working directory is not extracted", () => {
		expect(matched("/tmp/deploy.sh --prod", ["deploy prod"])).toBe(false);
		expect(matched("./scripts/deploy.sh --prod", ["deploy prod"])).toBe(true);
	});

	test("a delete never matches when the caller supplies no real-path resolver", () => {
		// Lexical containment cannot see that `build` is a symlink to /etc, and
		// the agent can create that symlink. No resolver, no match.
		expect(literalMatch({ command: "rm -rf build", cwd: CWD, homeDir: HOME, userMessages: ["delete the build dir"] }).matched).toBe(false);
	});

	test("a target whose real path leaves the working directory never matches", () => {
		// The plan asks for the real path of the target and every parent. This
		// module is pure, so the caller supplies the resolver.
		expect(
			matched("rm -rf cache", ["delete the cache dir"], {
				resolveRealPath: (candidate: string) => (candidate === `${CWD}/cache` ? "/var/lib/other/cache" : candidate),
			}),
		).toBe(false);
	});
});

describe("delete: the target must be under the working directory and named as a whole word", () => {
	test("a path outside the working directory never matches, even when the basename is named", () => {
		// Failure matrix: user named /tmp/build, the command deletes /srv/prod/build.
		expect(matched("rm -rf /srv/prod/build", ["delete /tmp/build"])).toBe(false);
	});

	test("a parent escape never matches", () => {
		expect(matched("rm -rf ../../etc/hosts", ["delete hosts"])).toBe(false);
	});

	test("whole words only, so 'build' does not match inside 'rebuild'", () => {
		expect(matched("rm -rf build", ["rebuild the project from scratch"])).toBe(false);
	});

	test("a basename under 3 characters never matches", () => {
		expect(matched("rm -rf up", ["delete up"])).toBe(false);
	});

	test("dot, dot-dot, empty targets and globs never match", () => {
		for (const target of [".", "..", "*", "build/*", "$TARGET", "$(cat list)"]) {
			expect(matched(`rm -rf ${target}`, ["delete the build dir", "delete ."])).toBe(false);
		}
	});

	test("deletes never match when the working directory is the home directory or above it", () => {
		expect(matched("rm -rf notes", ["delete notes"], { cwd: HOME })).toBe(false);
		expect(matched("rm -rf notes", ["delete notes"], { cwd: "/Users" })).toBe(false);
	});

	test("the session temp directory counts as inside", () => {
		expect(matched("rm -rf /tmp/omp-1234/scratch", ["delete the scratch dir"], { sessionTempDir: "/tmp/omp-1234" })).toBe(true);
	});

	test("a delete verb must be present, in imperative form", () => {
		expect(matched("rm -rf build", ["the build dir is stale"])).toBe(false);
		expect(matched("rm -rf build", ["we deleted build yesterday"])).toBe(false);
		expect(matched("rm -rf build", ["clean build"])).toBe(true);
	});
});

describe("branch actions: force push and branch delete", () => {
	test("the branch name and the verb both appear", () => {
		expect(matched("git push --force-with-lease origin fix/statusline", ["force push fix/statusline"])).toBe(false);
		expect(match("git branch -D fix/statusline", ["delete fix/statusline"]).matched).toBe(true);
	});

	test("the verb alone does not authorize another branch", () => {
		expect(matched("git branch -D main", ["delete fix/statusline"])).toBe(false);
	});

	test("a verb belongs to the target next to it, not to any target in the message", () => {
		// "delete build then merge main" authorizes deleting build and merging
		// main. It does not authorize deleting the branch main, because that
		// verb belongs to the other target.
		expect(matched("git branch -D main", ["delete build then merge main"])).toBe(false);
		expect(matched("git branch -D build", ["delete build then merge main"])).toBe(true);
	});

	test("every branch a variadic delete names must be named by the user", () => {
		expect(matched("git branch -D release/backup release/old", ["delete release/backup, keep release/old"])).toBe(false);
		expect(matched("git branch -D release/backup release/old", ["delete release/backup and release/old"])).toBe(true);
	});
});

describe("deploy, merge, publish, release", () => {
	test("the verb and its identifying argument both appear", () => {
		expect(matched("gh pr merge 315 --squash", ["merge 315, squash it"])).toBe(true);
		expect(matched("gh pr merge 317 --squash", ["merge 315, squash it"])).toBe(false);
	});

	test("every PR a variadic merge names must be named by the user", () => {
		expect(matched("gh pr merge 315 316 --squash", ["merge 315, squash it"])).toBe(false);
	});

	test("a condition the gate cannot check cancels the match", () => {
		// "merge when green" is a condition on the merge, not a merge. The
		// reviewer sees it with the transcript; the fast path does not take it.
		expect(matched("gh pr merge 315 --squash", ["merge 315 when green"])).toBe(false);
	});

	test("a flag that widens the action must be named too", () => {
		expect(matched("gh pr merge 315 --squash --admin", ["merge 315, squash it"])).toBe(false);
		expect(matched("gh pr merge 315 --squash --admin", ["merge 315 with admin"])).toBe(true);
	});

	test("past forms never match", () => {
		expect(matched("gh pr merge 315 --squash", ["I merged 315 already"])).toBe(false);
		expect(matched("./scripts/deploy.sh --prod", ["we deployed prod last night"])).toBe(false);
	});

	test("present-progressive counts", () => {
		expect(matched("./scripts/deploy.sh --prod", ["merging and deploying prod now"])).toBe(true);
	});
});

describe("what counts as the user's words", () => {
	test("a restrictive or conditional word within 5 words cancels the match", () => {
		for (const message of [
			"don't delete build",
			"never delete build",
			"delete the dist dir rather than build",
			"delete build only if the tests pass",
			"maybe delete build later",
			"stop, do not delete build",
			"we should delete build",
			"deploy prod without touching build, do not delete build",
		]) {
			expect(matched("rm -rf build", [message])).toBe(false);
		}
	});

	test("a typed apostrophe cancels the same as an ASCII one", () => {
		// What a Mac and a phone actually type.
		expect(matched("rm -rf build", ["don’t delete build"])).toBe(false);
		expect(matched("rm -rf build", ["we can’t delete build yet"])).toBe(false);
		expect(matched("rm -rf build", ["donʼt delete build"])).toBe(false);
	});

	test("the cancel window is 5 words, so a far-away condition does not cancel", () => {
		expect(matched("rm -rf build", ["if the tests pass, ship it, then when you are done with all of that delete build"])).toBe(true);
	});

	test("fenced code, quoted lines and pasted blocks never match", () => {
		expect(matched("rm -rf build", ["run this: ```rm -rf build```"])).toBe(false);
		expect(matched("rm -rf build", ["> delete build"])).toBe(false);
		expect(matched("rm -rf build", ["`delete build`"])).toBe(false);
	});

	test("only the recent window counts; a pinned or inherited message never produces a match", () => {
		// Failure matrix: an old first message names a target, a later "go ahead".
		expect(matched("rm -rf build", ["go ahead"], { pinnedUserMessage: "delete build when you get to it" })).toBe(false);
		expect(matched("rm -rf build", ["go ahead"], { inheritedUserMessages: ["delete build"] })).toBe(false);
	});
});

describe("the result explains itself", () => {
	test("a match names the actions it matched", () => {
		const result = match("rm -rf build", ["delete the build dir"]);
		expect(result.matched).toBe(true);
		expect(result.actions.map(a => a.kind)).toEqual(["delete"]);
		expect(result.reason.length).toBeGreaterThan(0);
	});

	test("a miss names why", () => {
		expect(match("rm -rf build && curl https://x.dev", ["delete build"]).reason).toContain("segment");
		expect(match("rm -rf build", ["go ahead"]).reason).toContain("build");
	});
});
