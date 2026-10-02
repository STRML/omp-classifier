> Generated: 2026-10-01 | Token-lean format for LLM context

# L0 evidence + L1 recognition modules

Deterministic code that never calls a model. A shell parse that fails returns `{ok:false}`, which
every caller reads as "not read" (fail closed).

## shell-ast.ts (923 lines): the only owner of `mvdan-sh`

| Export | Line | Called by |
|---|---|---|
| `parseShell(text)` → `{ok, commands: ShellCommand[]}` or `{ok:false, reason}` | 305 | index, jev, floor, authorization, literal-match, recognizer, shell-cwd, eval/recognizer-measure |
| `ShellCommand` / `ShellWord` / `ShellRedirect` / `ShellAssign`, `ShellJoin` (first/pipe/and/or/sequence) | 198-296 | types everywhere |
| `verbOf(cmd)` / `verbName(cmd)` | 767/775 | floor, recognizer / floor |
| `substitutionSpans(text)` | 798 | index (overlay, outbound), authorization |
| `shellSubstitutionRanges(text)` | 832 | shell-cwd |
| `setShellParserLoader(loader)` | 163 | tests (shell-ast-load) |
| `SHELL_OPERATORS` | 186 | — |

The parser loads lazily through `createRequire`. If the load fails, every parse returns `ok:false`
and the plugin still loads. `ShellCommand.unreadShape` marks a construct the adapter cannot
flatten.

## shell-cwd.ts (1083 lines): one cwd walk for all readers

| Export | Line | Called by |
|---|---|---|
| `maskHeredocBodiesAndAnsiSpans(cmd)` → `{masked,…}` | 165 | index (script reader, overlay), jev (push/network tiers) |
| `segmentWorkingDirectories(...)` | 1000 | index `readInterpretedScriptBodies` |
| `segmentCwdAt(...)` | 1044 | jev (provenance tiers) |
| `segmentCwdLookup(...)` | 1054 | floor |
| `heredocShadowedAt`, `openQuoteBefore` | 106/325 | index `withoutWrittenHeredocBodies` |
| `SHELL_WORD_EXPANSION`, `CwdResolver`, `defaultCwdResolver` | 38/531/534 | index, jev |

A directory the text cannot pin is `null`, never a guess. Callers inject the resolver: index uses
the host's `resolveToCwd`, the network tier uses `node:path`.

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

## redact.ts (165 lines)

| Export | Line | Called by |
|---|---|---|
| `redactSecrets(text)` | 161 | jev `buildJevState` (evidence only), index audit `cmd` + logger, authorization, eval/recognizer-measure |
| `redactValue(value)` | 154 | index `collectToolEvidence` |
| `isSecretName(name)` | 81 | floor (single definition of a secret name) |
| `REDACTED` = `[redacted]` | 15 | authorization |

The judged command is never redacted. The copy written to the audit log is.

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
| `readInterpretedScriptBodies(cmd, cwd, limit)` | 3775 | splices interpreter script bodies into the judged text, or refuses | bash path step 4 |
| `withoutWrittenHeredocBodies(cmd)` | 3358 | drops heredoc bodies written to files before scanning | overlay, outbound |
| `commandHasOutboundNetwork(cmd)` | 1418 | outbound network classifier | tests only (no production caller) |
| `bashApprovalRuleMatches` / `commandMatchesBashApprovalPattern` | 568/546 | host static-rule matching | bash path step 2 |
| `INTERPRETER_CODE_RISK` | 2018 | regex over a script body that re-execs or decodes | bash SAFE branch |
