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

/** `privateKey` reads as `private_Key`, and an acronym ends where a word
 *  starts: `APITokenFile` reads as `API_Token_File`, `SSHKeyPath` as
 *  `SSH_Key_Path`. camelCase is a separator too. */
const splitCamel = (name: string): string =>
	name.replace(/([A-Z])(?=[A-Z][a-z])/gu, "$1_").replace(/([a-z0-9])(?=[A-Z])/gu, "$1_");

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

function hasSecretWord(name: string): boolean {
	const words = wordsOf(name);
	return words.some((word, index) => SECRET_WORDS.has(word) || (index > 0 && word === "pass") || (KEY_QUALIFIERS.has(word) && /^keys?$/u.test(words[index + 1] ?? "")));
}

/** A counter or version on the end of a name does not make it another
 *  name: `API_KEY2`, `TOKEN2`, `SECRET1`, `AES_KEY_256`. A manual scan, not
 *  `/\d+$/`, which is quadratic on a long run of digits. */
function withoutTrailingDigits(name: string): string {
	let end = name.length;
	while (end > 0 && name.charCodeAt(end - 1) >= 48 && name.charCodeAt(end - 1) <= 57) end--;
	if (end === name.length || end === 0) return name;
	return name[end - 1] === "_" || name[end - 1] === "-" ? name.slice(0, end - 1) : name.slice(0, end);
}

export function isSecretName(name: string): boolean {
	if (SHELL_DIRECTORY_VARIABLES.has(name)) return false;
	const base = withoutTrailingDigits(name);
	const words = splitCamel(base);
	// `PASS` alone is the short form of `PASSWORD`; lower-case `pass` is a verb.
	return SECRET_ANYWHERE.test(words) || SECRET_ENDING.test(words) || SECRET_SEPARATED.test(words) || base === "PASS" || hasSecretWord(base);
}

/** The working-directory variables POSIX shells set, always in upper case.
 *  `pwd` anywhere else in a name is a password field (`dbpwd`, `"pwd":`). */
const SHELL_DIRECTORY_VARIABLES = new Set(["PWD", "OLDPWD"]);

/** Header names whose value is a credential, beside the secret names, with
 *  any prefix: `Proxy-Authorization`, `X-Authorization`, `Set-Cookie`. */
const HEADER_MARKER = /(?:authorization|cookies?)$/iu;

const isSecretMarker = (name: string): boolean => HEADER_MARKER.test(name) || isSecretName(name);

/** A name then `:` or `=`, possibly quoted or JSON-escaped: `API_KEY=`,
 *  `"password":`, `Authorization:`. Dots belong to the name, so a config key
 *  like `aws.pwd` is asked about whole. The lookbehind starts a match only at
 *  the start of a name, so a run like `a.a.a.a…` is scanned once rather than
 *  once per `.`: linear time on input of any length. Groups: the name, a quote
 *  closing the name, the gap before the separator, the separator, the gap
 *  after it. */
const NAME_THEN_SEPARATOR = /(?<![A-Za-z0-9_.-])([A-Za-z0-9_.-]+)(\\?["'])?(\s*)([:=])([ \t]*)/gu;
/** A name as a command-line flag with its value after a space:
 *  `mysql --password hunter2`. It may open the text or a line. */
const FLAG_THEN_VALUE = /(?:^|\s)--?([A-Za-z0-9_.-]+)[ \t]+(?=\S)/gu;
/** `aws configure set aws_secret_access_key <value>`: a bare name, then its value. */
const CONFIG_SET = /\b(?:configure|config)[ \t]+set[ \t]+([A-Za-z0-9_.-]+)[ \t]+(?=\S)/gu;

/** Where a value sits in a line: `[start, end)` becomes REDACTED. */
interface Span {
	start: number;
	end: number;
}

/** What encloses a position: no quote, a single quote, a double quote. */
const OUTSIDE = 0;
const IN_SINGLE = 1;
const IN_DOUBLE = 2;

/** The quote around each position of a line, so a value found inside
 *  `bash -c "… TOKEN=x && …"` ends at the closing quote and not past it. One
 *  pass. */
function enclosingQuotes(line: string): Uint8Array {
	const states = new Uint8Array(line.length + 1);
	let state = OUTSIDE;
	for (let i = 0; i < line.length; i++) {
		states[i] = state;
		const c = line[i];
		if (state === IN_SINGLE) {
			if (c === "'") state = OUTSIDE;
			continue;
		}
		if (c === "\\") {
			i++;
			states[i] = state;
		} else if (c === '"') state = state === IN_DOUBLE ? OUTSIDE : IN_DOUBLE;
		else if (c === "'" && state === OUTSIDE) state = IN_SINGLE;
	}
	states[line.length] = state;
	return states;
}

/** Inner quoting of a word being scanned. */
const PLAIN = 0;
const WITHIN_SINGLE = 1;
const WITHIN_DOUBLE = 2;
/** `\"` … `\"`: a quote escaped for JSON or for a string around it. */
const WITHIN_ESCAPED = 3;

/** Characters that end an unquoted word at the top level of a shell line. */
const WORD_TERMINATORS = new Set([";", "|", "<", ">", ")"]);
const isSpace = (c: string): boolean => c === " " || c === "\t" || c === "\r" || c === "\n" || c === "\v" || c === "\f";

/**
 * Where the shell word that starts at `from` ends: the first unquoted
 * whitespace, `;`, `|`, `<`, `>`, unmatched `)`, or a `&` that is an operator
 * (a `&` inside `?a=1&b=2` is not). Quotes, `$(…)`, `${…}`, backticks and
 * backslash escapes hold a word together. `outer` is the quote around `from`:
 * its closing mark ends the word. A word that never closes runs to the end.
 * One left-to-right pass, so linear time on any input.
 */
function wordEnd(line: string, from: number, outer: number): number {
	let inner = PLAIN;
	let nest = 0;
	let tick = false;
	for (let i = from; i < line.length; i++) {
		const c = line[i];
		if (inner === WITHIN_SINGLE) {
			if (c === "'") inner = PLAIN;
			continue;
		}
		if (inner === WITHIN_DOUBLE) {
			if (c === "\\") i++;
			else if (c === '"') inner = PLAIN;
			continue;
		}
		if (inner === WITHIN_ESCAPED) {
			if (c === "\\" && line[i + 1] === '"') {
				inner = PLAIN;
				i++;
			}
			continue;
		}
		if (c === "\\") {
			if (line[i + 1] === '"') inner = WITHIN_ESCAPED;
			i++;
			continue;
		}
		if (c === '"') {
			if (outer === IN_DOUBLE) return i;
			inner = WITHIN_DOUBLE;
			continue;
		}
		if (c === "'") {
			if (outer === IN_SINGLE) return i;
			inner = WITHIN_SINGLE;
			continue;
		}
		if (c === "`") {
			tick = !tick;
			continue;
		}
		if (c === "$" && (line[i + 1] === "(" || line[i + 1] === "{")) {
			nest++;
			i++;
			continue;
		}
		if (nest > 0) {
			if (c === "(" || c === "{") nest++;
			else if (c === ")" || c === "}") nest--;
			continue;
		}
		if (tick) continue;
		if (isSpace(c) || WORD_TERMINATORS.has(c)) return i;
		if (c === "&" && (i + 1 === line.length || line[i + 1] === "&" || isSpace(line[i + 1]) || line[i + 1] === ")")) return i;
	}
	return line.length;
}

/** The kinds of flag value a tool takes. `word` is the whole value; `userpass`
 *  is `user:password`, of which only the password goes. */
type FlagKind = "word" | "userpass";

interface ToolFlag {
	/** Each must appear in the line before the flag: the command (and its subcommand). */
	needs: readonly RegExp[];
	/** The flag, through the separator, ending where its value starts. */
	flag: RegExp;
	kind: FlagKind;
}

/** A short flag glued to its value or followed by it: `-pX`, `-p X`. */
const P_FLAG = /(?<![A-Za-z0-9_-])-p[ \t]*(?=\S)/gu;
/** The container CLIs that have a `login`. */
const REGISTRY_CLI = /\b(?:docker|podman|nerdctl|buildah|skopeo)\b/u;

/**
 * Tools whose password sits in a flag whose name says nothing. Each is tied
 * to its command, because `-p` is a port for `ssh`, a mode for `mkdir` and a
 * publish for `docker run`; a line that names the command and is a false match
 * only over-redacts.
 */
const TOOL_FLAGS: readonly ToolFlag[] = [
	{ needs: [/\bcurl\b/u], flag: /(?<![A-Za-z0-9_-])(?:-[A-Za-z]*[uU]|--user(?![A-Za-z-])|--proxy-user(?![A-Za-z-]))(?:=|[ \t]+)?(?=\S)/gu, kind: "userpass" },
	{ needs: [/\bsshpass\b/u], flag: P_FLAG, kind: "word" },
	{ needs: [REGISTRY_CLI, /\blogin\b/u], flag: P_FLAG, kind: "word" },
	{ needs: [/\b(?:mysql|mysqldump|mysqladmin|mysqlimport|mysqlcheck|mysqlshow|mariadb|mariadb-dump|mariadb-admin)\b/u], flag: /(?<![A-Za-z0-9_-])-p(?=[^\s=-])/gu, kind: "word" },
	{ needs: [/\bredis-cli\b/u], flag: /(?<![A-Za-z0-9_-])-a[ \t]+(?=\S)/gu, kind: "word" },
	{ needs: [/\bopenssl\b/u], flag: /(?<![A-Za-z0-9_-])-pass(?:in|out)?[ \t]+["']?pass:/gu, kind: "word" },
	{ needs: [/\bopenssl\b/u], flag: /(?<![A-Za-z0-9_-])-k[ \t]+(?=\S)/gu, kind: "word" },
	{ needs: [/\bssh-keygen\b/u], flag: /(?<![A-Za-z0-9_-])-[NP][ \t]+(?=\S)/gu, kind: "word" },
];

/** Where the quote that encloses `from` closes: the end of the line when
 *  nothing encloses it or the quote never closes. */
function closingQuoteAt(line: string, from: number, quote: number): number {
	if (quote === OUTSIDE) return line.length;
	const mark = quote === IN_SINGLE ? "'" : '"';
	for (let i = from; i < line.length; i++) {
		if (line[i] === "\\" && quote === IN_DOUBLE) i++;
		else if (line[i] === mark) return i;
	}
	return line.length;
}

/** The spans of one line that hold a secret value. */
function lineSpans(line: string): Span[] {
	const spans: Span[] = [];
	let quotes: Uint8Array | undefined;
	const wordSpan = (from: number): Span | undefined => {
		quotes ??= enclosingQuotes(line);
		const end = wordEnd(line, from, quotes[from]);
		return end > from ? { start: from, end } : undefined;
	};
	// How far the last value reached: a name inside it (the `TOKEN:` of
	// `TOKEN=${TOKEN:-x}`) is part of that value, not a second secret.
	let covered = 0;
	const addWord = (from: number): void => {
		const span = wordSpan(from);
		if (span === undefined) return;
		spans.push(span);
		covered = Math.max(covered, span.end);
	};
	// The value of a flag is the word after it. When that word is another flag
	// the value is not adjacent (a boolean such as `--password-stdin`, or an
	// action key that sorts its flags ahead of the arguments), so it could be
	// anywhere after: the rest of the line goes.
	const flagValue = (from: number, flag: string): Span | undefined => {
		if (line[from] !== "-") return wordSpan(from);
		return /stdin$/iu.test(flag) ? undefined : { start: from, end: line.length };
	};

	for (const match of line.matchAll(NAME_THEN_SEPARATOR)) {
		const [text, name, closingQuote, gap, separator, after] = match;
		if (match.index < covered || !isSecretMarker(name)) continue;
		const start = match.index + text.length;
		// `NAME=value` with nothing around the `=` is a shell assignment, whose
		// value ends with its word. Anything looser (`password = x`,
		// `"password": "x"`, `Authorization: …`) is a config line, a JSON field
		// or a header with no word grammar, and takes the rest of the line.
		const assignment = separator === "=" && closingQuote === undefined && gap === "" && after === "" && !HEADER_MARKER.test(name);
		if (assignment) {
			addWord(start);
			continue;
		}
		// A header or field inside a quoted argument, `-H "Authorization: …"`,
		// ends where that argument does; otherwise nothing bounds it.
		quotes ??= enclosingQuotes(line);
		const end = closingQuoteAt(line, start, quotes[start]);
		spans.push({ start, end });
		if (end === line.length) break;
		covered = Math.max(covered, end);
	}
	for (const match of line.matchAll(FLAG_THEN_VALUE)) {
		const span = isSecretMarker(match[1]) ? flagValue(match.index + match[0].length, match[1]) : undefined;
		if (span !== undefined) spans.push(span);
	}
	for (const match of line.matchAll(CONFIG_SET)) {
		if (isSecretMarker(match[1])) addWord(match.index + match[0].length);
	}
	for (const tool of TOOL_FLAGS) {
		const after = tool.needs.map(need => line.search(need));
		if (after.some(index => index < 0)) continue;
		const floor = Math.max(...after);
		for (const match of line.matchAll(tool.flag)) {
			if (match.index <= floor) continue;
			const start = match.index + match[0].length;
			const span = flagValue(start, "");
			if (span === undefined) continue;
			if (tool.kind === "word" || line[start] === "-") spans.push(span);
			else spans.push(...passwordOfPair(line, span));
		}
	}
	return spans;
}

/** `user:password` in a word: the password. A quoted pair goes whole, since
 *  its closing quote would otherwise be left dangling. */
function passwordOfPair(line: string, word: Span): Span[] {
	if (line[word.start] === '"' || line[word.start] === "'") return [word];
	// Searched inside the word only: an indexOf to the end of the line is
	// quadratic when a line holds many words and no colon.
	const colon = line.slice(word.start, word.end).indexOf(":");
	return colon >= 0 && word.start + colon + 1 < word.end ? [{ start: word.start + colon + 1, end: word.end }] : [];
}

/** Replace each span with REDACTED. Spans that overlap or touch become one. */
function applySpans(text: string, spans: Span[]): string {
	if (spans.length === 0) return text;
	const sorted = [...spans].sort((a, b) => a.start - b.start || a.end - b.end);
	let out = "";
	let at = 0;
	let open: Span | undefined;
	const close = (): void => {
		if (open === undefined) return;
		out += `${text.slice(at, open.start)}${REDACTED}`;
		at = open.end;
	};
	for (const span of sorted) {
		if (open !== undefined && span.start <= open.end) open = { start: open.start, end: Math.max(open.end, span.end) };
		else {
			close();
			open = span;
		}
	}
	close();
	return out + text.slice(at);
}

/**
 * Redact one line: the value of every secret it names, and no more of the line
 * than that. A shell assignment or a flag's value ends with its shell word, so
 * `export TOKEN=x && rm -rf build` keeps the `rm`. A form with no word grammar
 * (a JSON field, a header, `password = x`) takes the rest of the line, whatever
 * the scheme or quoting after it, which errs toward redacting too much:
 * `{"password":"x","user":"bob"}` loses `bob`. Every name on the line is asked,
 * so a harmless `https:` before a `token=` doesn't hide it.
 */
function redactLine(line: string): string {
	return applySpans(line, lineSpans(line));
}

/** Every span of a multi-line text, in the text's own offsets. */
function textSpans(text: string): Span[] {
	const spans: Span[] = [];
	for (const match of text.matchAll(/[^\r\n]+/gu)) {
		for (const span of lineSpans(match[0])) spans.push({ start: match.index + span.start, end: match.index + span.end });
	}
	return spans;
}

const RULES: readonly Rule[] = [
	// A private key block, whole. An unterminated block runs to the end.
	// PEM and PGP armor both: `PRIVATE KEY` and `PRIVATE KEY BLOCK`.
	{ pattern: /-----BEGIN [A-Z0-9 ]*PRIVATE KEY(?: BLOCK)?-----[\s\S]*?(?:-----END [A-Z0-9 ]*PRIVATE KEY(?: BLOCK)?-----|$)/gu, replace: whole },
	// The value of every secret on each line (see redactLine).
	{ pattern: /[^\r\n]+/gu, replace: line => redactLine(line) },
	{ pattern: /\b(bearer\s+)[^\s"'\\,;]{8,}/giu, replace: (_m, keep) => `${keep}${REDACTED}` },
	// Token formats with a published prefix.
	{ pattern: /\bsk-(?:ant-|proj-)?[A-Za-z0-9_-]{20,}/gu, replace: whole },
	{ pattern: /\b[rs]k_(?:live|test)_[A-Za-z0-9]{16,}/gu, replace: whole },
	{ pattern: /\bgh[oprsu]_[A-Za-z0-9]{30,}/gu, replace: whole },
	{ pattern: /\bgithub_pat_[A-Za-z0-9_]{40,}/gu, replace: whole },
	{ pattern: /\bxox[abopqrs]-[A-Za-z0-9-]{10,}/gu, replace: whole },
	{ pattern: /\bAKIA[0-9A-Z]{16}\b/gu, replace: whole },
	{ pattern: /\bAIza[0-9A-Za-z_-]{35}/gu, replace: whole },
	{ pattern: /\bglpat-[A-Za-z0-9_-]{20,}/gu, replace: whole },
	{ pattern: /\bnpm_[A-Za-z0-9]{36}/gu, replace: whole },
	{ pattern: /\bya29\.[A-Za-z0-9_-]{20,}/gu, replace: whole },
	{ pattern: /\bshp(?:at|ca|pa|ss)_[A-Za-z0-9]{24,}/gu, replace: whole },
	{ pattern: /\bhf_[A-Za-z0-9]{30,}/gu, replace: whole },
	{ pattern: /\beyJ[A-Za-z0-9_-]{10,}\.eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/gu, replace: whole },
	// A Slack incoming webhook: the path after the host is the credential.
	{ pattern: /(\bhooks\.slack\.com\/services\/)[A-Za-z0-9_/-]+/gu, replace: (_m, head) => `${head}${REDACTED}` },
	// The password in a URL's userinfo. The user and host stay. The password
	// runs to the last `@` before the path, query or fragment, so one that
	// contains `@` does not leak its tail.
	{ pattern: /((?<![a-z0-9+.-])[a-z][a-z0-9+.-]*:\/\/[^\s:/@]+:)[^\s/?#]+(@)/giu, replace: (_m, head, at) => `${head}${REDACTED}${at}` },
];

const ARGV_QUOTE_FREE = /^[A-Za-z0-9_@%+=:,./-]+$/u;
const quoteArg = (arg: string): string => (ARGV_QUOTE_FREE.test(arg) ? arg : `'${arg.replaceAll("'", "'\\''")}'`);

/**
 * The elements of an argv array that hold a secret. The array is read as the
 * command line it stands for, quoted so each element is one shell word, and
 * the element a secret span lands on is the one flagged. Whatever an element
 * names itself is redacted on its own pass.
 */
function argvSecrets(argv: readonly string[]): boolean[] {
	const offsets: Array<[number, number]> = [];
	let joined = "";
	for (const arg of argv) {
		if (joined !== "") joined += " ";
		const quoted = quoteArg(arg);
		offsets.push([joined.length, joined.length + quoted.length]);
		joined += quoted;
	}
	const spans = textSpans(joined).sort((a, b) => a.start - b.start);
	// Both lists ascend, so one sweep pairs them: linear in the array.
	const flagged: boolean[] = [];
	let first = 0;
	for (const [start, end] of offsets) {
		while (first < spans.length && spans[first].end <= start) first++;
		flagged.push(first < spans.length && spans[first].start < end);
	}
	return flagged;
}

/** A bare name or a header name with its colon: `DB_PASSWORD`, `Authorization:`. */
const BARE_NAME = /^[A-Za-z0-9_.-]+:?$/u;
const PAIR_NAME_FIELDS = new Set(["name", "key", "header", "variable", "var"]);
const PAIR_VALUE_FIELDS = new Set(["value", "val"]);

const isSecretLabel = (label: unknown): boolean => typeof label === "string" && BARE_NAME.test(label) && isSecretMarker(label.replace(/:$/u, ""));

const isScalar = (value: unknown): boolean => typeof value === "string" || typeof value === "number";

function redactArray(items: readonly unknown[]): unknown[] {
	const out = items.map(redactValue);
	// A `[header, value]` pair: the value of a secret-named header.
	if (items.length === 2 && isSecretLabel(items[0]) && isScalar(items[1])) out[1] = REDACTED;
	// An argv array: the element a secret flag or `-u user:pass` points at.
	if (items.length >= 2 && items.every(item => typeof item === "string")) {
		const secret = argvSecrets(items as string[]);
		for (let i = 0; i < out.length; i++) if (secret[i] && out[i] === items[i]) out[i] = REDACTED;
	}
	return out;
}

/** The value key of a `{name, value}`-style pair whose name is a secret. */
function secretPairValueKey(entries: ReadonlyArray<[string, unknown]>): string | undefined {
	if (!entries.some(([key, inner]) => PAIR_NAME_FIELDS.has(key.toLowerCase()) && isSecretLabel(inner))) return undefined;
	return entries.find(([key]) => PAIR_VALUE_FIELDS.has(key.toLowerCase()))?.[0];
}

/**
 * Redact a structured value before it is serialized: every value under a
 * secret-sounding key is replaced whole, whatever its content, and every other
 * string goes through redactSecrets. Tool-call arguments take this path, so
 * an escaped quote inside a password can't end its redaction early. A secret
 * carried by position rather than by key is read too: the element after a
 * secret flag in an argv array, the value of a `{name, value}` entry, and the
 * value of a `[header, value]` pair.
 */
export function redactValue(value: unknown): unknown {
	if (typeof value === "string") return redactSecrets(value);
	if (Array.isArray(value)) return redactArray(value);
	if (value === null || typeof value !== "object") return value;
	const entries = Object.entries(value);
	const pairValue = secretPairValueKey(entries);
	return Object.fromEntries(entries.map(([key, inner]) => [key, isSecretMarker(key) || key === pairValue ? REDACTED : redactValue(inner)]));
}

export function redactSecrets(text: string): string {
	let out = text;
	for (const rule of RULES) out = out.replace(rule.pattern, rule.replace);
	return out;
}
