/**
 * Refusal memory across rewording (issue #30): a command this session refused
 * — an UNSAFE verdict, a critical pattern, a cap — is remembered by
 * normalizeActionTarget, the strict action identity (issue #64: refusal memory
 * keyed by the first two words made `ssh <host>` one session-length trip
 * wire), injected into the next state as priorRefusal, and a SAFE that lands
 * anyway on a refused target still blocks. The user's own words lift it
 * (tests/never-prompts.test.ts); the store holds 20 targets per session,
 * oldest dropped.
 *
 * The trigger moved with the port: a text judge's refusal-shaped prose no
 * longer exists, so memory keys off the VERDICT. UNSAFE is the only verdict
 * that both judged the content and said no — UNSURE is undecided, and
 * UNAVAILABLE judged nothing at all, so neither is evidence about the command.
 *
 * Unique sessions per test — the module-level refusal store outlives a test.
 */
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { normalizeActionTarget } from "../index";
import type { DecisionRecord } from "../index";
import {
	fire,
	jevSafeAnswer,
	jevUnsureAnswer,
	jevUnsafeAnswer,
	loadPlugin,
	makeCtx,
	makeEvent,
	makeSettings,
	modelCalls,
	refusalOf,
	setJevAnswer,
	setJevAnsweringApi,
	stateOf,
	removeConfigFile,
} from "./fixtures";

let dir = "";
let seq = 0;

const decisionsPath = (): string => path.join(dir, "decisions.jsonl");

const readDecisions = (): DecisionRecord[] =>
	fs
		.readFileSync(decisionsPath(), "utf8")
		.split("\n")
		.filter(line => line.trim() !== "")
		.map(line => JSON.parse(line) as DecisionRecord);

beforeEach(async () => {
	removeConfigFile();
	dir = fs.mkdtempSync(path.join(os.tmpdir(), "omp-refusal-"));
	process.env.OMP_JEV_CONFIG = path.join(dir, "omp-classifier.json");
	await loadPlugin(makeSettings([]));
	setJevAnswer(jevSafeAnswer());
});

afterEach(() => {
	fs.rmSync(dir, { recursive: true, force: true });
});

/** Fresh session id per test; the plugin's stores are module-level. */
const nextSession = (): string => `refusal-memory-${(seq += 1)}`;

/** The prior-refusal field of one captured request's state, if it carried one. */
const priorRefusalOf = (callIndex: number): { target: string; why: string; when: string } | undefined =>
	stateOf(callIndex).priorRefusal as { target: string; why: string; when: string } | undefined;

describe("refusal identity (issue #64)", () => {
	// The old key kept the first two non-flag words, so every `ssh raw-ovh …`
	// was ONE target — "ssh raw-ovh" — whatever ran behind it, and refusing one
	// remote cleanup turned every later read of that host into a dialog for the
	// rest of the session (152 logged blocks carried `prior refusal`). Refusals
	// now key on normalizeActionTarget, so an approval lifts exactly what a
	// refusal covers.
	test("one host's operations are separate targets", () => {
		expect(normalizeActionTarget("ssh raw-ovh 'mysql --version'")).toBe("ssh --version' raw-ovh");
		expect(normalizeActionTarget("ssh raw-ovh 'wp db delete --all'")).toBe("ssh --all' raw-ovh");
		expect(normalizeActionTarget("ssh raw-ovh 'mysql --version'")).not.toBe(
			normalizeActionTarget("ssh raw-ovh 'wp db delete --all'"),
		);
		// A different host is a different target, and so is a read-only probe
		// of the same one.
		expect(normalizeActionTarget("ssh raw-ovh 'ls /tmp'")).not.toBe(normalizeActionTarget("ssh slurper 'ls /tmp'"));
		expect(normalizeActionTarget("ssh raw-ovh 'ls /tmp'")).not.toBe(
			normalizeActionTarget("ssh raw-ovh 'grep -o RUSH_INTAKE_KEY /var/www/html/wp-config.php'"),
		);
	});

	test("rewordings of one action still share a target; unlike actions differ", () => {
		expect(normalizeActionTarget("RM   -RF\t./X")).toBe(normalizeActionTarget("rm -rf x"));
		expect(normalizeActionTarget("rm -rf ./x")).toBe(normalizeActionTarget("rm -rf x"));
		expect(normalizeActionTarget("cd /tmp && rm -rf x")).toBe(normalizeActionTarget("rm -rf x"));
		// Dropping a flag is a different action here.
		expect(normalizeActionTarget("rm -rf x")).not.toBe(normalizeActionTarget("rm x"));
		expect(normalizeActionTarget("rm -rf x")).not.toBe(normalizeActionTarget("git reset --hard"));
	});

	test("the identity keeps the first argument: a push's remote is in, its branch is not", () => {
		// The action identity keeps flags and the FIRST non-flag argument, so
		// `origin` scopes a push and the branch behind it does not. That is
		// deliberate, and it is the reason branch-level provenance is
		// issue #63's work, not refusal memory's. Without a remote, the branch
		// IS the first argument and separates two targets.
		expect(normalizeActionTarget("git push --force origin main")).toBe("git push --force origin");
		expect(normalizeActionTarget("git push --force origin main")).toBe(normalizeActionTarget("git push --force origin feature"));
		expect(normalizeActionTarget("git push --force main")).not.toBe(normalizeActionTarget("git push --force feature"));
	});
});

describe("refusal memory", () => {
	test("a Git refusal does not carry over to a different branch", async () => {
		const sid = nextSession();
		setJevAnswer(jevUnsafeAnswer());
		await fire("tool_call", makeEvent("git push origin main"), makeCtx({ sessionId: sid }));
		setJevAnswer(jevSafeAnswer());
		await fire("tool_call", makeEvent("git push origin feature"), makeCtx({ sessionId: sid }));
		expect(modelCalls.length).toBe(2);
		expect(priorRefusalOf(1)).toBeUndefined();
	});

	test("a Git refusal does not carry over to a differently-cased ref", async () => {
		// `release..main` and `Release..main` can name different refs, so the key
		// keeps case. Lowercasing them into one identity would let a refusal for
		// one weigh on the other.
		const sid = nextSession();
		setJevAnswer(jevUnsafeAnswer());
		await fire("tool_call", makeEvent("git diff release..main"), makeCtx({ sessionId: sid }));
		setJevAnswer(jevSafeAnswer());
		await fire("tool_call", makeEvent("git diff Release..main"), makeCtx({ sessionId: sid }));
		expect(modelCalls.length).toBe(2);
		expect(priorRefusalOf(1)).toBeUndefined();
	});

	test("a wrapped Git command is keyed on the git command it wraps", async () => {
		// `command git diff …` normalizes to the broad `command git` identity
		// under the plain action rule, which would make one refusal cover every wrapped
		// git command in the session. The key looks through the wrapper instead.
		const sid = nextSession();
		setJevAnswer(jevUnsafeAnswer());
		await fire("tool_call", makeEvent("command git diff release..main"), makeCtx({ sessionId: sid }));
		setJevAnswer(jevSafeAnswer());
		await fire("tool_call", makeEvent("command git diff feature..main"), makeCtx({ sessionId: sid }));
		expect(modelCalls.length).toBe(2);
		expect(priorRefusalOf(1)).toBeUndefined();
	});

	test("reworded command carries priorRefusal into the state", async () => {
		const sid = nextSession();
		setJevAnswer(jevUnsafeAnswer());
		await fire("tool_call", makeEvent("rm -rf x"), makeCtx({ sessionId: sid }));
		expect(modelCalls.length).toBe(1);
		setJevAnswer(jevUnsafeAnswer());
		await fire("tool_call", makeEvent("rm -rf ./x"), makeCtx({ sessionId: sid }));
		expect(modelCalls.length).toBe(2);
		const prior = priorRefusalOf(1);
		expect(prior?.target).toBe("rm -f -r x");
		// The stored why is the refusal's machine reason, not model prose: with
		// no text reply there is nothing else it could be.
		expect(prior?.why).toContain("unsafe 0.96");
		expect(new Date(prior?.when ?? "").getTime()).toBeGreaterThan(0);
		// The first, unrefused classification carries no such field.
		expect(priorRefusalOf(0)).toBeUndefined();
	});

	test("a one-hot UNSAFE asks but is not remembered as a refusal (jev-v2.1)", async () => {
		// The keyword bridge answers 0/1 with no distribution behind it. Its
		// UNSAFE still asks; it must not pin the target for the session.
		const sid = nextSession();
		setJevAnsweringApi("chat");
		setJevAnswer(jevUnsafeAnswer());
		await fire("tool_call", makeEvent("rm -rf x"), makeCtx({ sessionId: sid }));
		setJevAnsweringApi();
		setJevAnswer(jevUnsafeAnswer());
		await fire("tool_call", makeEvent("rm -rf ./x"), makeCtx({ sessionId: sid }));
		expect(modelCalls.length).toBe(2);
		expect(priorRefusalOf(1)).toBeUndefined();
	});

	test("an UNSURE verdict is undecided, so it is not remembered as a refusal", async () => {
		// An undecided judgement is not evidence about the command. If it were
		// remembered, a single ambiguous verdict would pin every rewording of
		// that target to a dialog for the rest of the session.
		const sid = nextSession();
		setJevAnswer(jevUnsureAnswer());
		await fire("tool_call", makeEvent("git diff --stat"), makeCtx({ sessionId: sid }));
		setJevAnswer(jevSafeAnswer());
		// The same target, respelled: had the UNSURE written a refusal, this
		// would meet it.
		await fire("tool_call", makeEvent("cd /workspace && git diff --stat"), makeCtx({ sessionId: sid }));
		expect(priorRefusalOf(1)).toBeUndefined();
	});

	test("an UNAVAILABLE verdict judged nothing, so it is not remembered either", async () => {
		const sid = nextSession();
		setJevAnswer(jevUnsureAnswer());
		await fire("tool_call", makeEvent("git diff --stat"), makeCtx({ sessionId: sid }));
		setJevAnswer(jevSafeAnswer());
		const ctx = makeCtx({ sessionId: sid });
		expect(await fire("tool_call", makeEvent("cd /workspace && git diff --stat"), ctx)).toBeUndefined();
		expect(priorRefusalOf(1)).toBeUndefined();
	});

	test("a SAFE that lands despite a prior refusal still blocks", async () => {
		const sid = nextSession();
		const ctx = makeCtx({ sessionId: sid, hasUI: true });
		setJevAnswer(jevUnsafeAnswer());
		await fire("tool_call", makeEvent("echo bye"), ctx);
		// echo is not a moderate-risk token, so without the refusal memory a
		// SAFE here would auto-run; the block proves the refusal decided.
		setJevAnswer(jevSafeAnswer());
		const result = await fire("tool_call", makeEvent("echo bye again"), ctx);
		expect(refusalOf(result).layer).toBe("prior-refusal");
		expect(readDecisions().some(line => line.why.includes("despite prior model refusal"))).toBe(true);
	});

	test("machine refusals are scoped to the reviewed directory", async () => {
		const sid = nextSession();
		setJevAnswer(jevUnsafeAnswer());
		await fire("tool_call", makeEvent("git diff --stat"), makeCtx({ sessionId: sid, cwd: "/workspace" }));

		// The same target, in another directory: a different review.
		setJevAnswer(jevSafeAnswer());
		const elsewhere = makeCtx({ sessionId: sid, cwd: "/elsewhere" });
		const result = await fire("tool_call", makeEvent("cd /elsewhere && git diff --stat"), elsewhere);
		expect(result).toBeUndefined();
		expect(modelCalls.length).toBe(2);
	});

	test("store caps at 20 per session and drops the oldest", async () => {
		const sid = nextSession();
		setJevAnswer(jevUnsafeAnswer());
		for (let i = 1; i <= 21; i++) {
			await fire(
				"tool_call",
				makeEvent(`rm -rf f${String(i).padStart(2, "0")}`),
				makeCtx({ sessionId: sid }),
			);
		}
		setJevAnswer(jevUnsafeAnswer());
		// Oldest target (rm -f -r f01) was evicted: its rewording classifies bare.
		await fire("tool_call", makeEvent("rm -r -f f01"), makeCtx({ sessionId: sid }));
		expect(priorRefusalOf(21)).toBeUndefined();
		// Newest target (rm -f -r f21) is still remembered.
		await fire("tool_call", makeEvent("rm -r -f f21"), makeCtx({ sessionId: sid }));
		const prior = priorRefusalOf(22);
		expect(prior?.target).toBe("rm -f -r f21");
	});
});

describe("refusal identity at the gate (issue #64)", () => {
	test("a refusal of one operation does not refuse the host's other operations", async () => {
		const sid = nextSession();
		setJevAnswer(jevUnsafeAnswer());
		await fire("tool_call", makeEvent("ssh raw-ovh 'wp db delete --all'"), makeCtx({ sessionId: sid }));

		// Same host, a read: judged on its own, with no refusal in the state the
		// judge saw, and nothing left to prompt about.
		setJevAnswer(jevSafeAnswer());
		const readOnly = makeCtx({ sessionId: sid });
		const result = await fire("tool_call", makeEvent("ssh raw-ovh 'ls /tmp'"), readOnly);
		expect(priorRefusalOf(1)).toBeUndefined();
		expect(result).toBeUndefined();
	});

	test("a refused container write does not refuse a read-only probe of it", async () => {
		const sid = nextSession();
		setJevAnswer(jevUnsafeAnswer());
		await fire(
			"tool_call",
			makeEvent("docker exec raw_wordpress sh -c 'mysql -e \"DELETE FROM wp_options\"'"),
			makeCtx({ sessionId: sid }),
		);

		setJevAnswer(jevSafeAnswer());
		const probe = makeCtx({ sessionId: sid });
		const result = await fire("tool_call", makeEvent("docker exec raw_wordpress php -r 'var_dump(get_option(\"siteurl\"));'"), probe);
		expect(priorRefusalOf(1)).toBeUndefined();
		expect(result).toBeUndefined();
	});

	test("two hosts are two targets", async () => {
		const sid = nextSession();
		setJevAnswer(jevUnsafeAnswer());
		await fire("tool_call", makeEvent("ssh raw-ovh 'ls /tmp'"), makeCtx({ sessionId: sid }));

		setJevAnswer(jevSafeAnswer());
		const other = makeCtx({ sessionId: sid });
		const result = await fire("tool_call", makeEvent("ssh slurper 'ls /tmp'"), other);
		expect(priorRefusalOf(1)).toBeUndefined();
		expect(result).toBeUndefined();
	});

	test("a refusal still matches the command re-run, shell whitespace aside", async () => {
		const sid = nextSession();
		setJevAnswer(jevUnsafeAnswer());
		await fire("tool_call", makeEvent("ssh raw-ovh 'wp db delete --all'"), makeCtx({ sessionId: sid }));

		setJevAnswer(jevSafeAnswer());
		// The same command again; the run of spaces collapses in a shell.
		const again = makeCtx({ sessionId: sid, hasUI: true });
		const result = await fire("tool_call", makeEvent("ssh raw-ovh  'wp db delete --all'"), again);
		expect(refusalOf(result).layer).toBe("prior-refusal");
		expect(priorRefusalOf(1)?.target).toBe("ssh raw-ovh wp db delete --all");
		// The refusal rode in the state, and a SAFE verdict is not a clean bill.
		expect(readDecisions().some(line => line.why.includes("prior refusal"))).toBe(true);
	});

	test("a remote command's refusal names its host, not a flag's value", async () => {
		// `-o BatchMode=yes` used to fill the first-argument slot, so every
		// `ssh -o BatchMode=yes <host>` shared one key whatever the host.
		const sid = nextSession();
		setJevAnswer(jevUnsafeAnswer());
		await fire("tool_call", makeEvent("ssh -o BatchMode=yes hosta 'ls /tmp'"), makeCtx({ sessionId: sid }));
		setJevAnswer(jevSafeAnswer());
		const result = await fire("tool_call", makeEvent("ssh -o BatchMode=yes hostb 'ls /tmp'"), makeCtx({ sessionId: sid }));
		expect(priorRefusalOf(1)).toBeUndefined();
		expect(result).toBeUndefined();
	});
});

describe("a remote copy's refusal survives a rewrite of the same copy", () => {
	// OMP session 01a188b8: the gate refused
	// `scp -o BatchMode=yes -q target/release/mlxtop studio-local:.local/bin/mlxtop.new`,
	// and the agent ran the same copy past the refusal by dropping `-q` and
	// spelling the destination from `/Users/<user>`. Neither changes what lands
	// where, so neither may change the refusal's key.
	const refused = "scp -o BatchMode=yes -q target/release/tool buildhost:.local/bin/tool.new";
	const rewrites: Array<[string, string]> = [
		["a dropped quiet flag and an absolute home path", `scp -o BatchMode=yes target/release/tool buildhost:${os.homedir()}/.local/bin/tool.new`],
		["a tilde path and no options", "scp target/release/tool buildhost:~/.local/bin/tool.new"],
		["a user@ prefix and a source spelled with ./", "scp -q ./target/release/tool me@buildhost:.local/bin/tool.new"],
		["rsync in place of scp", "rsync -az target/release/tool buildhost:.local/bin/tool.new"],
		["an rsync long option with its value as the next word", "rsync --bwlimit 100 --partial-dir .rsync-partial target/release/tool buildhost:.local/bin/tool.new"],
		["a remote home spelled for another user", "scp target/release/tool buildhost:/home/deploy/.local/bin/tool.new"],
	];

	for (const [name, rewrite] of rewrites) {
		test(`${name} still meets the refusal`, async () => {
			const sid = nextSession();
			setJevAnswer(jevUnsafeAnswer());
			await fire("tool_call", makeEvent(refused), makeCtx({ sessionId: sid }));
			setJevAnswer(jevSafeAnswer());
			const result = await fire("tool_call", makeEvent(rewrite), makeCtx({ sessionId: sid }));
			expect(priorRefusalOf(1)).toBeDefined();
			expect(refusalOf(result).layer).toBe("prior-refusal");
		});
	}

	test("a copy to another host or another file is a different target", async () => {
		const sid = nextSession();
		setJevAnswer(jevUnsafeAnswer());
		await fire("tool_call", makeEvent(refused), makeCtx({ sessionId: sid }));
		setJevAnswer(jevSafeAnswer());
		await fire("tool_call", makeEvent("scp target/release/tool otherhost:.local/bin/tool.new"), makeCtx({ sessionId: sid }));
		await fire("tool_call", makeEvent("scp target/release/tool buildhost:.local/bin/other.new"), makeCtx({ sessionId: sid }));
		expect(priorRefusalOf(1)).toBeUndefined();
		expect(priorRefusalOf(2)).toBeUndefined();
	});

	test("an ssh refusal survives a `--` before the remote command", async () => {
		const sid = nextSession();
		setJevAnswer(jevUnsafeAnswer());
		await fire("tool_call", makeEvent("ssh buildhost 'rm -f ~/.local/bin/tool'"), makeCtx({ sessionId: sid }));
		setJevAnswer(jevSafeAnswer());
		await fire("tool_call", makeEvent("ssh buildhost -- 'rm -f ~/.local/bin/tool'"), makeCtx({ sessionId: sid }));
		expect(priorRefusalOf(1)).toBeDefined();
	});

	test("a program named like an Object.prototype member is still remembered", async () => {
		// A plain-object lookup found `constructor` on the prototype, the key
		// threw, and addRefusal swallowed it: nothing was recorded.
		const sid = nextSession();
		setJevAnswer(jevUnsafeAnswer());
		await fire("tool_call", makeEvent("constructor -d prod"), makeCtx({ sessionId: sid }));
		setJevAnswer(jevSafeAnswer());
		// Respelled so the verdict cache misses and the judge sees the state.
		await fire("tool_call", makeEvent("constructor -d ./prod"), makeCtx({ sessionId: sid }));
		expect(priorRefusalOf(1)).toBeDefined();
	});

	test("an ssh refusal survives a dropped flag", async () => {
		const sid = nextSession();
		setJevAnswer(jevUnsafeAnswer());
		await fire("tool_call", makeEvent("ssh -q -o BatchMode=yes buildhost 'mv ~/.local/bin/tool.new ~/.local/bin/tool'"), makeCtx({ sessionId: sid }));
		setJevAnswer(jevSafeAnswer());
		await fire("tool_call", makeEvent("ssh buildhost 'mv ~/.local/bin/tool.new ~/.local/bin/tool'"), makeCtx({ sessionId: sid }));
		expect(priorRefusalOf(1)).toBeDefined();
	});
});

describe("a wrapper does not change what a refusal covers (https://github.com/STRML/omp-classifier/issues/200)", () => {
	// The key skipped wrapper words but not their arguments, so
	// `timeout 30 scp …` keyed on `timeout 30` and ran past the scp's refusal.
	const cases: Array<[string, string, string]> = [
		["timeout with a duration", "scp target/release/tool buildhost:.local/bin/tool.new", "timeout 30 scp target/release/tool buildhost:.local/bin/tool.new"],
		["timeout with options", "scp target/release/tool buildhost:.local/bin/tool.new", "timeout -k 5 --preserve-status 30s scp target/release/tool buildhost:.local/bin/tool.new"],
		["nice -n", "scp target/release/tool buildhost:.local/bin/tool.new", "nice -n 5 scp target/release/tool buildhost:.local/bin/tool.new"],
		["env with an assignment", "scp target/release/tool buildhost:.local/bin/tool.new", "env FOO=1 scp target/release/tool buildhost:.local/bin/tool.new"],
		["a bare assignment", "scp target/release/tool buildhost:.local/bin/tool.new", "FOO=1 scp target/release/tool buildhost:.local/bin/tool.new"],
		["stdbuf and nohup stacked", "rm -rf build", "nohup stdbuf -oL rm -rf build"],
		["a wrapped git command", "git branch -D topic", "timeout 10 git branch -D topic"],
	];

	for (const [name, refused, wrapped] of cases) {
		test(`${name} still meets the refusal`, async () => {
			const sid = nextSession();
			setJevAnswer(jevUnsafeAnswer());
			await fire("tool_call", makeEvent(refused), makeCtx({ sessionId: sid }));
			setJevAnswer(jevSafeAnswer());
			await fire("tool_call", makeEvent(wrapped), makeCtx({ sessionId: sid }));
			expect(priorRefusalOf(1)).toBeDefined();
		});
	}

	test("a refused wrapped command is keyed on what it wraps, so the bare retry meets it", async () => {
		const sid = nextSession();
		setJevAnswer(jevUnsafeAnswer());
		await fire("tool_call", makeEvent("timeout 30 ssh buildhost 'rm -f ~/tool'"), makeCtx({ sessionId: sid }));
		setJevAnswer(jevSafeAnswer());
		await fire("tool_call", makeEvent("ssh buildhost 'rm -f ~/tool'"), makeCtx({ sessionId: sid }));
		expect(priorRefusalOf(1)).toBeDefined();
	});

	test("two wrapped commands on different hosts are still two targets", async () => {
		const sid = nextSession();
		setJevAnswer(jevUnsafeAnswer());
		await fire("tool_call", makeEvent("timeout 30 ssh hosta 'ls /tmp'"), makeCtx({ sessionId: sid }));
		setJevAnswer(jevSafeAnswer());
		await fire("tool_call", makeEvent("timeout 30 ssh hostb 'ls /tmp'"), makeCtx({ sessionId: sid }));
		expect(priorRefusalOf(1)).toBeUndefined();
	});
});

describe("an output filter does not change what a refusal covers (https://github.com/STRML/omp-classifier/issues/203)", () => {
	// The key read `| tail -60` as the flags -6 -0, so `| tail -5` and the
	// bare command were three targets.
	const cases: Array<[string, string, string]> = [
		["another count", "./update.sh start 2>&1 | tail -60", "./update.sh start | tail -5"],
		["no filter", "./update.sh start | tail -60", "./update.sh start"],
		["another filter", "./update.sh start | tail -60", "./update.sh start | grep -i error"],
		["a filter added to the refused command", "rm -rf build", "rm -rf build | tail -5"],
		["a git command", "git push --force origin main | tail -5", "git push --force origin main"],
	];

	for (const [name, refused, retried] of cases) {
		test(`${name} still meets the refusal`, async () => {
			const sid = nextSession();
			setJevAnswer(jevUnsafeAnswer());
			await fire("tool_call", makeEvent(refused), makeCtx({ sessionId: sid }));
			setJevAnswer(jevSafeAnswer());
			await fire("tool_call", makeEvent(retried), makeCtx({ sessionId: sid }));
			expect(priorRefusalOf(1)).toBeDefined();
		});
	}

	test("a pipe into a program that is not an output filter stays its own target", async () => {
		const sid = nextSession();
		setJevAnswer(jevUnsafeAnswer());
		await fire("tool_call", makeEvent("./update.sh start | tail -60"), makeCtx({ sessionId: sid }));
		setJevAnswer(jevSafeAnswer());
		await fire("tool_call", makeEvent("./other.sh start | tail -60"), makeCtx({ sessionId: sid }));
		expect(priorRefusalOf(1)).toBeUndefined();
	});
});

describe("inline code is keyed on the code it runs", () => {
	// The key kept the interpreter and the first space-separated word, which
	// for `python -c "\nimport …` is a lone quote: one refused snippet
	// refused every later snippet, including the fix that dropped the rmtree.
	const refusedCopy = `python3 -c "\nimport shutil, pathlib\ndst = pathlib.Path('configs/x')\nif dst.exists(): shutil.rmtree(dst)\nshutil.copytree('src', dst)\n"`;
	const fixedCopy = `python3 -c "\nimport shutil, pathlib\ndst = pathlib.Path('configs/x')\nassert not dst.exists()\nshutil.copytree('src', dst)\n"`;

	const differ: Array<[string, string, string]> = [
		["python -c with the destructive line removed", refusedCopy, fixedCopy],
		["a venv python -c", `~/.venv/bin/python -c "\nimport os\nos.remove('a')\n"`, `~/.venv/bin/python -c "\nimport os\nprint(os.listdir('.'))\n"`],
		["a python heredoc", "python3 - <<'EOF'\nimport os\nos.remove('a')\nEOF", "python3 - <<'EOF'\nprint('ok')\nEOF"],
		["node -e", `node -e "require('fs').rmSync('out', {recursive: true})"`, `node -e "console.log(require('fs').readdirSync('.'))"`],
		["bash -c", `bash -c "rm -rf build"`, `bash -c "ls build"`],
		["inline code after a script run by the same interpreter", `python3 setup.py && python3 -c "import os; os.remove('a')"`, `python3 setup.py && python3 -c "print(1)"`],
	];
	for (const [name, refused, retried] of differ) {
		test(`${name}: other code is another target`, async () => {
			const sid = nextSession();
			setJevAnswer(jevUnsafeAnswer());
			await fire("tool_call", makeEvent(refused), makeCtx({ sessionId: sid }));
			setJevAnswer(jevSafeAnswer());
			await fire("tool_call", makeEvent(retried), makeCtx({ sessionId: sid }));
			expect(priorRefusalOf(1)).toBeUndefined();
		});
	}

	const same: Array<[string, string, string]> = [
		["the same code re-run", refusedCopy, refusedCopy],
		["the same code with other spacing", `bash -c "rm -rf build"`, `bash  -c  "rm -rf build"`],
		["the same code wrapped", `bash -c "rm -rf build"`, `timeout 30 bash -c "rm -rf build"`],
		["the same code piped into a filter", `bash -c "rm -rf build"`, `bash -c "rm -rf build" | tail -5`],
		["the same heredoc", "python3 - <<'EOF'\nimport os\nos.remove('a')\nEOF", "python3 - <<'EOF'\nimport os\nos.remove('a')\nEOF"],
		// A script's own -e or -c is its argument, and a heredoc after a script
		// is its input: the script is the target, as it always was.
		["a script with its own -e argument", "python3 deploy.py -e prod", "python3 deploy.py -e staging"],
		["a script with its own -c argument", "python3 deploy.py -c prod.yml", "python3 deploy.py -c staging.yml"],
		["a script fed a heredoc", "python3 deploy.py <<'EOF'\nprod\nEOF", "python3 deploy.py <<'EOF'\nstaging\nEOF"],
		["a script run with python's -E", "python3 -E deploy.py prod", "python3 -E deploy.py staging"],
	];
	// An exact repeat may answer from the verdict cache and never reach the
	// judge, so these check the outcome rather than the judged state.
	for (const [name, refused, retried] of same) {
		test(`${name} still meets the refusal`, async () => {
			const sid = nextSession();
			setJevAnswer(jevUnsafeAnswer());
			await fire("tool_call", makeEvent(refused), makeCtx({ sessionId: sid }));
			setJevAnswer(jevSafeAnswer());
			const result = await fire("tool_call", makeEvent(retried), makeCtx({ sessionId: sid }));
			expect(refusalOf(result).layer).not.toBeUndefined();
		});
	}
});

describe("refusal memory under changing words", () => {
	test("a model refusal stands when the user's words move in a UI session", async () => {
		const sid = nextSession();
		const userEntry = (content: string) => ({ type: "message", message: { role: "user", attribution: "user", content } });
		setJevAnswer(jevUnsafeAnswer());
		await fire("tool_call", makeEvent("rm -rf x"), makeCtx({ sessionId: sid, hasUI: true, branch: [userEntry("wipe the scratch build")] }));

		setJevAnswer(jevSafeAnswer());
		// New words reach the judge, but they do not erase the record: only words
		// that name the target can let one call past it (never-prompts.test.ts).
		const moved = makeCtx({ sessionId: sid, hasUI: true, branch: [userEntry("actually stop, keep the build")] });
		await fire("tool_call", makeEvent("rm -rf x"), moved);
		expect(priorRefusalOf(1)?.target).toBe("rm -f -r x");
	});

	test("agent-authored context cannot drop a model refusal", async () => {
		const sid = nextSession();
		setJevAnswer(jevUnsafeAnswer());
		await fire("tool_call", makeEvent("rm -rf x", { operatorContext: "wiping the scratch build" }), makeCtx({ sessionId: sid }));

		setJevAnswer(jevSafeAnswer());
		// Before https://github.com/STRML/omp-classifier/issues/184 a changed
		// operatorContext changed the evidence fingerprint and the refusal
		// stopped applying (https://github.com/STRML/omp-classifier/issues/189).
		await fire("tool_call", makeEvent("rm -rf x", { operatorContext: "keeping the build, cleaning logs" }), makeCtx({ sessionId: sid }));
		expect(priorRefusalOf(1)?.target).toBe("rm -f -r x");
	});
});
