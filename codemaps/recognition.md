> Generated: 2026-10-01 | Token-lean format for LLM context

# L0 evidence + L1 recognition modules

Deterministic code that never calls a model. A shell parse that fails returns `{ok:false}`, which
every caller reads as "not read" (fail closed).

## shell-ast.ts (1126 lines): the only owner of `mvdan-sh`

| Export | Line | Called by |
|---|---|---|
| `parseShell(text)` → `{ok, commands: ShellCommand[]}` or `{ok:false, reason}` | 305 | index, jev, floor, authorization, literal-match, recognizer, shell-cwd, eval/recognizer-measure |
| `ShellCommand` / `ShellWord` / `ShellRedirect` / `ShellAssign`, `ShellJoin` (first/pipe/and/or/sequence) | 198-296 | types everywhere |
| `verbOf(cmd)` / `verbName(cmd)` | 767/775 | floor, recognizer / floor |
| `substitutionSpans(text)` | 798 | index (overlay, outbound), authorization |
| `shellSubstitutionRanges(text)` | 832 | shell-cwd |
| `shellDefinesFunction(text)` | 368 | index (`touchesShellEnv`) |
| `shellLayout(text)` → `{comments, heredocBodies, deferred, functions}` or null | 968 | shell-cwd (masker), index `readInterpretedScriptBodies` |
| `setShellParserLoader(loader)` | 163 | tests (shell-ast-load) |
| `SHELL_OPERATORS` | 186 | — |

The parser loads lazily through `createRequire`. If the load fails, every parse returns `ok:false`
and the plugin still loads. `ShellCommand.unreadShape` marks a construct the adapter cannot
flatten. `shellLayout` uses a second parser that keeps comments; null means the text could not be
laid out (syntax error, a tree too deep to walk, an empty heredoc whose closer is not where expected).

## critical-scan.ts (247 lines): what the critical patterns read

| Export | Line | Called by |
|---|---|---|
| `scanCriticalPatterns(command, bodies, shellTrusted)` → `{critical, unrecorded, judgedBodies}` | 229 | index (bash step 5) |
| `criticalScanText(command, shellTrusted?)`: the raw text with `git commit` message words blanked in place | 158 | tests |
| `commandMatchesCriticalPattern(command, shellTrusted?)` | 180 | eval/run (`riskFlagsFor`) |
| `matchesCriticalPattern(text)`, `CRITICAL_BODY_NOTE` | 30/243 | index |

Blanking runs only when the session's shell is trusted (index passes `!shellEnvTouched.has(session)`,
false with no session id), the parse succeeds and runs in source order, and every command is a plain
`git add|commit|log|status` (`isPlainGit`): all words `fixed`, flags on `GIT_FLAGS`, no env prefix, no
redirect but `2>&1`/`>&2`/`>/dev/null`. Otherwise the whole text is scanned. A shell body's hit is
`critical`. A `node`/`bun`/`deno`/`python*` body's hit (no shell extension or shebang) is `unrecorded`
when the body names a process API (`PROCESS_API`), else it goes to `judgedBodies`, which index turns
into a step-16 risk flag.

## shell-cwd.ts (1182 lines): one cwd walk for all readers

| Export | Line | Called by |
|---|---|---|
| `maskHeredocBodiesAndAnsiSpans(cmd)` → `{masked, bodies, quoted, lost}` | 200 | index (script reader, overlay), jev (push/network tiers), floor |
| `directoryChangesAgree(masked, commands, deferred)`, `commandMayChangeDirectory(words)` | 1101/1097 | index `readInterpretedScriptBodies` |
| `segmentWorkingDirectories(...)` | 1000 | index `readInterpretedScriptBodies` |
| `segmentCwdAt(...)` | 1044 | jev (provenance tiers) |
| `segmentCwdLookup(...)` | 1054 | floor |
| `heredocShadowedAt`, `openQuoteBefore` | 106/325 | index `withoutWrittenHeredocBodies` |
| `SHELL_WORD_EXPANSION`, `CwdResolver`, `defaultCwdResolver` | 38/531/534 | index, jev |

A directory the text cannot pin is `null`, never a guess: an expansion, a target that is not an
existing directory, or a bare name while CDPATH is set. Callers inject the resolver: index uses
the host's `resolveToCwd`, the network tier uses `node:path`. The masker blanks comments and heredoc
bodies from `shellLayout` when the parse succeeds, and falls back to text (`lost` when it blanked to
EOF) when it does not.

## floor.ts (719 lines): the code floor (shadow)

`evaluateFloor({command, language, cwd?, scriptSource?, taintedVars?})` → `{asks, findings,
tainted}` (line 151). Pure: taint goes in and comes out as values. Caller: index `shadowFloor`
(index.ts:5706), which keeps per-session taint in `floorTaint`, and recognizer.

| `FloorEntry` | Trigger |
|---|---|
| `critical` | host `CRITICAL_BASH_PATTERNS` |
| `secret-sink` | a secret (store read, secret path, tainted var) reaching a sink outside the 4 allowed ones: `$(…)` capture, `/dev/null`, curl auth header or `-u`, `--password-stdin` |
| `download-to-interpreter` | a download piped into an interpreter |
| `obfuscated-code` | obfuscation scan |
| `unread-command` | parser `unreadShape`, or (in index) over the length cap |

`language:"code"` (eval) runs `scanCode`, which reads text only because it cannot trace sinks.
Other exports: `secretStoreRead` (95), `secretVariableNames` (102), `secretPathIn` (562),
`isSecretPath` (608), used by authorization, recognizer and literal-match.

## literal-match.ts (419 lines): the user's own words cover every segment

`literalMatch(input)` (line 109) → `{matched, actions, incomplete, reason}`. Caller: index
`shadowJevV3` only (shell language), which feeds `deriveDecisionOrder` branch 4.
- Extracted kinds: `delete` (rm/trash/unlink inside cwd or the session temp dir), `branch-delete`,
  `merge` (`gh pr merge <n>`), `deploy` (a script inside cwd).
- Inert verbs: ls, pwd, true, cat, echo, and git status/diff/log/show/branch. A redirect, glob,
  brace or substitution makes a segment non-inert.
- Words: whole-word imperative or present forms (`VERB_FORMS`); `CANCEL_WORDS` within
  `CANCEL_WINDOW=5` cancel a match; `PAIR_WINDOW=6`; `WIDENING_FLAG` (`--force`, `--admin`, …).
- Pinned or inherited messages never match; only the recent `userMessages` do.

## recognizer.ts (408 lines): routine-shape recognizer (measurement only)

`recognizeRoutineCommand(command, {variant, taintedVars})` (line 267) → `RoutineVerdict
{routine, declinedBy, declines, reasons, verb, floorEntries}`. Rules run in order: unreadable,
segments, operators, substitution, markers, verb, expansion, redirect, assignment, flags,
secret-path, floor. `ROUTINE_VERBS`, `SEARCH_VERBS` (find/grep = `search` variant). Passing
`taintedVars: "unknown"` drops the `echo` exemption. Not imported by index.ts; the only caller is
eval/recognizer-measure.ts.

## redact.ts (553 lines)

| Export | Line | Called by |
|---|---|---|
| `redactSecrets(text)` | 540 | prose: jev `buildJevState` (evidence only), authorization, reviewer transcript/script bodies/stage1, index evidence + judged-states, eval/recognizer-measure. A secret runs to the end of its line |
| `redactCommand(text)` | 551 | shell commands: index audit `cmd` + OMP log line, reviewer `command`. A secret ends at its shell word |
| `redactValue(value)` | 519 | index `collectToolEvidence`: object keys, argv arrays, `{name, value}` and `[header, value]` pairs |
| `isSecretName(name)` | 91 | floor, authorization (single definition of a secret name; trailing digits and `PASS` count) |
| `REDACTED` = `[redacted]` | 15 | authorization |

Per line, `lineSpans(line, shell)` finds the value spans and `applySpans` replaces them. In shell
mode a shell assignment (`NAME=value`) or a flag's value ends at its shell word (`wordEnd`:
quotes, `$(...)`, backticks, `;`, `|`, `&&`), so the command around it survives; a secret flag
followed by flags redacts the first non-flag word (`afterFlags`). A header, JSON field or
`name = value` line has no word grammar: it ends at the closing quote of its enclosing argument,
else the line. Prose mode extends every span to the end of the line. `TOOL_FLAGS` ties `-u`, `-p`,
`-a`, `-pass` to curl, sshpass, docker login, mysql, redis-cli, openssl, ssh-keygen. Linear time:
each `sweep` skips a match inside the value it already took.

The judged command is never redacted. The copy written to the audit log, and the copy the stage 2
reviewer reads, are.

## arity.ts (85 lines) + arity.generated.ts (1558 lines)

`toolGrammar(tool)` → `ToolGrammar` (subcommands, flags that take values, short spellings), and
`generatedTools()`. The only caller is authorization.ts `summarizeActions`. `arity.generated.ts`
is written by `tools/generate-arity.ts` from each CLI's help and completion output. Do not edit
it by hand.

## trust-policy.ts (222 lines): pinned user policy (L0 tier)

| Export | Line | Called by |
|---|---|---|
| `pinUserInstructionFiles(projectDir?)` | 154 | `/classifier trust-policy` |
| `normalizeTrustPolicyPin(value)` | 166 | index config loader |
| `resolvePinnedUserPolicy(pin, projectDir?)` → `{signature, documents}` | 191 | index `resolvePolicyContext` |
| `formatTrustPolicyPin(pin)` | 219 | `/classifier trust-policy` (reports the new pin) |
| `MAX_TRUST_POLICY_BYTES` = 32 KiB | 37 | — |

Pins user-level instruction files by sha256. A changed file goes stale: no documents, and the
signature changes. Repository-local files are never read.

## L1 scanners inside index.ts

| Function | Line | Role | Called from |
|---|---|---|---|
| `matchModerateRiskTokens(cmd, cwd)` | 4279 | destructive-token overlay; a SAFE with flags still asks | bash SAFE branch, late guard, `shadowJevV3`, eval/run |
| `rmForcesDialog(args, cwd)` | 4259 | rm/unlink shapes: recursive, glob, `..`, dotpath, outside cwd | `matchModerateRiskTokens` |
| `evalRiskFlags(code)` | 2095 | eval-code overlay | eval SAFE branch, `shadowJevV3`, eval/run |
| `evalSubprocessMarkers(code, lang)` | 2110 | whether an eval payload spawns at all (JS/PY/RB/JL tables) | eval path entry |
| `evalSpawnCwd(code, cwd)` | 2755 | literal / opaque spawn cwd | eval path |
| `readInterpretedScriptBodies(cmd, cwd, limit)` | 4220 | splices interpreter script bodies into the judged text, or refuses. Text pass over the masked segments, then a parse pass that reads every interpreter program the text pass did not (same resolved file), and refuses on an expanded verb, any command the parser rejects, or a walk that disagrees with the parse | bash path step 4 |
| `withoutWrittenHeredocBodies(cmd)` | 3358 | drops heredoc bodies written to files before scanning | overlay, outbound |
| `commandHasOutboundNetwork(cmd)` | 1418 | outbound network classifier | tests only (no production caller) |
| `bashApprovalRuleMatches` / `commandMatchesBashApprovalPattern` | 568/546 | host static-rule matching | bash path step 2 |
| `INTERPRETER_CODE_RISK` | 2018 | regex over a script body that re-execs or decodes | bash SAFE branch |
