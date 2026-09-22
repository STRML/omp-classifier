/**
 * Redact secret-shaped values from text before it enters a judge state (plan
 * `docs/plans/2026-09-19-intent-aware-judgment.md`, Phase 2 step 7).
 *
 * Evidence reaches TypeSafe verbatim: a tool result that printed a key, a user
 * message that pasted one, an agent's context that quoted one. The judges never
 * need the value, only that something was there, so the value becomes
 * REDACTED and the name, scheme or host around it stays.
 *
 * This is a shape match, so it misses a secret with no known shape and no
 * secret-sounding name. The command itself is never passed through here: it is
 * what gets judged, and hiding its key would hide the hazard.
 */

export const REDACTED = "[redacted]";

interface Rule {
	pattern: RegExp;
	/** Keeps the context around the value: a name, a scheme, a host. */
	replace: (match: string, ...groups: string[]) => string;
}

const whole = (): string => REDACTED;

/**
 * What makes a name secret: one definition, read by the text pass, the
 * structural pass, and the floor's secret-variable check (floor.ts), so no
 * two of them can drift apart.
 *
 *   - `password`, `passphrase`, `passwd` or `pwd` anywhere:
 *     `SSH_PASSPHRASE_FILE`, `dbpwd`. Except `PWD` and `OLDPWD`, the
 *     working-directory variables.
 *   - a name ending in `token`, `secret`, `credential` or `apikey`, glued or
 *     not: `accessToken`, `AUTHTOKEN`, `client_secret`, `GH_TOKEN`. `token`
 *     is singular, so `max_tokens` and `input_tokens` (usage counts tool
 *     results print) are not secret.
 *   - a secret word anywhere among the name's words, split on `_`, `-`, `.`
 *     and camelCase: `CLIENT_SECRET_VALUE`, `GH_TOKEN_FILE`; or `key` right
 *     after a qualifier such as private, api or signing: `PRIVATE_KEY_PEM`.
 *   - a name ending in `key` after a `_`, a `-` or a camelCase boundary:
 *     `DJANGO_SECRET_KEY`, `privateKey`. Not glued, and not alone: `monkey`
 *     and a bare `$KEY` are no secrets.
 */
const SECRET_ANYWHERE = /password|passphrase|passwd|pwd/iu;
/** Words that end a secret name glued or separated: `accessToken`,
 *  `AUTHTOKEN`, `client_secret`, `openaiApiKey`, `MYPRIVATEKEY`. */
const SECRET_ENDING = /(?:token|secrets?|credentials?|api[_-]?keys?|private[_-]?keys?|access[_-]?keys?)$/iu;
/** `key` ends one only after a separator: glued, it is other words (`monkey`,
 *  `turkey`), and alone it is too common. */
const SECRET_SEPARATED = /[_-]keys?$/iu;

/** `privateKey` reads as `private_Key`: camelCase is a separator too. */
const splitCamel = (name: string): string => name.replace(/([a-z0-9])([A-Z])/gu, "$1_$2");

/** A secret word anywhere among a name's words: `CLIENT_SECRET_VALUE`,
 *  `GH_TOKEN_FILE`, `db.credentials.json`. Whole words only, so `tokens` in
 *  `max_tokens` is not `token`. */
const SECRET_WORDS = new Set([
	"password", "passwords", "passphrase", "passphrases", "passwd", "pwd",
	"token", "secret", "secrets", "credential", "credentials", "apikey", "apikeys", "privatekey", "accesskey",
]);
/** A word that makes the `key` after it a secret, anywhere in the name:
 *  `PRIVATE_KEY_PEM`, `api_key_id`, `SSH_KEY_PATH`. */
const KEY_QUALIFIERS = new Set(["api", "private", "access", "secret", "signing", "encryption", "master", "ssh", "client", "auth", "gpg", "pgp", "deploy"]);

/** A name's words: split on `_`, `-`, `.` and camelCase, lower-cased. */
const wordsOf = (name: string): string[] =>
	splitCamel(name)
		.split(/[_.-]+/u)
		.filter(word => word.length > 0)
		.map(word => word.toLowerCase());

/** A name that ends in a file extension is a file (`token.ts:` in grep
 *  output), not a setting. The word rule leaves it to the other rules. */
const FILE_NAME = /\.(?:[cm]?[jt]sx?|py|rb|go|rs|java|kt|swift|c|h|cpp|sh|md|txt|json|ya?ml|toml|lock|log|html|css)$/iu;

function hasSecretWord(name: string): boolean {
	if (FILE_NAME.test(name)) return false;
	const words = wordsOf(name);
	return words.some((word, index) => SECRET_WORDS.has(word) || (KEY_QUALIFIERS.has(word) && /^keys?$/u.test(words[index + 1] ?? "")));
}

export function isSecretName(name: string): boolean {
	const words = splitCamel(name);
	if (SHELL_DIRECTORY_VARIABLES.has(name)) return false;
	return SECRET_ANYWHERE.test(words) || SECRET_ENDING.test(words) || SECRET_SEPARATED.test(words) || hasSecretWord(name);
}

/** The working-directory variables POSIX shells set, always in upper case.
 *  `pwd` anywhere else in a name is a password field (`dbpwd`, `"pwd":`). */
const SHELL_DIRECTORY_VARIABLES = new Set(["PWD", "OLDPWD"]);

/** Header names whose value is a credential, beside the secret names, with
 *  any prefix: `Proxy-Authorization`, `X-Authorization`, `Set-Cookie`. */
const HEADER_MARKER = /(?:authorization|cookies?)$/iu;

const HEADER_WORDS = new Set(["authorization", "cookie", "cookies"]);
const isSecretMarker = (name: string): boolean =>
	HEADER_MARKER.test(name) || wordsOf(name).some(word => HEADER_WORDS.has(word)) || isSecretName(name);

/** A name then `:` or `=`, possibly quoted or JSON-escaped: `API_KEY=`,
 *  `"password":`, `Authorization:`. Dots belong to the name, so a config key
 *  like `aws.pwd` is asked about whole. */
const NAME_THEN_SEPARATOR = /\b([A-Za-z0-9_.-]+)(?:\\?["'])?\s*[:=][ \t]*/gu;
/** A name as a command-line flag with its value after a space:
 *  `mysql --password hunter2`. It may open the text or a line. */
const FLAG_THEN_VALUE = /(?:^|\s)--?([A-Za-z0-9_.-]+)[ \t]+(?=\S)/gu;

/**
 * Redact one line from its first secret marker to its end, whatever the
 * scheme or quoting after it. Every name on the line is asked, so a harmless
 * `https:` before a `token=` doesn't hide it. That errs toward redacting too
 * much, by design: `{"password":"x","user":"bob"}` loses `bob`.
 */
function redactLine(line: string): string {
	let cut = -1;
	for (const pattern of [NAME_THEN_SEPARATOR, FLAG_THEN_VALUE]) {
		for (const match of line.matchAll(pattern)) {
			if (!isSecretMarker(match[1])) continue;
			const end = match.index + match[0].length;
			if (cut < 0 || end < cut) cut = end;
			break;
		}
	}
	return cut < 0 ? line : `${line.slice(0, cut)}${REDACTED}`;
}

const RULES: readonly Rule[] = [
	// A private key block, whole. An unterminated block runs to the end.
	// PEM and PGP armor both: `PRIVATE KEY` and `PRIVATE KEY BLOCK`.
	{ pattern: /-----BEGIN [A-Z0-9 ]*PRIVATE KEY(?: BLOCK)?-----[\s\S]*?(?:-----END [A-Z0-9 ]*PRIVATE KEY(?: BLOCK)?-----|$)/gu, replace: whole },
	// Every line from its first secret marker on (see redactLine).
	{ pattern: /[^\r\n]+/gu, replace: line => redactLine(line) },
	{ pattern: /\b(bearer\s+)[^\s"'\\,;]{8,}/giu, replace: (_m, keep) => `${keep}${REDACTED}` },
	// Token formats with a published prefix.
	{ pattern: /\bsk-(?:ant-|proj-)?[A-Za-z0-9_-]{20,}/gu, replace: whole },
	{ pattern: /\bgh[oprsu]_[A-Za-z0-9]{30,}/gu, replace: whole },
	{ pattern: /\bgithub_pat_[A-Za-z0-9_]{40,}/gu, replace: whole },
	{ pattern: /\bxox[abopqrs]-[A-Za-z0-9-]{10,}/gu, replace: whole },
	{ pattern: /\bAKIA[0-9A-Z]{16}\b/gu, replace: whole },
	{ pattern: /\bAIza[0-9A-Za-z_-]{35}/gu, replace: whole },
	{ pattern: /\bglpat-[A-Za-z0-9_-]{20,}/gu, replace: whole },
	{ pattern: /\bnpm_[A-Za-z0-9]{36}/gu, replace: whole },
	{ pattern: /\beyJ[A-Za-z0-9_-]{10,}\.eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/gu, replace: whole },
	// The password in a URL's userinfo. The user and host stay.
	{ pattern: /(\b[a-z][a-z0-9+.-]*:\/\/[^\s:/@]+:)[^\s@/]+(@)/giu, replace: (_m, head, at) => `${head}${REDACTED}${at}` },
];


/**
 * Redact a structured value before it is serialized: every value under a
 * secret-sounding key is replaced whole, whatever its content, and every other
 * string goes through redactSecrets. Tool-call arguments take this path, so
 * an escaped quote inside a password can't end its redaction early.
 */
export function redactValue(value: unknown): unknown {
	if (typeof value === "string") return redactSecrets(value);
	if (Array.isArray(value)) return value.map(redactValue);
	if (value === null || typeof value !== "object") return value;
	return Object.fromEntries(Object.entries(value).map(([key, inner]) => [key, isSecretMarker(key) ? REDACTED : redactValue(inner)]));
}

export function redactSecrets(text: string): string {
	let out = text;
	for (const rule of RULES) out = out.replace(rule.pattern, rule.replace);
	return out;
}
