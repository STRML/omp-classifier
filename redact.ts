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
 *   - `password`, `passphrase` or `passwd` anywhere: `SSH_PASSPHRASE_FILE`.
 *   - a secret word after a `_` or `-`: `DJANGO_SECRET_KEY`, `x-api-key`,
 *     `GH_TOKEN`, `DB_PWD`. `token` is singular, so `max_tokens` and
 *     `input_tokens` (usage counts tool results print) are not secret.
 *   - a secret word alone: `token`, `secret`, `apikey`. Not `key`, which is
 *     too common a word, and not `pwd`, which is also `$PWD`, the working
 *     directory.
 */
const SECRET_ANYWHERE = /password|passphrase|passwd/iu;
const SECRET_SUFFIX = /[_-](?:api[_-]?keys?|apikeys?|keys?|token|secrets?|credentials?|pwd)$/iu;
const SECRET_BARE = /^(?:api[_-]?keys?|apikeys?|token|secrets?|credentials?)$/iu;

export function isSecretName(name: string): boolean {
	return SECRET_ANYWHERE.test(name) || SECRET_SUFFIX.test(name) || SECRET_BARE.test(name);
}

/** Header names whose value is a credential, beside the secret names. */
const HEADER_MARKER = /^(?:(?:proxy-)?authorization|(?:set-)?cookie)$/iu;

const isSecretMarker = (name: string): boolean => HEADER_MARKER.test(name) || isSecretName(name);

/** A name then `:` or `=`, possibly quoted or JSON-escaped: `API_KEY=`,
 *  `"password":`, `Authorization:`. */
const NAME_THEN_SEPARATOR = /\b([A-Za-z0-9_-]+)(?:\\?["'])?\s*[:=][ \t]*/gu;
/** A name as a command-line flag with its value after a space:
 *  `mysql --password hunter2`. It may open the text or a line. */
const FLAG_THEN_VALUE = /(?:^|\s)--?([A-Za-z0-9_-]+)[ \t]+(?=\S)/gu;

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
