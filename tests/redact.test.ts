/**
 * Secret-shaped values are redacted before any text enters a judge state
 * (plan `docs/plans/2026-09-19-intent-aware-judgment.md`, Phase 2 step 7,
 * policy jev-v2.2). Tool results used to reach TypeSafe at up to 700
 * characters each, keys included.
 */
import { describe, expect, test } from "bun:test";
import { buildAuthorizationState, summarizeActions } from "../authorization";
import { collectTaskEvidence, collectTaskEvidenceV3, collectToolEvidence, collectUserEvidence, operatorContextFromInput } from "../index";
import { buildJevState, JEV_POLICY_VERSION } from "../jev";
import { isSecretName, REDACTED, redactSecrets, redactValue } from "../redact";

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

	test("no header or quoting grammar is left to miss (Codex round 3)", () => {
		const aws = "Authorization: AWS4-HMAC-SHA256 Credential=AKIDEXAMPLE/20260922/us-east-1/s3/aws4_request, SignedHeaders=host, Signature=fe5f80f77d5fa3beca038a248ff027d0445342fe2855ddc963176630326f1024";
		expect(redactSecrets(aws)).toBe(`Authorization: ${REDACTED}`);
		expect(redactSecrets('DB_PASSWORD="hunter2')).toBe(`DB_PASSWORD=${REDACTED}`);
		expect(redactSecrets("export DB_PASSWORD=hunter2\nnext line")).toBe(`export DB_PASSWORD=${REDACTED}\nnext line`);
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
			[`{"db_pwd": "x"}`, `"x"`],
			[`{"pwd": "x"}`, `"x"`],
		];
		for (const [text, secret] of cases) {
			const out = redactSecrets(text);
			expect(out).not.toContain(secret);
			expect(out).toContain(REDACTED);
			expect(redactSecrets(out)).toBe(out);
		}
		// Everything after the marker goes, by design: a URL query loses its
		// later parameters, and a user's "Authorization:" line loses its words.
		expect(redactSecrets(`https://x.test/cb?token=${opaque}&page=2`)).toBe(`https://x.test/cb?token=${REDACTED}`);
		expect(redactSecrets("Authorization: I approve the deploy to staging")).toBe(`Authorization: ${REDACTED}`);
		expect(redactSecrets(`Authorization: ApiKey ${opaque}`)).toBe(`Authorization: ${REDACTED}`);
	});

	test("an escaped quote can't end a quoted secret early, and Digest params go whole (Codex round 2)", () => {
		const escaped = JSON.stringify({ password: 'hunter"secondhalf123' });
		expect(redactSecrets(escaped)).not.toContain("secondhalf123");
		const digest = 'Authorization: Digest username="Mufasa", realm="testrealm@host.com", nonce="abcdef0123456789"';
		const out = redactSecrets(digest);
		expect(out).toBe(`Authorization: ${REDACTED}`);
		// The cost, stated: a secret-named value takes the rest of its line.
		expect(redactSecrets('{"password":"x","user":"bob"}')).toBe(`{"password":${REDACTED}`);
	});

	test("structured values lose everything under a secret key, whatever its content", () => {
		const args = { command: "curl https://x.test", headers: { Authorization: 'Digest username="a", nonce="b"', "x-api-key": 'we"ird' }, env: { DB_PASSWORD: 'p"w' }, list: [SECRETS.github] };
		const out = JSON.stringify(redactValue(args));
		for (const leak of ["username", "we\\\"ird", "p\\\"w", SECRETS.github]) expect(out).not.toContain(leak);
		expect(out).toContain("curl https://x.test");
	});

	test("text and structure share one marker vocabulary (fresh gate round 1)", () => {
		// Every key the structural pass blanks also redacts as text: the class was
		// a name one side knew and the other did not.
		for (const key of ["Authorization", "Proxy-Authorization", "Cookie", "Set-Cookie", "api_key", "x-api-key", "DB_PASSWORD", "client_secret", "GH_TOKEN", "private_key"]) {
			expect(JSON.stringify(redactValue({ [key]: "opaque-value-1" }))).not.toContain("opaque-value-1");
			expect(redactSecrets(`${key}: opaque-value-1`)).toBe(`${key}: ${REDACTED}`);
		}
		expect(redactSecrets("Set-Cookie: session=opaque-session-value; HttpOnly")).toBe(`Set-Cookie: ${REDACTED}`);
	});

	test("every secret-variable name the floor knows is redacted too (#110 gate round 2)", () => {
		// The floor's list is *_KEY, *_TOKEN, *_SECRET, *PASSWORD*, *PASSPHRASE*.
		for (const name of ["DJANGO_SECRET_KEY", "SSH_PASSPHRASE", "SSH_PASSPHRASE_FILE", "DB_PASSWORD_HASH", "AWS_SECRET_ACCESS_KEY", "STRIPE_API_KEY", "GH_TOKEN", "DB_PASSWORD", "GOOGLE_CREDENTIALS", "SIGNING_KEY"]) {
			// The floor and redaction ask the same predicate (#112 gate round 1).
			expect(isSecretName(name)).toBe(true);
			expect(redactSecrets(`${name}=hunter2`)).toBe(`${name}=${REDACTED}`);
			expect(JSON.stringify(redactValue({ [name]: "hunter2" }))).not.toContain("hunter2");
		}
		// camelCase and glued names, which a separator-only rule dropped
		// (security review of 05e4115).
		for (const text of ['{"accessToken": "abc123xyz"}', '{"clientSecret":"s3cr3tvalue"}', "AUTHTOKEN=abcdef123", '{"privateKey":"xyzxyz"}', "ghtoken=abcdef", '{"openaiApiKey":"k"}']) {
			expect(redactSecrets(text)).toContain(REDACTED);
		}
		for (const name of ["accessToken", "refreshToken", "privateKey", "sshKey", "clientSecret"]) {
			expect(JSON.stringify(redactValue({ [name]: "hunter2" }))).not.toContain("hunter2");
		}
		for (const name of ["maxTokens", "monkey", "PWD", "OLDPWD", "KEY", "turkey"]) expect(isSecretName(name)).toBe(false);
		for (const name of ["pwd", "mypwd", "USERPWD", "db_pwd", "Pwd"]) expect(isSecretName(name)).toBe(true);
		// A secret word anywhere among the name's words (#110 gate round 4).
		for (const name of ["CLIENT_SECRET_VALUE", "PRIVATE_KEY_PEM", "GH_TOKEN_FILE", "api_key_id", "sshKeyPath", "db.credentials.path"]) expect(isSecretName(name)).toBe(true);
		for (const text of ["CLIENT_SECRET_VALUE=sample_value", "PRIVATE_KEY_PEM=sample_value"]) expect(redactSecrets(text)).not.toContain("sample_value");
		expect(JSON.stringify(redactValue({ CLIENT_SECRET_VALUE: "sample_value", PRIVATE_KEY_PEM: "sample_value" }))).not.toContain("sample_value");
		// The cost, stated: a usage setting named with `token` redacts too.
		expect(redactSecrets("TOKEN_LIMIT=4096")).toBe(`TOKEN_LIMIT=${REDACTED}`);
		// A path without a secret word reads normally (#114 gate round 1).
		expect(redactSecrets("src/auth/authorization.ts:12: const x")).toBe("src/auth/authorization.ts:12: const x");
		for (const text of ["client.secret.json=hunter2", "token.ts: hunter2", "APITokenFile=hunter2", "JWTTokenValue=hunter2", "SSHKeyPath=hunter2"]) {
			expect(redactSecrets(text)).not.toContain("hunter2");
		}
		expect(JSON.stringify(redactValue({ "client.secret.json": "hunter2", APITokenFile: "hunter2", SSHKeyPath: "hunter2" }))).not.toContain("hunter2");
		// A header word inside a longer name is the user's words, not a header.
		expect(redactSecrets("authorization_status: approved by user")).toBe("authorization_status: approved by user");
		// Prefixed headers, dotted config keys, and all-caps glued names.
		for (const text of ['-H "X-Authorization: VAL123x"', "aws.pwd=VAL123x", "MYPRIVATEKEY=VAL123x", "spring.datasource.password: VAL123x"]) {
			expect(redactSecrets(text)).not.toContain("VAL123x");
		}
		// Usage counts and plain words stay readable.
		for (const text of ["max_tokens: 1024", "input_tokens=528", "key: value", "monkey: banana"]) expect(redactSecrets(text)).toBe(text);
	});

	test("a secret flag with its value after a space is redacted; --password-stdin is not a value", () => {
		expect(redactSecrets("mysql -u root --password hunter2 -e 'select 1'")).toBe(`mysql -u root --password ${REDACTED}`);
		expect(redactSecrets("curl --api-key $KEY https://x.test")).toBe(`curl --api-key ${REDACTED}`);
		// At the start of the text or of a line too (key 102 round 2).
		expect(redactSecrets("--password hunter2")).toBe(`--password ${REDACTED}`);
		expect(redactSecrets("--api-key opaque-value-1")).toBe(`--api-key ${REDACTED}`);
		expect(redactSecrets("ok\n--password hunter2\nnext")).toBe(`ok\n--password ${REDACTED}\nnext`);
		// A name with `password` in it is secret anywhere (the floor's rule), so
		// `--password-stdin` takes the rest of its line too: over-redaction, the
		// safe direction. `$PWD` is the working directory, never a secret.
		expect(redactSecrets("echo $T | docker login --password-stdin registry.example.com")).toBe(`echo $T | docker login --password-stdin ${REDACTED}`);
		expect(redactSecrets("PWD=/home/you/project")).toBe("PWD=/home/you/project");
	});

	test("a PGP private key block is redacted whole", () => {
		const body = fake("", 64);
		const pgp = `-----BEGIN PGP PRIVATE KEY BLOCK-----\n\n${body}\n-----END PGP PRIVATE KEY BLOCK-----`;
		expect(redactSecrets(`gpg: ${pgp} done`)).toBe(`gpg: ${REDACTED} done`);
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
			"max_tokens: 1024",
			"src/auth/session.ts:12: export function readSession()",
			"key: value",
			"password reset flow",
			"https://github.com/acme/repo.git",
		].join("\n");
		expect(redactSecrets(text)).toBe(text);
	});

	test("redaction runs in linear time on hostile input (security review of 4a960c0)", () => {
		// Evidence is redacted before it is cut, so input size is unbounded.
		// Each shape below was quadratic before: a name or URL scheme matched
		// from every "." boundary, and an acronym split backtracked a run of
		// capitals. 400k characters took minutes; each now runs in milliseconds.
		for (const hostile of ["a.".repeat(200_000), `${"A".repeat(200_000)}=x`, `${"a.".repeat(200_000)}b`, "a:".repeat(100_000), " --a".repeat(100_000)]) {
			const started = performance.now();
			redactSecrets(hostile);
			expect(performance.now() - started).toBeLessThan(500);
		}
	});

	test("no grep-path exemption: the shape is ambiguous, so it redacts (#114 gate round 2)", () => {
		// `client.secret.json:12:hunter2` is a grep hit or a secret, and no rule
		// can tell which. Every shape with a secret word redacts; the cost is a
		// grep hit on a secret-named file loses the rest of its line.
		for (const text of ["client.secret.json:12:hunter2", "DB_PASSWORD:12:hunter2", "aws.password:12:hunter2", "a.b.pwd:12:hunter2"]) {
			expect(redactSecrets(text)).not.toContain("hunter2");
		}
		expect(redactSecrets("src/auth/token.ts:12: export function readToken()")).toBe(`src/auth/token.ts:${REDACTED}`);
		expect(redactSecrets("config.env:12:API_KEY=hunter2")).not.toContain("hunter2");
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
		// headAndTail keeps the first 1,000 characters: 982 + 1 + 17 puts the
		// cut right after `DB_PASSWORD=hunte`, inside the value.
		const long = `${"a".repeat(982)} DB_PASSWORD=hunter2 ${"b".repeat(2_000)}`;
		expect(long.slice(0, 1_000).endsWith("DB_PASSWORD=hunte")).toBe(true);
		const snapshot = collectTaskEvidence([{ type: "message", id: "m1", message: { role: "user", attribution: "user", content: long } }], 1);
		expect(snapshot.messages[0]).not.toContain("hunte");
		expect(collectUserEvidence([{ type: "message", message: { role: "user", attribution: "user", content: long } }], 1)[0]).not.toContain("hunte");
		const context = operatorContextFromInput(`${"c".repeat(480)} DB_PASSWORD=hunter2 tail`);
		expect(context).not.toContain("hunte");
		// The jev-v3 builder (#101) cuts the same way, pinned message included.
		const v3 = collectTaskEvidenceV3([{ type: "message", id: "m1", message: { role: "user", attribution: "user", content: long } }, ...Array.from({ length: 10 }, (_, i) => ({ type: "message", id: `r${i}`, message: { role: "user", attribution: "user", content: `ok ${i}` } }))], 1);
		expect(v3.pinned?.text).not.toContain("hunte");
		expect(v3.messages.join(" ")).not.toContain("hunte");
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
		// The redaction change landed as jev-v2.2; the version has moved on with
		// later changes to what a state means (the measured git tiers), which is
		// the point of pinning it: a state read under one version means
		// something else under the next.
		expect(JEV_POLICY_VERSION).toBe("jev-v2.9");
	});
});
