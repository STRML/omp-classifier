/**
 * Redaction gaps found by a read-only bug hunt of redact.ts: credentials in
 * `curl -u` and password flags, secret names with a digit or the short form
 * `PASS`, published token shapes with no rule, `aws configure set`, a URL
 * password that contains `@`, secrets in argv arrays and name/value pairs, and
 * a redactor that cut from the first secret to the end of the line and so
 * erased the rest of a shell command from the audit log and from the text the
 * stage 2 reviewer reads.
 *
 * Every secret here is an obviously fake one (hunter2, zeros). Token shapes are
 * built at run time so no literal key shape sits in the repository.
 */
import { describe, expect, test } from "bun:test";
import { renderReviewerInput, type ReviewerInput } from "../reviewer";
import { isSecretName, REDACTED, redactSecrets, redactValue } from "../redact";

const fake = (prefix: string, length: number, alphabet = "abcdefghijklmnopqrstuvwxyz0123456789"): string =>
	prefix + Array.from({ length }, (_, i) => alphabet[(i * 7 + 3) % alphabet.length]).join("");

/** Redaction leaves a second pass nothing to change. */
const redacts = (text: string, expected: string): void => {
	const out = redactSecrets(text);
	expect(out).toBe(expected);
	expect(redactSecrets(out)).toBe(out);
};

/** The text comes back as it went in. */
const untouched = (text: string): void => redacts(text, text);

describe("credentials in curl -u and password flags", () => {
	test("curl -u, --user and the attached -uuser:pass lose the password and keep the user", () => {
		redacts("curl -u bob:hunter2 https://api.example.com/x", `curl -u bob:${REDACTED} https://api.example.com/x`);
		redacts("curl --user bob:hunter2 https://api.example.com/x", `curl --user bob:${REDACTED} https://api.example.com/x`);
		redacts("curl -ubob:hunter2 https://api.example.com/x", `curl -ubob:${REDACTED} https://api.example.com/x`);
		redacts("curl --user=bob:hunter2 https://api.example.com/x", `curl --user=bob:${REDACTED} https://api.example.com/x`);
		redacts("curl --proxy-user bob:hunter2 https://api.example.com/x", `curl --proxy-user bob:${REDACTED} https://api.example.com/x`);
		redacts("curl -sSu bob:hunter2 https://api.example.com/x", `curl -sSu bob:${REDACTED} https://api.example.com/x`);
		// A quoted pair with a space in the password goes whole.
		redacts(`curl -u "bob:hunter 2" https://api.example.com/x`, `curl -u ${REDACTED} https://api.example.com/x`);
	});

	test("-u and --user mean other things outside curl, and a user alone is no secret", () => {
		untouched("useradd -u 1000 bob");
		untouched("docker run --user 1000:1000 img");
		untouched("curl --user-agent mozilla:5.0 https://x.test");
		untouched("curl -u bob https://x.test");
		untouched("curl -sS https://x.test/up");
	});

	test("sshpass, docker login, mysql, redis-cli and openssl password flags lose their value", () => {
		redacts("sshpass -p hunter2 ssh bob@host", `sshpass -p ${REDACTED} ssh bob@host`);
		redacts("sshpass -phunter2 ssh bob@host", `sshpass -p${REDACTED} ssh bob@host`);
		redacts("docker login -u bob -p hunter2 registry.example.com", `docker login -u bob -p ${REDACTED} registry.example.com`);
		redacts("mysql -u root -phunter2 -e 'select 1'", `mysql -u root -p${REDACTED} -e 'select 1'`);
		redacts("mysqldump -phunter2 db", `mysqldump -p${REDACTED} db`);
		redacts("redis-cli -h cache -a hunter2 ping", `redis-cli -h cache -a ${REDACTED} ping`);
		redacts("openssl enc -aes-256-cbc -pass pass:hunter2 -in a -out b", `openssl enc -aes-256-cbc -pass pass:${REDACTED} -in a -out b`);
		redacts("openssl rsa -passin pass:hunter2 -in k.pem", `openssl rsa -passin pass:${REDACTED} -in k.pem`);
	});

	test("the same short flags on other commands are not passwords", () => {
		untouched("mkdir -p out/build");
		untouched("ssh -p 22 bob@host");
		untouched("docker run -p 8080:80 img");
		untouched("mysql -p mydb");
		untouched("openssl enc -pass env:PW -in a");
		untouched("openssl enc -pass file:pw.txt -in a");
		untouched("redis-cli -h cache ping");
		untouched("cp -p a b");
	});
});

describe("secret names", () => {
	test("a trailing digit and the short form PASS are secret names", () => {
		for (const name of ["DB_PASS", "PASS", "API_KEY2", "TOKEN2", "SECRET1", "AES_KEY_256", "db_pass", "smtp-pass", "dbPass"]) {
			expect(isSecretName(name)).toBe(true);
			redacts(`${name}=hunter2`, `${name}=${REDACTED}`);
			expect(JSON.stringify(redactValue({ [name]: "hunter2" }))).not.toContain("hunter2");
		}
	});

	test("words that only contain pass, and counters with a digit, stay readable", () => {
		for (const name of ["pass", "passWithNoTests", "bypass", "compass", "PASSENGER", "max_tokens2", "KEY2", "monkey2", "PWD", "sha256"]) {
			expect(isSecretName(name)).toBe(false);
		}
		untouched("jest --passWithNoTests src/a.test.ts");
		untouched("pass: 12");
		untouched("ran 40 tests, pass=38 fail=2");
	});
});

describe("token shapes with a published prefix", () => {
	test("Stripe, Google OAuth, Shopify, Hugging Face and Slack webhook values are redacted", () => {
		const cases: Array<[string, string]> = [
			["stripe", fake("sk_live_", 24)],
			["stripe test", fake("sk_test_", 24)],
			["stripe restricted", fake("rk_live_", 24)],
			["google oauth", fake("ya29.", 40)],
			["shopify", fake("shpat_", 32)],
			["hugging face", fake("hf_", 34)],
		];
		for (const [label, secret] of cases) {
			const out = redactSecrets(`using ${label} ${secret} here`);
			expect(out).toBe(`using ${label} ${REDACTED} here`);
			expect(redactSecrets(out)).toBe(out);
		}
		const hook = ["https://hooks.slack.com/services", "T00000000", "B00000000", "0".repeat(24)].join("/");
		redacts(`curl -X POST ${hook} -d '{}'`, `curl -X POST https://hooks.slack.com/services/${REDACTED} -d '{}'`);
	});

	test("a short look-alike prefix is left alone", () => {
		untouched("sk_live_x");
		untouched("the hf_ prefix and ya29 and shpat_ are token prefixes");
	});
});

describe("other leaks", () => {
	test("aws configure set takes the secret value that follows a secret name", () => {
		redacts(
			"aws configure set aws_secret_access_key wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY --profile dev",
			`aws configure set aws_secret_access_key ${REDACTED} --profile dev`,
		);
		redacts("aws configure set aws_session_token abc123EXAMPLE", `aws configure set aws_session_token ${REDACTED}`);
		untouched("aws configure set region us-east-1");
	});

	test("a URL password that contains @ loses its tail too", () => {
		redacts("psql postgres://user:p@ss@host/db", `psql postgres://user:${REDACTED}@host/db`);
		redacts("git clone https://bob:a@b@c@github.com/acme/repo.git", `git clone https://bob:${REDACTED}@github.com/acme/repo.git`);
		// A later @ in the path is not part of the password.
		redacts("https://bob:hunter2@host/path@x", `https://bob:${REDACTED}@host/path@x`);
		untouched("ssh://git@github.com:22/acme/repo.git");
		untouched("http://host:8080/a@b");
	});
});

describe("redaction replaces the value and leaves the command", () => {
	test("the reported case keeps the command after the secret", () => {
		redacts("export X=1 AWS_SECRET_ACCESS_KEY=abc && rm -rf build", `export X=1 AWS_SECRET_ACCESS_KEY=${REDACTED} && rm -rf build`);
		redacts("TOKEN=abc curl https://api.example.com/x | jq .", `TOKEN=${REDACTED} curl https://api.example.com/x | jq .`);
	});

	test("the value ends at the end of its shell word", () => {
		const cases: Array<[string, string]> = [
			[`GH_TOKEN="a b c" gh pr list`, `GH_TOKEN=${REDACTED} gh pr list`],
			[`GH_TOKEN='a b c' gh pr list`, `GH_TOKEN=${REDACTED} gh pr list`],
			[`GH_TOKEN="a'b" gh pr list`, `GH_TOKEN=${REDACTED} gh pr list`],
			[`GH_TOKEN=$(op read x) gh pr list`, `GH_TOKEN=${REDACTED} gh pr list`],
			[`GH_TOKEN=\`op read x\` gh pr list`, `GH_TOKEN=${REDACTED} gh pr list`],
			[`GH_TOKEN=\${GH_TOKEN:-none} gh pr list`, `GH_TOKEN=${REDACTED} gh pr list`],
			["DB_PASSWORD=hunter2; rm -rf build", `DB_PASSWORD=${REDACTED}; rm -rf build`],
			["DB_PASSWORD=hunter2 | tee out", `DB_PASSWORD=${REDACTED} | tee out`],
			["DB_PASSWORD=hunter2>out.txt cat", `DB_PASSWORD=${REDACTED}>out.txt cat`],
			["(DB_PASSWORD=hunter2) && rm -rf build", `(DB_PASSWORD=${REDACTED}) && rm -rf build`],
			["A_TOKEN=one B_TOKEN=two make", `A_TOKEN=${REDACTED} B_TOKEN=${REDACTED} make`],
			["A_TOKEN=B_TOKEN=two make", `A_TOKEN=${REDACTED} make`],
			["API_KEY=x& rm -rf build", `API_KEY=${REDACTED}& rm -rf build`],
			["mysql --password hunter2 -e 'select 1'", `mysql --password ${REDACTED} -e 'select 1'`],
			["mysql --password=hunter2 && rm -rf build", `mysql --password=${REDACTED} && rm -rf build`],
			["curl --api-key $KEY https://x.test", `curl --api-key ${REDACTED} https://x.test`],
			['bash -c "export DB_PASSWORD=hunter2 && rm -rf build"', `bash -c "export DB_PASSWORD=${REDACTED} && rm -rf build"`],
			["bash -c 'export DB_PASSWORD=hunter2 && rm -rf build'", `bash -c 'export DB_PASSWORD=${REDACTED} && rm -rf build'`],
			['{"command":"DB_PASSWORD=hunter2"}', `{"command":"DB_PASSWORD=${REDACTED}"}`],
			["docker run -e API_KEY=x -e MODE=prod img", `docker run -e API_KEY=${REDACTED} -e MODE=prod img`],
		];
		for (const [text, expected] of cases) redacts(text, expected);
	});

	test("a secret flag followed by another flag could have its value anywhere after, so the line goes", () => {
		// Action keys sort their flags ahead of the arguments: `mysql --password
		// -e hunter2` is what a refusal key for `mysql --password hunter2 -e x` reads.
		redacts("mysql --password -e hunter2", `mysql --password ${REDACTED}`);
		redacts("sshpass -p -v hunter2", `sshpass -p ${REDACTED}`);
		redacts("curl -u -s bob:hunter2", `curl -u ${REDACTED}`);
		// A flag that only says the password comes on stdin takes nothing.
		untouched("docker login --password-stdin -u bob registry.example.com");
		redacts("docker login --password-stdin registry.example.com && make", `docker login --password-stdin ${REDACTED} && make`);
	});

	test("a header inside a quoted argument ends with that argument, so the URL after it stays", () => {
		redacts(`curl -H 'Authorization: Bearer abcdefghijklmnop' https://api.example.com/x`, `curl -H 'Authorization: ${REDACTED}' https://api.example.com/x`);
		redacts(`curl -H "X-Api-Key: hunter2" -X POST https://api.example.com/x`, `curl -H "X-Api-Key: ${REDACTED}" -X POST https://api.example.com/x`);
		redacts(`curl -H "Authorization:Basic dXNlcjpwYXNz" https://api.example.com/x`, `curl -H "Authorization:${REDACTED}" https://api.example.com/x`);
		redacts(`curl --data-urlencode "client_secret=hunter2" https://api.example.com/x`, `curl --data-urlencode "client_secret=${REDACTED}" https://api.example.com/x`);
		// An escaped quote inside the argument does not end it early.
		redacts(`curl -H "Authorization: Bearer abc\\"def123" https://api.example.com/x`, `curl -H "Authorization: ${REDACTED}" https://api.example.com/x`);
		// A header with no quote around it, or a JSON field, takes the rest of the line.
		redacts("Authorization: Bearer abcdefghijklmnop and more", `Authorization: ${REDACTED}`);
		redacts('{"password":"x","user":"bob"}', `{"password":${REDACTED}`);
		// Many markers inside one quoted argument are one redaction, not a rescan each.
		const started = performance.now();
		redactSecrets(`"${"password: ".repeat(100_000)}" tail`);
		expect(performance.now() - started).toBeLessThan(1_000);
	});

	test("openssl -k and ssh-keygen -N and -P take a passphrase", () => {
		redacts("openssl enc -k hunter2 -in a", `openssl enc -k ${REDACTED} -in a`);
		redacts("ssh-keygen -t ed25519 -N hunter2 -f key", `ssh-keygen -t ed25519 -N ${REDACTED} -f key`);
		redacts("ssh-keygen -p -P hunter2 -N hunter3 -f key", `ssh-keygen -p -P ${REDACTED} -N ${REDACTED} -f key`);
		untouched("ssh-keygen -t ed25519 -f key");
		untouched("tar -k -xf a.tar");
	});

	test("an unterminated quote runs to the end of the line, and a loose assignment still cuts it", () => {
		redacts('DB_PASSWORD="hunter2 && rm -rf build', `DB_PASSWORD=${REDACTED}`);
		redacts("password = hunter2 and more", `password = ${REDACTED}`);
		redacts("secret_key: hunter2 and more", `secret_key: ${REDACTED}`);
		redacts("DB_PASSWORD= hunter2 make", `DB_PASSWORD= ${REDACTED}`);
		// An empty value has nothing to hide.
		untouched("DB_PASSWORD=");
	});

	test("secrets on different lines are each replaced and the lines around them stay", () => {
		redacts("echo a\nGH_TOKEN=hunter2 make\nrm -rf build\n", `echo a\nGH_TOKEN=${REDACTED} make\nrm -rf build\n`);
	});

	test("the audit log and the reviewer read the tail of the command", () => {
		const command = "export X=1 AWS_SECRET_ACCESS_KEY=abc && rm -rf build";
		const input: ReviewerInput = { command, workingDirectory: "/work", transcript: [], scriptBodies: [], stage1: { verdict: "UNSURE", reason: "needs review" } };
		const rendered = JSON.parse(renderReviewerInput(input)) as { command: string };
		expect(rendered.command).toBe(`export X=1 AWS_SECRET_ACCESS_KEY=${REDACTED} && rm -rf build`);
	});
});

describe("redactValue reads argv arrays and name/value pairs", () => {
	const dump = (value: unknown): string => JSON.stringify(redactValue(value));

	test("the element after a secret flag in an argv array is redacted", () => {
		expect(redactValue(["mysql", "--password", "hunter2", "-e", "select 1"])).toEqual(["mysql", "--password", REDACTED, "-e", "select 1"]);
		expect(redactValue({ argv: ["mysql", "--password", "hunter2"] })).toEqual({ argv: ["mysql", "--password", REDACTED] });
		expect(dump({ argv: ["curl", "-u", "bob:hunter2", "https://x.test"] })).not.toContain("hunter2");
		expect(dump({ argv: ["sshpass", "-p", "hunter2", "ssh", "host"] })).not.toContain("hunter2");
		expect(dump({ argv: ["mysql", "-phunter2"] })).not.toContain("hunter2");
		expect(redactValue(["curl", "https://x.test", "-sS"])).toEqual(["curl", "https://x.test", "-sS"]);
	});

	test("an {name, value} or {key, value} pair with a secret name loses its value", () => {
		expect(redactValue({ env: [{ name: "DB_PASSWORD", value: "hunter2" }, { name: "MODE", value: "prod" }] })).toEqual({
			env: [{ name: "DB_PASSWORD", value: REDACTED }, { name: "MODE", value: "prod" }],
		});
		expect(redactValue({ headers: [{ key: "Authorization", value: "Basic Zm9vOmJhcg==" }] })).toEqual({ headers: [{ key: "Authorization", value: REDACTED }] });
		expect(redactValue({ header: "X-Api-Key", value: "hunter2" })).toEqual({ header: "X-Api-Key", value: REDACTED });
		expect(redactValue({ name: "PATH", value: "/usr/bin" })).toEqual({ name: "PATH", value: "/usr/bin" });
	});

	test("a [header, value] pair with a secret header loses its value", () => {
		expect(redactValue({ headers: [["Authorization", "Basic Zm9vOmJhcg=="], ["Accept", "text/plain"]] })).toEqual({
			headers: [["Authorization", REDACTED], ["Accept", "text/plain"]],
		});
		expect(redactValue(["DB_PASSWORD", "hunter2"])).toEqual(["DB_PASSWORD", REDACTED]);
	});

	test("ordinary arrays and objects come back unchanged", () => {
		const value = { files: ["src/token.ts", "src/auth/session.ts"], argv: ["git", "status", "--short"], n: 3, ok: true, none: null, nested: [{ name: "build", value: 1 }] };
		expect(redactValue(value)).toEqual(value);
	});
});

describe("redaction stays linear on hostile input", () => {
	const MB = 1_000_000;
	const hostile: Array<[string, string]> = [
		["many curl -u flags", `curl ${"-u ".repeat(MB)}`],
		["a long -u cluster", `curl -${"s".repeat(2 * MB)}`],
		["many -p flags", `sshpass ${"-p ".repeat(MB / 3)}`],
		["attached mysql -p", `mysql ${"-pa ".repeat(MB / 4)}`],
		["many URL starts", "a://b:".repeat(MB / 6)],
		["a URL password with no end", `http://u:${"@".repeat(2 * MB)}`],
		["a URL password of many parts", `http://u:${"a@".repeat(MB)}`],
		["config set repeats", "config set ".repeat(MB / 11)],
		["config set and a long name", `config set ${"a".repeat(2 * MB)}`],
		["a long digit run", `${"1".repeat(2 * MB)}x=y`],
		["a long digit-suffixed name", `${"A_".repeat(MB / 2)}1=y`],
		["many assignments", "A_TOKEN=a ".repeat(MB / 10)],
		["many nested substitutions", `A_TOKEN=${"$(".repeat(MB)}`],
		["many open quotes", `A_TOKEN=${"'".repeat(2 * MB)}`],
		["many escapes", `A_TOKEN=${'\\"'.repeat(MB)}`],
		["many backticks", `A_TOKEN=${"`".repeat(2 * MB)}`],
		["many token prefixes", "hf_ ya29. shpat_ sk_live_ ".repeat(MB / 26)],
		["a long slack path", `hooks.slack.com/services/${"a/".repeat(MB)}`],
	];
	test("each shape finishes in well under a second per megabyte", () => {
		for (const [label, text] of hostile) {
			const started = performance.now();
			redactSecrets(text);
			const elapsed = performance.now() - started;
			expect(elapsed, label).toBeLessThan(1_000);
		}
	});

	test("a large argv array is linear too", () => {
		const argv = Array.from({ length: 200_000 }, (_, i) => (i % 2 === 0 ? "--flag" : `value ${i}`));
		const started = performance.now();
		redactValue({ argv });
		expect(performance.now() - started).toBeLessThan(3_000);
	});
});
