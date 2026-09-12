import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
	ALLOW_ONCE, ALLOW_SESSION, ALWAYS_ALLOW, DENY,
	fire, loadPlugin, makeCtx, makeEvent, makeSettings,
	modelCalls, refusalOf, selectCalls, setClassifierReply,
} from "./fixtures";

let dir = "";
let sequence = 0;
const session = () => `env-grants-${++sequence}`;
const storePath = () => path.join(dir, "omp-classifier-grants.json");
const command = "python3 script.py /safe";
const environment = { PATH: "/trusted/bin", NODE_ENV: "production" };

beforeEach(async () => {
	dir = fs.mkdtempSync(path.join(os.tmpdir(), "omp-env-grants-"));
	process.env.OMP_CLASSIFIER_CONFIG = path.join(dir, "omp-classifier.json");
	await loadPlugin(makeSettings([]));
	setClassifierReply("UNSAFE | needs approval");
});

afterEach(() => {
	fs.rmSync(dir, { recursive: true, force: true });
});

async function run(
	sessionId: string,
	env: Record<string, string> | undefined = environment,
	selectResult?: string,
	text = command,
	cwd = "/workspace",
) {
	const ctx = makeCtx({ sessionId, hasUI: true, selectResult, cwd });
	const result = await fire("tool_call", makeEvent(text, { env }), ctx);
	return { result, ctx };
}

function writeConfig(config: Record<string, unknown>): void {
	fs.writeFileSync(path.join(dir, "omp-classifier.json"), JSON.stringify(config));
}

test("an empty environment follows normal classification and shares the no-env cache", async () => {
	setClassifierReply("SAFE");
	const sid = session();
	const first = await run(sid, {}, undefined, "echo hi");
	expect(first.result).toBeUndefined();
	expect(selectCalls(first.ctx)).toHaveLength(0);
	expect(modelCalls).toHaveLength(1);
	const second = await fire("tool_call", makeEvent("echo hi"), makeCtx({ sessionId: sid }));
	expect(second).toBeUndefined();
	expect(modelCalls).toHaveLength(1);
});

for (const answer of [ALLOW_SESSION, ALWAYS_ALLOW]) {
	describe(answer, () => {
		test("identical environments reuse consent regardless of key order", async () => {
			const sid = session();
			expect((await run(sid, environment, answer)).result).toBeUndefined();
			const repeat = await run(answer === ALWAYS_ALLOW ? session() : sid, {
				NODE_ENV: "production", PATH: "/trusted/bin",
			});
			expect(repeat.result).toBeUndefined();
			expect(selectCalls(repeat.ctx)).toHaveLength(0);
			expect(modelCalls).toHaveLength(0);
		});

		test("changed values, keys, operands, case, or directory require fresh consent", async () => {
			const sid = session();
			expect((await run(sid, environment, answer)).result).toBeUndefined();
			const later = answer === ALWAYS_ALLOW ? session() : sid;
			const changes = [
				{ env: { ...environment, PATH: "/untrusted/bin" } },
				{ env: { PATH: "/trusted/bin" } },
				{ env: { ...environment, BASH_ENV: "/tmp/startup.sh" } },
				{ env: environment, text: "python3 script.py /sensitive" },
				{ env: environment, text: "python3 script.py /Safe" },
				{ env: environment, cwd: "/elsewhere" },
			];
			for (const change of changes) {
				const changed = await run(later, change.env, undefined, change.text, change.cwd);
				expect(refusalOf(changed.result).layer).toBe("dialog");
			}
		});

		test("grants cannot cross the environment boundary in either direction", async () => {
			const sid = session();
			expect((await run(sid, environment, answer)).result).toBeUndefined();
			const bare = await fire("tool_call", makeEvent(command), makeCtx({ sessionId: sid, hasUI: true }));
			expect(refusalOf(bare).layer).toBe("dialog");
			const other = "./bare.sh";
			expect(await fire("tool_call", makeEvent(other), makeCtx({
				sessionId: sid, hasUI: true, selectResult: answer,
			}))).toBeUndefined();
			expect(refusalOf((await run(sid, environment, undefined, other)).result).layer).toBe("dialog");
		});
	});
}

test("persistent consent survives reload without storing environment names or values", async () => {
	const secretEnv = { PRIVATE_ENV_TOKEN: "fake-secret-for-this-test" };
	expect((await run(session(), secretEnv, ALWAYS_ALLOW)).result).toBeUndefined();
	const stored = fs.readFileSync(storePath(), "utf8");
	expect(stored).not.toContain("PRIVATE_ENV_TOKEN");
	expect(stored).not.toContain("fake-secret-for-this-test");
	// Earlier readers of versions 1 and 2 discard restrictions they do not know.
	expect([1, 2]).not.toContain(JSON.parse(stored).version);
	await loadPlugin(makeSettings([]));
	const later = await run(session(), secretEnv);
	expect(later.result).toBeUndefined();
	expect(selectCalls(later.ctx)).toHaveLength(0);
});

test("legacy grants remain no-env-only after migration and a new grant write", async () => {
	fs.writeFileSync(storePath(), JSON.stringify({ version: 1, grants: [
		{ cmd: "./legacy.sh", cwd: "/workspace", ts: Date.now() },
	] }));
	expect((await run(session(), environment, ALWAYS_ALLOW)).result).toBeUndefined();
	await loadPlugin(makeSettings([]));
	setClassifierReply("UNSAFE | legacy grant must authorize this");
	expect(await fire("tool_call", makeEvent("./legacy.sh"), makeCtx({ sessionId: session() }))).toBeUndefined();
	expect(refusalOf((await run(session(), environment, undefined, "./legacy.sh")).result).layer).toBe("dialog");
});

test("malformed fingerprint fields never turn into legacy no-env authorizations", async () => {
	fs.writeFileSync(storePath(), JSON.stringify({ version: 1, grants: [
		{ cmd: command, cwd: "/workspace", ts: Date.now(), envFingerprint: 123 },
	] }));
	const result = await fire("tool_call", makeEvent(command), makeCtx({ sessionId: session(), hasUI: true }));
	expect(refusalOf(result).layer).toBe("dialog");
});

test("critical commands offer only one-shot consent and reject unavailable grants", async () => {
	for (const answer of [ALLOW_ONCE, ALLOW_SESSION, ALWAYS_ALLOW]) {
		const attempt = await run(session(), environment, answer, "rm -rf /");
		expect(selectCalls(attempt.ctx)[0][1].map(item => item.label)).toEqual([ALLOW_ONCE, DENY]);
		if (answer === ALLOW_ONCE) expect(attempt.result).toBeUndefined();
		else expect(refusalOf(attempt.result).layer).toBe("dialog");
	}
	expect(fs.existsSync(storePath())).toBe(false);
});

test("eval and disabled persistent grants reject an unoffered Always allow answer", async () => {
	const evalResult = await fire("tool_call", {
		toolName: "eval", input: { language: "js", code: "require('child_process').exec('ls')" },
	}, makeCtx({ sessionId: session(), hasUI: true, selectResult: ALWAYS_ALLOW }));
	expect(refusalOf(evalResult).layer).toBe("dialog");
	writeConfig({ persistentGrants: false });
	expect(refusalOf((await run(session(), environment, ALWAYS_ALLOW)).result).layer).toBe("dialog");
	expect(fs.existsSync(storePath())).toBe(false);
});

test("compound env commands offer persistent exact consent but no session shape grant", async () => {
	const compound = "python3 -m compileall -q . && godot --headless --import";
	const attempt = await run(session(), environment, ALLOW_SESSION, compound);
	expect(selectCalls(attempt.ctx)[0][1].map(item => item.label)).toEqual([ALLOW_ONCE, ALWAYS_ALLOW, DENY]);
	expect(refusalOf(attempt.result).layer).toBe("dialog");
	expect((await run(session(), environment, ALWAYS_ALLOW, compound)).result).toBeUndefined();
	expect((await run(session(), environment, undefined, compound)).result).toBeUndefined();
});

for (const env of [undefined, environment]) {
test(`persistent ${env ? "env" : "no-env"} grants distinguish extracted cd from an explicit working directory`, async () => {
	const text = "cd child && ./script.sh";
	const sid = session();
	const implicit = makeEvent(text, { env });
	const explicit = makeEvent(text, { env, cwd: "/workspace/child" });
	expect(await fire("tool_call", implicit, makeCtx({
		sessionId: sid, hasUI: true, selectResult: ALWAYS_ALLOW,
	}))).toBeUndefined();
	// The host strips cd only for implicit cwd. The explicit form enters child twice.
	expect(refusalOf(await fire("tool_call", explicit, makeCtx({
		sessionId: sid, hasUI: true,
	}))).layer).toBe("dialog");
	expect(await fire("tool_call", explicit, makeCtx({
		sessionId: sid, hasUI: true, selectResult: ALWAYS_ALLOW,
	}))).toBeUndefined();
	const later = makeCtx({ sessionId: session() });
	expect(await fire("tool_call", implicit, later)).toBeUndefined();
	expect(await fire("tool_call", explicit, later)).toBeUndefined();
});

test(`explicit-cwd ${env ? "env" : "no-env"} consent cannot authorize native extraction of a root cd`, async () => {
	const text = "cd / && ./script.sh";
	// The host's path resolver maps extracted '/' to the session cwd, while a
	// literal shell cd with structured cwd still enters the filesystem root.
	expect(await fire("tool_call", makeEvent(text, { env, cwd: "/workspace" }), makeCtx({
		sessionId: session(), hasUI: true, selectResult: ALWAYS_ALLOW,
	}))).toBeUndefined();
	expect(refusalOf(await fire("tool_call", makeEvent(text, { env }), makeCtx({
		sessionId: session(), hasUI: true,
	}))).layer).toBe("dialog");
});
}

for (const boundary of ["session_start", "session_shutdown", "config"]) {
	test(`${boundary} while consent is pending cannot resurrect a session grant`, async () => {
		const sid = session();
		const ctx = makeCtx({ sessionId: sid, hasUI: true });
		ctx.ui.select = async () => {
			if (boundary === "config") {
				writeConfig({ model: "changed-model" });
				await run(session(), environment, ALLOW_ONCE, "echo policy-change");
			} else {
				await fire(boundary, {}, makeCtx({ sessionId: sid }));
			}
			return ALLOW_SESSION;
		};
		// No env here: a stale grant is observable even on the old implementation.
		expect(await fire("tool_call", makeEvent(command), ctx)).toBeUndefined();
		const repeat = await fire("tool_call", makeEvent(command), makeCtx({ sessionId: sid, hasUI: true }));
		expect(refusalOf(repeat).layer).toBe("dialog");
	});
}

test("a live context switching sessions cannot send consent to the new session", async () => {
	const oldSession = session();
	const newSession = session();
	let liveSession = oldSession;
	const ctx = makeCtx({ sessionId: oldSession, hasUI: true });
	ctx.sessionManager.getSessionId = () => liveSession;
	ctx.ui.select = async () => {
		liveSession = newSession;
		return ALLOW_SESSION;
	};
	expect(await fire("tool_call", makeEvent(command), ctx)).toBeUndefined();
	expect(await fire("tool_call", makeEvent(command), makeCtx({ sessionId: oldSession }))).toBeUndefined();
	const result = await fire("tool_call", makeEvent(command), makeCtx({ sessionId: newSession, hasUI: true }));
	expect(refusalOf(result).layer).toBe("dialog");
});
