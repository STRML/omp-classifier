/**
 * Secret-shaped values are redacted before any text enters a judge state
 * (plan `docs/plans/2026-09-19-intent-aware-judgment.md`, Phase 2 step 7,
 * policy jev-v2.2). Tool results used to reach TypeSafe at up to 700
 * characters each, keys included.
 */
import { describe, expect, test } from "bun:test";
import { buildAuthorizationState, summarizeActions } from "../authorization";
import { collectTaskEvidence, collectToolEvidence, collectUserEvidence, operatorContextFromInput } from "../index";
import { buildJevState, JEV_POLICY_VERSION } from "../jev";
import { REDACTED, redactSecrets, redactValue } from "../redact";

// Built at run time so no literal token shape sits in the repository.
const fake = (prefix: string, length: number, alphabet = "abcdefghijklmnopqrstuvwxyz0123456789"): string =>
	prefix + Array.from({ length }, (_, i) => alphabet[(i * 7 + 3) % alphabet.length]).join("");

const SECRETS: Record<string, string> = {
	anthropic: fake("sk-ant-api03-", 40),
	openai: fake("sk-proj-", 40),
	github: fake("ghp_", 36),
	githubFine: fake("github_pat_", 60),
	slack: fake("xoxb-", 40),
	aws: fake("AKIA", 16, "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567"),
	google: fake("AIza", 35),
	gitlab: fake("glpat-", 20),
	npm: fake("npm_", 36),
	jwt: `${fake("eyJ", 20)}.${fake("eyJ", 30)}.${fake("", 30)}`,
};

describe("redactSecrets", () => {
	test("known token formats are redacted wherever they appear", () => {
		for (const [name, secret] of Object.entries(SECRETS)) {
			const out = redactSecrets(`result for ${name}: ${secret} done`);
			expect(out).not.toContain(secret);
			expect(out).toContain(REDACTED);
			expect(out).toStartWith(`result for ${name}: `);
			expect(out).toEndWith(" done");
		}
	});

	test("an authorization header value is redacted, whatever the token looks like", () => {
		const token = fake("", 24);
		for (const text of [`-H "Authorization: Bearer ${token}"`, `authorization: Basic ${token}`, `Authorization: token ${token}`, `Bearer ${token}`]) {
			const out = redactSecrets(text);
			expect(out).not.toContain(token);
		}
	});

	test("a secret-named assignment or field keeps its name and loses its value", () => {
		const value = fake("", 20);
		const cases = [
			`OPENAI_API_KEY=${value}`,
			`export GH_TOKEN="${value}"`,
			`DB_PASSWORD='${value}'`,
			`{"api_key": "${value}"}`,
			`client_secret: ${value}`,
			`password=${value}`,
		];
		for (const text of cases) {
			const out = redactSecrets(text);
			expect(out).not.toContain(value);
			expect(out).toContain(REDACTED);
		}
		expect(redactSecrets(`OPENAI_API_KEY=${value}`)).toBe(`OPENAI_API_KEY=${REDACTED}`);
	});

	test("quoted, JSON-escaped and any-scheme credentials are redacted (Codex round 1)", () => {
		const basic = "dXNlcjpwYXNzd29yZA==";
		const opaque = fake("", 22);
		const cases: Array<[string, string]> = [
			[`{"Authorization":"Basic ${basic}"}`, basic],
			[`Authorization: ApiKey ${opaque}`, opaque],
			[`{"password":"abc;defgh"}`, "abc;defgh"],
			[`{"command":"curl -H \\"Authorization: Bearer ${opaque}\\""}`, opaque],
			[`{"command":"echo \\"password\\": \\"hunter2\\""}`, "hunter2"],
			[`PASSWORD=abc;defgh`, "abc;defgh"],
			[`{"pwd": "x"}`, `"x"`],
		];
		for (const [text, secret] of cases) {
			const out = redactSecrets(text);
			expect(out).not.toContain(secret);
			expect(out).toContain(REDACTED);
			expect(redactSecrets(out)).toBe(out);
		}
		// A URL query keeps its other parameters.
		expect(redactSecrets(`https://x.test/cb?token=${opaque}&page=2`)).toBe(`https://x.test/cb?token=${REDACTED}&page=2`);
		// Prose after the header name is a user's words, not a credential.
		const prose = "Authorization: I approve the deploy to staging";
		expect(redactSecrets(prose)).toBe(prose);
		expect(redactSecrets(`Authorization: ApiKey ${opaque}`)).toBe(`Authorization: ApiKey ${REDACTED}`);
	});

	test("an escaped quote can't end a quoted secret early, and Digest params go whole (Codex round 2)", () => {
		const escaped = JSON.stringify({ password: 'hunter"secondhalf123' });
		expect(redactSecrets(escaped)).not.toContain("secondhalf123");
		const digest = 'Authorization: Digest username="Mufasa", realm="testrealm@host.com", nonce="abcdef0123456789"';
		const out = redactSecrets(digest);
		expect(out).toBe(`Authorization: Digest ${REDACTED}`);
		// The cost, stated: a quoted secret runs to the last quote on its line.
		expect(redactSecrets('{"password":"x","user":"bob"}')).toBe(`{"password":"${REDACTED}"}`);
	});

	test("structured values lose everything under a secret key, whatever its content", () => {
		const args = { command: "curl https://x.test", headers: { Authorization: 'Digest username="a", nonce="b"', "x-api-key": 'we"ird' }, env: { DB_PASSWORD: 'p"w' }, list: [SECRETS.github] };
		const out = JSON.stringify(redactValue(args));
		for (const leak of ["username", "we\\\"ird", "p\\\"w", SECRETS.github]) expect(out).not.toContain(leak);
		expect(out).toContain("curl https://x.test");
	});

	test("a private key block is redacted whole", () => {
		const body = fake("", 64);
		const pem = `-----BEGIN OPENSSH PRIVATE KEY-----\n${body}\n${body}\n-----END OPENSSH PRIVATE KEY-----`;
		const out = redactSecrets(`cat id: ${pem} ok`);
		expect(out).not.toContain(body);
		expect(out).toBe(`cat id: ${REDACTED} ok`);
	});

	test("credentials in a URL lose the password and keep the host", () => {
		const password = fake("", 16);
		const out = redactSecrets(`git remote -v: https://sam:${password}@github.com/acme/repo.git`);
		expect(out).not.toContain(password);
		expect(out).toContain("github.com/acme/repo.git");
	});

	test("ordinary development text is left alone", () => {
		const text = [
			"commit 8574b96c0ffee1234567890abcdef1234567890ab",
			"[tool result bash hash=419a39187f6efc67]",
			"uuid 123e4567-e89b-12d3-a456-426614174000",
			"TOKEN_LIMIT=4096 max_tokens: 1024",
			"src/auth/token.ts: export function readToken()",
			"key: value",
			"password reset flow",
			"https://github.com/acme/repo.git",
		].join("\n");
		expect(redactSecrets(text)).toBe(text);
	});

	test("redaction is idempotent", () => {
		const once = redactSecrets(`x ${SECRETS.github} OPENAI_API_KEY=${fake("", 20)}`);
		expect(redactSecrets(once)).toBe(once);
	});
});

describe("redaction reaches every judge state", () => {
	const secret = SECRETS.anthropic;

	test("buildJevState redacts user messages and operator context but not the command", () => {
		const state = buildJevState({
			command: `curl -H "x-api-key: ${secret}" https://api.anthropic.com/v1/models`,
			workingDirectory: "/repo",
			userMessages: [`here is my key ${secret}`],
			operatorContext: `recent tool evidence (non-authorizing): [tool result bash] ${secret}`,
		}) as { command: string; evidence: { userMessages: string[]; operatorContext: string } };
		// The command is what is judged; hiding its key would hide the hazard.
		expect(state.command).toContain(secret);
		expect(state.evidence.userMessages[0]).not.toContain(secret);
		expect(state.evidence.operatorContext).not.toContain(secret);
	});

	test("buildAuthorizationState redacts user messages", () => {
		const state = buildAuthorizationState({ actions: [], userMessages: [`use ${secret}`] }) as { evidence: { userMessages: string[] } };
		expect(state.evidence.userMessages[0]).not.toContain(secret);
	});

	test("tool evidence is redacted before it is cut, so a secret at the cut never leaks half", () => {
		const padding = "x".repeat(680);
		const branch = [{ type: "message", message: { role: "toolResult", toolName: "bash", content: [{ type: "text", text: `${padding} ${secret} tail` }] } }];
		const evidence = collectToolEvidence(branch) ?? "";
		expect(evidence).not.toContain(secret.slice(0, 16));
	});

	test("user messages and operator context are redacted before they are cut", () => {
		// A cut through `DB_PASSWORD=hunter2` leaves `DB_PASSWORD=hunte`, which
		// no longer reads as a six-character value.
		const long = `${"a".repeat(990)} DB_PASSWORD=hunter2 ${"b".repeat(2_000)}`;
		const snapshot = collectTaskEvidence([{ type: "message", id: "m1", message: { role: "user", attribution: "user", content: long } }], 1);
		expect(snapshot.messages[0]).not.toContain("hunte");
		expect(collectUserEvidence([{ type: "message", message: { role: "user", attribution: "user", content: long } }], 1)[0]).not.toContain("hunte");
		const context = operatorContextFromInput(`${"c".repeat(480)} DB_PASSWORD=hunter2 tail`);
		expect(context).not.toContain("hunte");
	});

	test("an evidence hash covers the redacted text, so it can't verify a guessed password", () => {
		const result = (text: string) => [{ type: "message", message: { role: "toolResult", toolName: "bash", content: [{ type: "text", text }] } }];
		const hashOf = (text: string) => /hash=([0-9a-f]+)/u.exec(collectToolEvidence(result(text)) ?? "")?.[1];
		expect(hashOf("DB_PASSWORD=hunter2 ok")).toBe(hashOf("DB_PASSWORD=letmein9 ok"));
		const call = (command: string) => [{ type: "message", message: { role: "bashExecution", command, output: command } }];
		const hashes = (command: string) => [...(collectToolEvidence(call(command)) ?? "").matchAll(/hash=([0-9a-f]+)/gu)].map(m => m[1]);
		expect(hashes("export GH_TOKEN=aaaaaaaaaa")).toEqual(hashes("export GH_TOKEN=bbbbbbbbbb"));
	});

	test("a secret-shaped action target is redacted, not hashed", () => {
		const branch = SECRETS.github;
		const entry = summarizeActions({ command: `git branch -D ${branch}` }).find(action => action.kind === "branch-delete");
		expect(entry?.targets.join(" ")).not.toContain(branch);
		expect(entry?.targets).toContain(REDACTED);
	});

	test("the policy version marks the change", () => {
		expect(JEV_POLICY_VERSION).toBe("jev-v2.2");
	});
});
