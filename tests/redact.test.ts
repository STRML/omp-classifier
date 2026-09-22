/**
 * Secret-shaped values are redacted before any text enters a judge state
 * (plan `docs/plans/2026-09-19-intent-aware-judgment.md`, Phase 2 step 7,
 * policy jev-v2.2). Tool results used to reach TypeSafe at up to 700
 * characters each, keys included.
 */
import { describe, expect, test } from "bun:test";
import { buildAuthorizationState } from "../authorization";
import { collectToolEvidence } from "../index";
import { buildJevState, JEV_POLICY_VERSION } from "../jev";
import { REDACTED, redactSecrets } from "../redact";

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

	test("the policy version marks the change", () => {
		expect(JEV_POLICY_VERSION).toBe("jev-v2.2");
	});
});
