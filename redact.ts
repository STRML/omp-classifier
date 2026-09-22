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
 *  `x-api-key`, `client_secret`, `DB_PASSWORD`. */
const SECRET_NAME = String.raw`[A-Za-z0-9_-]*(?:api[_-]?key|apikey|token|secret|password|passwd|pwd|private[_-]?key|access[_-]?key|credential)s?`;

const RULES: readonly Rule[] = [
	// A private key block, whole. An unterminated block runs to the end.
	{ pattern: /-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----[\s\S]*?(?:-----END [A-Z0-9 ]*PRIVATE KEY-----|$)/gu, replace: whole },
	// An authorization header's credential, whatever its scheme: `Bearer x`,
	// `Basic x`, `ApiKey x`. The key may be quoted, or JSON-escaped inside an
	// encoded string. The scheme word stays; the credential is one token of 8+
	// characters, so prose after "Authorization:" in a user message survives.
	{
		pattern: /\b(authorization(?:\\?["'])?\s*[:=]\s*)(\\?["']?)((?:[A-Za-z][A-Za-z-]*\s+)?)[^\s"'\\,;]{8,}/giu,
		replace: (_m, keep, quote, scheme) => `${keep}${quote}${scheme}${REDACTED}`,
	},
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
	// A value assigned to a secret-sounding name: API_KEY=..., "password": "...".
	// A quoted value is redacted whole, to its closing quote, whatever its
	// length or punctuation. An unquoted one runs to whitespace, a quote, `,`,
	// `}` or `&`, and needs six characters, so `max_tokens: 1024` stays readable.
	{
		pattern: new RegExp(`(\\b${SECRET_NAME}(?:\\\\?["'])?\\s*[:=]\\s*)(\\\\?["'])((?:(?!\\2)[^\\r\\n])+)\\2`, "giu"),
		replace: (_m, keep, quote) => `${keep}${quote}${REDACTED}${quote}`,
	},
	{
		pattern: new RegExp(`(\\b${SECRET_NAME}(?:\\\\?["'])?\\s*[:=]\\s*)([^\\s"'\\\\,}&]{6,})`, "giu"),
		replace: (_m, keep) => `${keep}${REDACTED}`,
	},
];

export function redactSecrets(text: string): string {
	let out = text;
	for (const rule of RULES) out = out.replace(rule.pattern, rule.replace);
	return out;
}
