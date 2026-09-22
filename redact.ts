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

/** A name that says its value is a secret, with any prefix: `OPENAI_API_KEY`,
 *  `x-api-key`, `client_secret`, `DB_PASSWORD`, and any `_KEY` or
 *  `_PASSPHRASE` (`DJANGO_SECRET_KEY`, `SSH_PASSPHRASE`), a superset of the
 *  floor's secret variable names. `token` has no plural here:
 *  `max_tokens` and `input_tokens` are usage counts tool results print. */
const SECRET_NAME = String.raw`[A-Za-z0-9_-]*(?:api[_-]?keys?|apikeys?|[_-]keys?|token|secrets?|passwords?|passphrases?|passwd|pwd|private[_-]?keys?|access[_-]?keys?|credentials?)`;

/** Every marker that says "a secret follows", in one vocabulary shared by the
 *  text rules and the structural keys, so one can't know a name the other
 *  misses: header names that carry credentials, and secret-sounding names. */
const SECRET_MARKER = String.raw`(?:(?:proxy-)?authorization|(?:set-)?cookie|${SECRET_NAME})`;

const RULES: readonly Rule[] = [
	// A private key block, whole. An unterminated block runs to the end.
	// PEM and PGP armor both: `PRIVATE KEY` and `PRIVATE KEY BLOCK`.
	{ pattern: /-----BEGIN [A-Z0-9 ]*PRIVATE KEY(?: BLOCK)?-----[\s\S]*?(?:-----END [A-Z0-9 ]*PRIVATE KEY(?: BLOCK)?-----|$)/gu, replace: whole },
	// A secret marker followed by `:` or `=` (`Authorization:`, `Set-Cookie:`,
	// `API_KEY=`, `"password":`): everything after it to the end of the line,
	// whatever the scheme or quoting. The marker may be quoted or JSON-escaped.
	// There is no header or quoting grammar left to miss.
	{ pattern: new RegExp(`(\\b${SECRET_MARKER}(?:\\\\?["'])?\\s*[:=][ \\t]*)[^\\r\\n]*`, "giu"), replace: (_m, keep) => `${keep}${REDACTED}` },
	// The same marker as a command-line flag with its value after a space:
	// `mysql --password hunter2`, `--api-key $KEY`. `--password-stdin` is a
	// different word and stays.
	// It may open the text or a line.
	{ pattern: new RegExp(`((?:^|\\s)--?${SECRET_MARKER}[ \\t]+)(?=\\S)[^\\r\\n]*`, "gimu"), replace: (_m, keep) => `${keep}${REDACTED}` },
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

/** A key whose value is a credential whatever it looks like. */
const SECRET_KEY = new RegExp(`^${SECRET_MARKER}$`, "iu");

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
	return Object.fromEntries(Object.entries(value).map(([key, inner]) => [key, SECRET_KEY.test(key) ? REDACTED : redactValue(inner)]));
}

export function redactSecrets(text: string): string {
	let out = text;
	for (const rule of RULES) out = out.replace(rule.pattern, rule.replace);
	return out;
}
