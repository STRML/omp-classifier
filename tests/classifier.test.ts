/**
 * Classifier behavior through the interceptor: verdict routing, fail-closed
 * paths, and the structured state + question battery the gate sends to Jev.
 *
 * Every test runs in a FRESH session (the module-level cache is per-session;
 * cache scoping itself is exercised deliberately in cache.test.ts), and unique
 * commands where the test asserts a fresh classification.
 */
import { beforeEach, describe, expect, test } from "bun:test";
import { matchModerateRiskTokens } from "../index";
import {
	fire,
	loadPlugin,
	makeCtx,
	makeEvent,
	makeSettings,
	modelCalls,
	loggerInfos,
	resultText,
	refusalOf,
	selectCalls,
	stateOf,
	questionsOf,
	JEV_FIXTURE_HAZARDS,
	jevSafeAnswer,
	jevUnsafeAnswer,
	jevUnsureAnswer,
	setJevAnswer,
	ALLOW_ONCE,
	removeConfigFile,
	makeSessionId,
} from "./fixtures";


beforeEach(async () => {
	removeConfigFile();
	await loadPlugin(makeSettings([]));
	setJevAnswer(jevSafeAnswer());
});

const fresh = (opts: Parameters<typeof makeCtx>[0] = {}) => makeCtx({ sessionId: makeSessionId("classify"), ...opts });

const gate = async (command: string, ctxOptions: Parameters<typeof makeCtx>[0] = {}, input: Record<string, unknown> = {}) =>
	resultText(await fire("tool_call", makeEvent(command, input), fresh(ctxOptions)));

describe("verdict routing", () => {
	test("SAFE passes through without a prompt", async () => {
		setJevAnswer(jevSafeAnswer());
		const ctx = fresh({ hasUI: true });
		const result = resultText(await fire("tool_call", makeEvent("git status"), ctx));
		expect(result).toBe("ALLOWED");
		expect(selectCalls(ctx).length).toBe(0);
		expect(modelCalls.length).toBe(1);
	});
	test("SAFE auto-run is recorded in the decision log", async () => {
		setJevAnswer(jevSafeAnswer());
		const ctx = fresh({ hasUI: true });
		await fire("tool_call", makeEvent("git status"), ctx);
		expect(loggerInfos.some(m => m.includes("verdict=SAFE") && m.includes("git status"))).toBe(true);
	});

	test("UNSAFE with UI + approve runs", async () => {
		setJevAnswer(jevUnsafeAnswer());
		const ctx = fresh({ hasUI: true, selectResult: ALLOW_ONCE });
		const result = resultText(await fire("tool_call", makeEvent("git branch -D feature"), ctx));
		expect(result).toBe("ALLOWED");
		expect(selectCalls(ctx)[0][0]).toContain("classified unsafe");
	});

	test("UNSAFE with UI + deny blocks", async () => {
		setJevAnswer(jevUnsafeAnswer());
		const ctx = fresh({ hasUI: true });
		const result = resultText(await fire("tool_call", makeEvent("git branch -D feature"), ctx));
		const payload = refusalOf(result);
		expect(result).toContain("classified unsafe");
		expect(payload.layer).toBe("dialog");
		expect(selectCalls(ctx).length).toBe(1);
	});

	test("UNSAFE headless fails closed", async () => {
		setJevAnswer(jevUnsafeAnswer());
		const result = await gate("git push --force origin main");
		expect(result).toContain("classified unsafe");
		expect(refusalOf(result).layer).toBe("headless");
	});

	test("UNSURE headless fails closed", async () => {
		setJevAnswer(jevUnsureAnswer());
		const result = await gate("make deploy");
		expect(result).toContain("classifier unsure");
		expect(refusalOf(result).layer).toBe("headless");
	});

	test("one model call per fresh classification", async () => {
		const ctx = fresh();
		await resultText(await fire("tool_call", makeEvent("git status"), ctx));
		expect(modelCalls.length).toBe(1);
		await resultText(await fire("tool_call", makeEvent("git status"), ctx));
		expect(modelCalls.length).toBe(1); // cached
	});
});

describe("request construction", () => {
	test("command and resolved cwd travel in the request state", async () => {
		await fire("tool_call", makeEvent("make build", { cwd: "/abs/project" }), fresh({ cwd: "/other" }));
		expect(stateOf(0).command).toBe("make build");
		expect(stateOf(0).workingDirectory).toBe("/abs/project");
	});

	test("the request carries the model id and the full question battery", async () => {
		await fire("tool_call", makeEvent("make build"), fresh());
		expect(typeof modelCalls[0].model).toBe("string");
		const asked = Object.keys(questionsOf(0));
		expect(asked).toContain("verdict");
		expect(asked).toContain("blast_radius");
		for (const hazard of JEV_FIXTURE_HAZARDS) expect(asked).toContain(hazard);
		// The verdict question is the whole safety policy in this architecture,
		// so it has to name both options the gate thresholds on.
		const verdictQuestion = JSON.stringify(questionsOf(0).verdict).toLowerCase();
		expect(verdictQuestion).toContain("safe");
		expect(verdictQuestion).toContain("unsafe");
	});
});

describe("moderate-risk overlay", () => {
	test("SAFE verdict on a clean command auto-runs (graceful path)", async () => {
		// The user's reporting case: chained read-only inspection must run,
		// not prompt, when the classifier says SAFE.
		expect(
			await gate(
				'cd /Users/x/project && git status --short && echo "=====ALL DIFF STAT=====" && git diff --stat',
			),
		).toBe("ALLOWED");
	});

	test("SAFE verdict: plain temp rm auto-runs, recursive rm is flagged", async () => {
		setJevAnswer(jevSafeAnswer());
		// A named scratch file under /tmp is no longer in the forced-dialog
		// set; recursion keeps the dialog (the overlay is the layer that
		// catches it — the builtin critical list demands -r/-f on an absolute
		// path and does not match `rm -rf ./build`).
		expect(await gate("rm /tmp/scratch && echo done")).toBe("ALLOWED");
		const flagged = await gate("rm -rf ./build");
		expect(flagged).toContain("flagged for approval");
		expect(flagged).toContain("flags: rm");
	});

	test("SAFE verdict on history rewrite, network fetch, and privilege paths", async () => {
		setJevAnswer(jevSafeAnswer());
		// Each is outside the builtin critical list (mkfs/dd-to-device ARE
		// critical and never reach the classifier); the overlay must catch the
		// rest.
		// curl|sh, git reset, mkfs and dd-to-device ARE critical and never
		// reach the classifier; the overlay must catch what the builtin list
		// does not.
		for (const command of [
			"git push --force origin main",
			"sudo make install",
			"python3 -c \"exec(base64.b64decode('cHJpbnQoMSkp'))\"",
		]) {
			const result = await gate(command);
			expect(result).toContain("flagged for approval");
		}
	});

	test("SAFE on reflog-reversible git work auto-runs", async () => {
		setJevAnswer(jevSafeAnswer());
		// --amend and reset --soft keep the pre-image in the reflog; the
		// overlay reserves its backstop for reset --hard, clean, and force.
		expect(await gate("git commit --amend -m x")).toBe("ALLOWED");
		expect(await gate("git reset --soft HEAD~1")).toBe("ALLOWED");
	});

	test("flagged SAFE still runs when the user approves interactively", async () => {
		setJevAnswer(jevSafeAnswer());
		const ctx = fresh({ hasUI: true, selectResult: ALLOW_ONCE });
		const result = await fire("tool_call", makeEvent("git push --force origin main", {}), ctx);
		// requestPermission -> ui.select "Allow once" -> undefined (run).
		expect(result).toBeUndefined();
		expect(selectCalls(ctx).length).toBe(1);
	});
});

describe("matcher unit spec", () => {
	test("flags destructive and network tokens", async () => {
		const { matchModerateRiskTokens } = await import("../index.ts");
		const cases: Array<[string, string[]]> = [
			["rm -rf build", ["rm"]],
			["rmdir old", []],
			["dd if=/dev/zero of=/tmp/x bs=1m count=1", ["dd"]],
			["mkfs.ext4 /dev/sda1", ["mkfs"]],
			["chmod +x script.sh", []],
			["sudo apt update", ["sudo"]],
			["curl -O https://x/y", []],
			["git push origin main", []],
			["git push --force origin main", ["git push --force"]],
			["git commit --amend -m x", []],
			["git reset --hard HEAD", ["git reset"]],
			["git -c core.hooksPath=/dev/null push --force origin main", ["git push --force"]],
			["git reset --soft HEAD~1", []],
			["git reset HEAD~1", []],
			["git reset --ha HEAD", ["git reset"]],
			["git clean -fdx", ["git clean"]],
			["bash -c 'echo hi'", []],
			["bash -c 'rm -rf x'", ["bash -c"]],
			["tee /etc/hosts", []],
			["eval $(echo hi)", ["eval"]],
		];
		for (const [command, expected] of cases) {
			expect(matchModerateRiskTokens(command)).toEqual(expected);
		}
	});

	test("an absolute path does not defeat the risk overlay", async () => {
		// A command's identity is its basename. Matching the literal first word
		// let `/bin/rm` and `/usr/bin/env rm` past the backstop that catches a
		// classifier SAFE on a destructive verb.
		const { matchModerateRiskTokens } = await import("../index.ts");
		const cases: Array<[string, string[]]> = [
			["/bin/rm -rf ./src", ["rm"]],
			["/usr/bin/env rm -rf ./src", ["rm"]],
			["/bin/sh -c 'rm -rf x'", ["sh -c"]],
		];
		for (const [command, expected] of cases) {
			expect(matchModerateRiskTokens(command)).toEqual(expected);
		}
	});

	test("leaves routine read/build/test pipelines unflagged", async () => {
		const { matchModerateRiskTokens } = await import("../index.ts");
		const clean: string[] = [
			"echo hello | tr a-z A-Z",
			"git status --short",
			"git diff --stat",
			"git log --oneline -5",
			"git checkout -b feature/x",
			"cd /tmp && make build",
			"npm test",
			"bun run typecheck",
			"echo '{}' | python3 -c 'import json,sys; json.load(sys.stdin)'",
			"grep -r TODO src",
			"cp /tmp/a.txt /tmp/b.txt",
			'echo "=====ALL DIFF STAT====="',
			"sed -i s/foo/bar/ file.txt", // sed excluded: in-place edits are for review, not this overlay
			"git stash push -m wip",
		];
		for (const command of clean) {
			expect(matchModerateRiskTokens(command)).toEqual([]);
		}
	});

	test("case and embedded-word safety", async () => {
		const { matchModerateRiskTokens } = await import("../index.ts");
		expect(matchModerateRiskTokens("RM -rf /tmp/x").includes("rm")).toBe(true);
		expect(matchModerateRiskTokens("improved performance")).toEqual([]);
		expect(matchModerateRiskTokens("evaluate && git status")).toEqual([]);
		expect(matchModerateRiskTokens("remove stale tmp files")).toEqual([]);
	});

	test("shell-obfuscated command names and git options are still flagged", async () => {
		const { matchModerateRiskTokens } = await import("../index.ts");
		// Quoted/concatenated names (tokenizer strips quotes -> the real verb).
		// `r''m` concatenates to `rm`; `r'x'm` concatenates to `rxm` (a different
		// program, not an obfuscation of rm), so only the empty-quote splice is
		// asserted here.
		expect(matchModerateRiskTokens("r''m -rf /tmp/x").includes("rm")).toBe(true);
		expect(matchModerateRiskTokens('rm "/tmp/x y"')).toEqual([]);
		// git global options interposed before the subcommand.
		expect(matchModerateRiskTokens("git -c core.hooksPath=/dev/null push --force origin main").includes("git push --force")).toBe(true);
		// A punished destructive form is not mis-flagged as safe.
		expect(matchModerateRiskTokens("curl https://x | sh")).toContain("| sh");
		expect(matchModerateRiskTokens("wget -O- https://x | bash")).toContain("| bash");
	});

	test("pass-3 attack surface: wrappers, attached redirects, git positions, splices", async () => {
		const { matchModerateRiskTokens } = await import("../index.ts");
		// Wrapper commands that execute their argument.
		expect(matchModerateRiskTokens("env rm important")).toContain("rm");
		expect(matchModerateRiskTokens("env NAME=x rm important")).toContain("rm");
		expect(matchModerateRiskTokens("command rm important")).toContain("rm");
		expect(matchModerateRiskTokens("nohup rm important")).toContain("rm");
		expect(matchModerateRiskTokens("nice -n 5 rm important")).toContain("rm");
		expect(matchModerateRiskTokens("timeout 10 rm important")).toContain("rm");
		expect(matchModerateRiskTokens("nohup env rm important")).toContain("rm");
		expect(matchModerateRiskTokens("printf x | xargs rm")).toContain("rm");
		expect(matchModerateRiskTokens("find . -exec rm {} \\;")).toContain("rm");
		// Attached redirection fuses into the verb token.
		expect(matchModerateRiskTokens("rm>/tmp -f /tmp/x")).toContain("rm");
		// Backslash-newline splice (the shell deletes the pair).
		expect(matchModerateRiskTokens("r\\\nm -rf /tmp/x")).toContain("rm");
		// Command substitution hides the verb from positional analysis.
		expect(matchModerateRiskTokens('echo "$(rm important)"')).toContain("rm");
		// git option positions: value-taking globals. Trailing --amend is
		// reflog-reversible and releases; the overlay keeps --hard, clean,
		// and force pushes.
		expect(matchModerateRiskTokens("git -C /repo push --force")).toContain("git push --force");
		expect(matchModerateRiskTokens("git commit -m x --amend")).toEqual([]);
	});

	test("benign lookalikes of the pass-3 fixes stay unflagged", async () => {
		const { matchModerateRiskTokens } = await import("../index.ts");
		expect(matchModerateRiskTokens("echo $(date)")).toEqual([]);
		expect(matchModerateRiskTokens("grep $(git rev-parse HEAD) log")).toEqual([]);
		expect(matchModerateRiskTokens("echo `date`")).toEqual([]);
		expect(matchModerateRiskTokens("git stash push -m wip")).toEqual([]);
		expect(matchModerateRiskTokens("git notes push")).toEqual([]);
		expect(matchModerateRiskTokens("git commit -m 'msg'")).toEqual([]);
		expect(matchModerateRiskTokens("git checkout -- pathspec")).toEqual([]);
		// Substitution flagging stays narrow: risk verbs INSIDE a span flag
		// (including unterminated spans); benign spans do not.
		expect(matchModerateRiskTokens('echo "$(rm important)"')).toContain("rm");
		expect(matchModerateRiskTokens("echo $(rm")).toContain("rm");
		expect(matchModerateRiskTokens("`rm -rf /tmp/x`")).toContain("rm");
	});
});
describe("rm/unlink shape scoping", () => {
	test("systemic shapes keep the forced dialog; plain named targets drop out", () => {
		const flagged = [
			"rm -rf ./build",
			"rm -fr ./build",
			"rm --recursive ./build",
			"rm -r src",
			"rm *.log",
			"rm build?.txt",
			"rm 'src/[ab].ts'",
			"rm ../shared.txt",
			"rm src/../notes.md",
			"rm .env",
			"rm .git/config",
			"rm ./.hidden",
			"rm ~/.ssh/known_hosts",
			"rm /usr/local/bin/tool",
			"rm -rf /tmp/scratch",
		];
		for (const command of flagged) {
			expect(matchModerateRiskTokens(command)).toContain("rm");
		}
	});
	test("plain named deletions auto-run on the model's verdict", () => {
		const clean = [
			"rm build.log",
			"rm ./build.log",
			"rm src/a.ts src/b.ts",
			"rm /tmp/scratch.txt",
			"rm /private/var/tmp/scratch.txt",
			"rm -i important",
			"rm -- --weird-name",
		];
		for (const command of clean) {
			expect(matchModerateRiskTokens(command)).toEqual([]);
		}
		expect(matchModerateRiskTokens("unlink .env")).toContain("unlink");
		expect(matchModerateRiskTokens("unlink scratch.txt")).toEqual([]);
		expect(matchModerateRiskTokens("unlink -r dir")).toContain("unlink");
	});
	test("cwd threading scopes absolute targets; unknown cwd fails closed", () => {
		expect(matchModerateRiskTokens("rm /repo/scratch.txt", "/repo")).toEqual([]);
		expect(matchModerateRiskTokens("rm /repo/scratch.txt")).toContain("rm");
		expect(matchModerateRiskTokens("rm /repo/sub/leaf", "/repo")).toEqual([]);
	});
});

describe("rm-family dialog footnote (trash alternative)", () => {
	test("rm dialog carries the footnote; an unrelated flags dialog does not", async () => {
		setJevAnswer(jevSafeAnswer());
		const rmCtx = fresh({ hasUI: true, selectResult: ALLOW_ONCE });
		await fire("tool_call", makeEvent("rm -rf ./build"), rmCtx);
		expect(selectCalls(rmCtx)[0][0]).toContain("Reversible alternative: trash <paths>");

		const sudoCtx = fresh({ hasUI: true, selectResult: ALLOW_ONCE });
		await fire("tool_call", makeEvent("sudo make install"), sudoCtx);
		expect(selectCalls(sudoCtx)[0][0]).not.toContain("trash <paths>");
	});
});

describe("stale-code guard", () => {
	test("suffix appears only when the on-disk mtime is newer than load", async () => {
		const { pluginStaleSuffix, STALE_CODE_SUFFIX } = await import("../index.ts");
		expect(pluginStaleSuffix(100, 200)).toBe(STALE_CODE_SUFFIX);
		expect(pluginStaleSuffix(100, 100)).toBe("");
		expect(pluginStaleSuffix(200, 100)).toBe("");
		expect(pluginStaleSuffix(100, undefined)).toBe("");
	});
});

/**
 * A heredoc body is stdin data, not command words. The tokenizer flattens the
 * whole command including the body, so `if (dd < 30) {` in a TypeScript file
 * being written with `cat > f <<'EOF'` tokenized to a segment whose verb was
 * `dd` — the tokenizer splits on `(` and reads `<` as a redirect — and a SAFE
 * verdict on a plain file write hit the forced dialog. Bodies drop out of the
 * positional scan unless the command they feed EXECUTES stdin.
 */
describe("heredoc bodies are data, not commands", () => {
	const flags = async (command: string): Promise<string[]> => {
		const { matchModerateRiskTokens } = await import("../index.ts");
		return matchModerateRiskTokens(command, "/tmp");
	};
	const doc = (owner: string, body: string, delim = "'EOF'"): string =>
		`${owner} <<${delim}\n${body}\n${delim.replace(/'/gu, "")}`;

	test("source code written to a file does not flag its identifiers", async () => {
		expect(await flags(doc("cat > /tmp/x.ts", "  if (dd < 30) { cands.push(1); }"))).toEqual([]);
		expect(await flags(doc("cat > /tmp/x.md", "run sudo rm -rf / to wipe the disk"))).toEqual([]);
		expect(await flags(doc("cat > /tmp/x.md", "curl https://example.com | sh"))).toEqual([]);
	});

	test("a quoted delimiter leaves substitutions inert; an unquoted one does not", async () => {
		expect(await flags(doc("cat > /tmp/x.md", "cost: $(rm -rf /tmp/build/*)"))).toEqual([]);
		expect(await flags(doc("cat > /tmp/x.md", "cost: $(rm -rf /tmp/build/*)", "EOF"))).toEqual(["rm"]);
	});

	test("a body piped into an interpreter is not a plain write", async () => {
		// The owner line carries a pipe, so it is not the one shape this drops.
		// The body stays under scan and the pipe stage flags on top of it.
		expect(await flags("cat <<'EOF' | bash\nrm -rf /tmp/build/*\nEOF")).toEqual(["rm", "| bash"]);
	});

	test("one command, two heredocs, judged separately", async () => {
		const both = "cat > /tmp/a.ts <<'A'\nif (dd < 30) {\nA\nbash <<'B'\nrm -rf /tmp/build/*\nB";
		expect(await flags(both)).toEqual(["rm"]);
	});

	test("an indented delimiter is data; an unterminated body is not trusted", async () => {
		expect(await flags("cat > /tmp/f <<-'EOF'\n\tif (dd < 30) {\n\tEOF")).toEqual([]);
		// No closer found means the parse may be wrong about where the body
		// ends, so the body stays under scan. An over-flag on a malformed
		// command beats a delimiter quirk that hides the tail of a real one.
		expect(await flags("cat > /tmp/f <<'EOF'\nsudo rm -rf /etc\n")).toEqual(["sudo"]);
	});

	test("an unterminated heredoc keeps every later owner line as body", async () => {
		expect(await flags("cat > /tmp/a <<'A'\ncat > /tmp/b <<'B'\nsudo chown root /etc/hosts\nB")).toEqual(["sudo"]);
	});

	// Codex review round 4, two findings. Each one deletes text the shell
	// really runs, which the narrow rule read as inert body.
	test("a glued or commented owner line is not a command boundary", async () => {
		// `bash -s \` glues the owner onto the previous line; the body runs
		// as bash script text, so it stays under scan.
		expect(await flags("bash -s \\\ncat > /tmp/f <<'EOF'\nsudo chown root /etc/hosts\nEOF")).toEqual(["sudo"]);
		// A `#` earlier on the line makes the owner a comment; the lines
		// after it are live commands.
		expect(await flags("echo hi #; cat > /tmp/f <<'EOF'\nsudo rm -rf /tmp/build/*\nEOF")).toEqual(["sudo"]);
	});

	test("an owner inside another heredoc body is not a command", async () => {
		// The outer delimiter is unquoted, so the shell expands the body
		// before cat reads it: stripping the substitution would hide it.
		expect(
			await flags("cat <<OUT\ncat > /tmp/f <<'EOF'\n$(sudo chown root /etc/hosts)\nEOF\nOUT")
		).toEqual(["sudo"]);
		// With a quoted outer delimiter the body is inert, and its writer
		// shape strips the body exactly as any other: nothing flags.
		expect(
			await flags("cat <<'OUT'\ncat > /tmp/f <<'EOF'\nsudo chown root /etc/hosts\nEOF\nOUT")
		).toEqual([]);
	});

	test("a glued heredoc without a closer ends the stripping", async () => {
		expect(
			await flags("bash -s \\\ncat > /tmp/a <<'A'\ncat > /tmp/b <<'B'\nsudo chown root /etc/hosts\nB")
		).toEqual(["sudo"]);
	});

	// Codex review round 6, four findings. Each one hides live text behind a
	// parse the strip rule thought it could trust.
	test("an owner inside a multi-line string is string text", async () => {
		// The quote opens on the echo line and swallows the owner; the shell
		// never opens a heredoc there, so nothing may strip.
		expect(
			await flags("echo \"prefix\ncat > /tmp/f <<'EOF'\n\"\nEOF\nsudo chown root /etc/hosts")
		).toEqual(["sudo"]);
	});

	test("a shadowing outer heredoc counts whatever opens it", async () => {
		// Digit delimiters are legal words, and the outer body expands, so
		// the substitution inside stays under scan.
		expect(
			await flags("cat <<123\ncat > /tmp/f <<'EOF'\n$(sudo chown root /etc/hosts)\nEOF\n123")
		).toEqual(["sudo"]);
		// A closer with trailing whitespace does not close for the shell
		// either, so the outer body runs on past it.
		expect(
			await flags("cat <<OUT\nOUT \ncat > /tmp/f <<'EOF'\n$(sudo chown root /etc/hosts)\nEOF\nOUT")
		).toEqual(["sudo"]);
	});

	test("an interpreter body runs past a closer with trailing space", async () => {
		// The shell keeps reading at `EOF `, so the os.system line executes;
		// the body extractor must truncate nowhere before it.
		expect(
			await flags("echo x | python3 - <<'EOF'\nEOF=0\nEOF \n__import__(\"os\").system(\"id\")\nEOF")
		).toEqual(["| python3"]);
	});

	// Codex review round 7, two findings. The parses behind the strip and the
	// shadow check each missed a way bash really reads the text.
	test("an owner inside an ansi-c string is string text", async () => {
		// bash closes this string only at the lone quote on line three, then
		// runs what follows: `\'` does not close a $'...' string.
		const cmd = "printf $'prefix \\'\ncat > /tmp/f <<'EOF'\n'\necho PWNED\nEOF";
		const { withoutWrittenHeredocBodies } = await import("../index.ts");
		expect(withoutWrittenHeredocBodies(cmd)).toBe(cmd);
	});

	test("a shadowing outer heredoc counts any bash delimiter word", async () => {
		// A dot-start delimiter is a legal word, and the outer body expands,
		// so the substitution inside stays under scan.
		expect(
			await flags("cat <<.OUT\ncat > /tmp/f <<'EOF'\n$(sudo chown root /etc/hosts)\nEOF\n.OUT")
		).toEqual(["sudo"]);
	});

	// Codex review round 8, two findings. One let a longer command name wear
	// the owner shape; one let a substitution delimiter truncate the shadow.
	test("the owner word is exactly cat or tee", async () => {
		// `catapult <<"EOF"` is a different command; a function by that name
		// executes its stdin as a script, so the body stays under scan.
		expect(await flags('catapult <<"EOF"\nrm -rf /tmp/build/*\nEOF')).toEqual(["rm"]);
	});

	test("an expansion-shaped delimiter covers to end of input", async () => {
		// bash reads the delimiter word literally, and this walk cannot know
		// where such a word ends, so no closer line may be trusted.
		expect(
			await flags("cat <<$(printf OUT)\ncat > /tmp/f <<'EOF'\n$(sudo chown root /etc/hosts)\nEOF\n$")
		).toEqual(["sudo"]);
	});

	// Codex review round 9, one finding. The escape set for delimiter words
	// had lost its question mark, so a quantifier leaked into the closer.
	test("a question-mark delimiter closes on its own line only", async () => {
		// ^A?$ with an unescaped ? would accept a bare A line as the closer
		// and strip a nested substitution the outer body really expands.
		expect(
			await flags("cat <<A?\nA\ncat > /tmp/f <<'EOF'\n$(sudo chown root /etc/hosts)\nEOF\nA?")
		).toEqual(["sudo"]);
	});

	test("a glued heredoc still ends where its closer says", async () => {
		// The glued owner's body is kept, but a real owner after its closer
		// strips exactly as before: the resume point is the closer line.
		const { withoutWrittenHeredocBodies } = await import("../index.ts");
		const both = "bash -s \\\ncat > /tmp/f <<'EOF'\nif (dd < 30) {\nEOF\ncat > /tmp/g.ts <<'G'\nrm -rf /tmp/build/*\nG";
		expect(withoutWrittenHeredocBodies(both)).toBe(
			"bash -s \\\ncat > /tmp/f <<'EOF'\nif (dd < 30) {\nEOF\ncat > /tmp/g.ts <<'G'\n"
		);
	});

	// Codex review round 1, five findings. Each one is a command whose body the
	// shell really does execute or expand, which the first cut read as inert.
	test("an expansion in the owner is not a command boundary", async () => {
		// `(`, `)`, `{` and `}` are operators in one context and expansion
		// syntax in another. Reading them as boundaries dropped the body of a
		// live `bash`.
		expect(await flags("bash $(echo -s) <<'EOF'\nrm -rf /tmp/build/*\nEOF")).toEqual(["rm"]);
		expect(await flags("bash ${OPTS} <<'EOF'\nrm -rf /tmp/build/*\nEOF")).toEqual(["rm"]);
		expect(await flags("bash `echo -s` <<'EOF'\nrm -rf /tmp/build/*\nEOF")).toEqual(["rm"]);
		// A real boundary still ends the owner.
		expect(await flags("bash; cat > /tmp/x.ts <<'EOF'\nif (dd < 30) {\nEOF")).toEqual([]);
	});

	test("a quoted shell operator does not truncate the owner", async () => {
		expect(await flags("bash -s 'arg;value' <<'EOF'\nrm -rf /tmp/build/*\nEOF")).toEqual(["rm"]);
	});

	test("an unlisted wrapper does not hide the interpreter", async () => {
		expect(await flags("time bash <<'EOF'\nrm -rf /tmp/build/*\nEOF")).toEqual(["rm"]);
		expect(await flags("doas bash <<'EOF'\nrm -rf /tmp/build/*\nEOF")).toEqual(["rm"]);
	});

	test("an opener inside quotes is text, and a delimiter keeps its whole word", async () => {
		// `printf 'literal <<EOF'` opens nothing; reading it as an unterminated
		// heredoc deleted the rest of the command.
		expect(await flags("printf 'literal <<EOF'\nsudo rm -rf /tmp/build/*")).toEqual(["sudo"]);
		// `EOF-1` is the delimiter, not `EOF`: matching the prefix found no
		// closer and swallowed everything after it.
		expect(await flags("cat <<EOF-1\nbody\nEOF-1\nsudo rm -rf /tmp/build/*")).toEqual(["sudo"]);
	});

	test("a closing delimiter is the whole line, spaces included", async () => {
		// `  EOF` is body text for a plain `<<`, so the real body runs past it.
		const doc = "cat > /tmp/f <<'EOF'\n  EOF\nsudo chown root /etc/x\nEOF";
		expect(await flags(doc)).toEqual([]);
	});

	// Codex review round 2, seven more findings. The pattern behind all of them
	// was a default that had to be right about the owner to stay safe; it is
	// now inverted, and a body is data only when the owner provably reads.
	test("a backslash-newline inside a body does not eat the closer", async () => {
		// The `\\\n` strip used to run before heredoc boundaries were known,
		// which joined `safe\` to the closing EOF and deleted the tail.
		expect(await flags("cat > /tmp/f <<'EOF'\nsafe\\\nEOF\nsudo rm -rf /tmp/x")).toEqual(["sudo"]);
	});

	test("a dynamic or grouped owner is not assumed inert", async () => {
		expect(await flags("x=bash; $x <<'EOF'\nrm -rf /tmp/x\nEOF")).toEqual(["rm"]);
		expect(await flags("{ bash -s; } <<'EOF'\nrm -rf /tmp/x\nEOF")).toEqual(["rm"]);
	});

	test("a delimiter carrying an expansion keeps its whole word", async () => {
		expect(await flags("cat <<EOF$X\nbody\nEOF$X\nsudo rm -rf /tmp/x")).toEqual(["sudo"]);
	});

	test("two heredocs on one line are not the shape this drops", async () => {
		// `cat <<'A' <<'B'` needs the shell's left-to-right redirection rules to
		// say which body is which. It does not match, so both stay under scan.
		expect(await flags("cat <<'A' <<'B'\nplain\nA\nsudo rm -rf /tmp/x\nB")).toEqual(["sudo"]);
	});

	test("an unquoted delimiter is not the shape this drops", async () => {
		// Quoting the delimiter is what proves the body expands nothing, so an
		// unquoted one keeps the body under scan, closer line included.
		expect(await flags("cat <<sudo\nbody\nsudo")).toEqual(["sudo"]);
		expect(await flags("cat > /tmp/f <<EOF\nsudo rm -rf /tmp/x\nEOF")).toEqual(["sudo"]);
	});

	test("a body the command executes keeps its backstop", async () => {
		expect(await flags(doc("bash", "rm -rf /tmp/build/*"))).toEqual(["rm"]);
		expect(await flags(doc("sh -s", "sudo chown root /etc/hosts"))).toEqual(["sudo"]);
		// Visible plain code still releases: the classifier read the payload.
		expect(await flags(doc("python3 -", "print(1)", "'PY'"))).toEqual([]);
	});

	// Issues #60/#61: quote-state shapes the plain tokenizer mis-closes, which
	// let every later command vanish from the risk scan. The mask blanks
	// heredoc bodies and ANSI-C / unclosed-quote spans before tokenizing and
	// scans each blanked region as its own unit.
	test("an unbalanced quote in a heredoc body does not hide later commands (#60)", async () => {
		// The `"` is body data; before the mask it opened a phantom quote that
		// swallowed the closer and the real command after it.
		expect(await flags("bash <<'EOF'\n\"\nEOF\nsudo rm -rf /tmp/x")).toEqual(["sudo"]);
	});

	test("a nested heredoc carrying an unbalanced quote stays under scan (#60)", async () => {
		expect(await flags("bash <<'OUT'\ncat <<'IN'\n\"\nIN\nrm -rf /tmp/x\nOUT")).toContain("rm");
	});

	test("an ANSI-C quote spanning lines does not hide the destructive tail (#61)", async () => {
		// bash parses $'prefix \' as an open ANSI-C string (\' is an escaped
		// quote) across the next lines; the plain tokenizer closed at the
		// apostrophe and never saw the sudo.
		expect(await flags("printf $'prefix \\'\ncat > /tmp/f <<'EOF'\n'\nsudo chown root /etc/hosts\nEOF")).toEqual(["sudo"]);
	});

	test("an unclosed plain quote blanked by the mask still scans its content", async () => {
		// The unclosed quote's span moves to the quoted-piece scan, so the
		// risk verb inside it flags rather than vanishing.
		expect(await flags("echo 'it never closes\nsudo rm -rf /tmp/x")).toEqual(["sudo"]);
	});
});
