# Stage 2: bind a reviewer allow to the shell state it was judged against

## Problem

PR https://github.com/STRML/omp-classifier/pull/225 stops the stage 2 reviewer
for the rest of a session once any bash call matches `touchesShellEnv`. That
predicate was written for https://github.com/STRML/omp-classifier/issues/176
and matches almost anything: `NOW=$(date +%s)`, `command -v`, any arithmetic.

These counts come from `decisions.jsonl` and the session transcripts, 2026-11-01 to 2026-11-04:

- Since Nov 1, 14 of 42 stage 2 outcomes were "skip: the session's shell may
  resolve names differently than the gate".
- The DOPL session (ads-location) set the latch on its first call. After that,
  the gate refused 13 branch-5 UNSUREs (`tar -xf`, `yt-dlp`, `curl` to a local
  model server) without review.

## What review rounds 1 and 2 established

| Round | Design | Fatal finding |
|---|---|---|
| 1 | sort earlier calls by their text | `printf -v "b[w]"`, `unset "a[w]"`, `$((PATH=7))`, `PS4`+`set -x`, `export GIT_SSH_COMMAND` all land in the harmless class |
| 2 | compare the shell with a baseline at gate time | (a) the agent loop gates every call in a message before any runs, so `export X; <UNSURE>` in one message is judged on stale state; (b) the reviewer's await leaves a window before execution; (c) the baseline trusts rc-loaded aliases, functions and PATH, and is retaken from a snapshot file the agent can write; (d) `enable -n` and `~-` (OLDPWD) escape the compared state |

Two conclusions follow. A check at gate time cannot vouch for state at run
time, so the allow must be checked again where the command runs, under the
shell's lock. And "same as the baseline" is the wrong question. The question
the reviewer needs answered is "does each program word run the file the gate
read", and only the live shell can answer it.

## Design

```
gate (stageTwo)                                   host bash tool (executeBash)
───────────────                                   ────────────────────────────
coarse latch on THIS command ─▶ skip
inspect(names) on live shell ─┬─ mismatch ─▶ skip
                              └─ match ─▶ reviewer ─▶ allow
                                           │
                                           └─▶ return input + shellState=<fingerprint>
                                                                       │
                                               session lock ─▶ fingerprint now == token? ─┬─ yes ─▶ run
                                                                                          └─ no ──▶ refuse
```

1. **pi-shell (Rust, fork)**. Two methods on `Shell`, both taking the session lock:
   - `inspect(names) -> { fingerprint, resolution, exportsChanged, snapshotChanged, home, path }`.
     `resolution[name]` is how the live shell would run `name` right now:
     `alias`, `function`, `builtin`, `disabled-builtin`, `keyword`, `file:<path>`,
     or `missing`. It applies brush's own lookup order, including the program
     location cache. `exportsChanged` lists exported names whose value differs
     from the session's first build. `snapshotChanged` is true when the
     snapshot file's SHA-256 differs from the hash taken when this `Shell` was
     first built. Both the export baseline and the snapshot hash are pinned
     once per `Shell` object and never retaken, so a rebuild after a timeout
     cannot launder an edited snapshot. If no session core exists yet,
     `inspect` builds one, the same way the first `run` would.
   - `fingerprint`: SHA-256 over every variable (name, attributes, value, and
     every array element), the alias, function and builtin tables (including
     disabled flags), traps, `set -o`/`shopt` options, the location cache, the
     directory stack, umask, and ulimits. It does not cover the per-run env
     overlay, which the host re-applies in a scope it pops after each run.
     Volatile names that change on their own (`RANDOM`, `SRANDOM`, `SECONDS`,
     `EPOCHSECONDS`, `EPOCHREALTIME`, `LINENO`) are left out. `_`, `OLDPWD`,
     `BASH_REMATCH` and `PIPESTATUS` stay in, since each carries content
     across calls.
   - `run` takes an optional `expect_fingerprint`. Under the same lock, before
     anything executes, `run` recomputes the fingerprint and returns a
     distinct `StateChanged` result without running when it differs.
2. **pi-natives (napi)**: `inspect(names)` and `run({ ..., expectFingerprint })`.
3. **coding-agent (fork)**:
   - `bash-executor.ts` exports `inspectShellSession(agentSessionKey, names)`.
     It finds the persistent shell the next call would use (same key
     construction as `executeBash`). It returns `undefined` when the next call
     would get a one-shot shell (the session is busy or broken), since no
     state can be bound to that shell.
   - The bash tool accepts an internal `shellState` input field, which is not
     in the model-facing schema. `executeBash` passes it as
     `expectFingerprint`. A run that comes back `StateChanged` becomes a tool
     error: "the shell changed after this command was reviewed; run it again".
     When `shellState` is set, a busy or broken session refuses instead of
     falling back to a one-shot shell.
4. **omp-classifier (`stageTwo`)**: skip the review (keep the stage-1 block) when any of these holds:
   - the installed host lacks `inspectShellSession`: fall back to today's
     `shellEnvTouched` latch, unchanged;
   - a shell prefix is set, or an `.envrc` loads (today's rule);
   - this command itself matches `touchesShellEnv`, or uses `${!`, `@P}`,
     `compgen`, `complete`, `mapfile -C`/`readarray -C`, a `-v` operand to
     `[` or `test` (it evaluates a subscript), or a tilde form other
     than `~` and `~/` (`~-`, `~+`, `~N`, `~user`). These are the forms whose
     meaning depends on shell state that the shape checks cannot read;
   - `inspectShellSession` returns `undefined` or throws;
   - `snapshotChanged`, or `exportsChanged` is non-empty;
   - `home` differs from `os.homedir()`, or `path` has an empty or relative
     entry (names resolve on that `path`; see the 2026-11-05 amendment);
   - any program word, wrapper or interpreter the shape checks resolved has a
     `resolution` other than `file:<the path onPath returned>` (or `builtin`
     for a name the gate treats as a builtin).
   Otherwise the review runs. On an allow, `stageTwo` returns `{ input: {
   ...event.input, shellState: fingerprint } }`, and the host enforces it.
   `shellEnvTouched` still feeds the TMPDIR read and the critical scan.

The floor, every threshold, the critical-pattern scan and the stage-1 SAFE path
stay as they are. https://github.com/STRML/omp-classifier/issues/253 tracks
the stage-1 gap, and the same `inspect` call can close it later.

## Round 3 amendments (binding; they override the sections above where they differ)

Round 3 (Codex pentester, Claude pentester, both REVISE) found holes that the
run-time check cannot close. The plan takes these changes:

1. **State that is already set and runs code.** `inspect` reports `hooks`: every
   trap, `PS4` while `xtrace` is on, and a non-empty `BASH_ENV`, `ENV`,
   `CDPATH`, `PROMPT_COMMAND` or `IFS` that differs from the default. It also
   reports every option that differs from a fresh session's. When any of these
   is present, the gate skips the review. The fingerprint only catches changes
   made after the gate; this rule catches state that was already present.
2. **The reviewed command's own text.** `hiddenArithmetic(command)` joins
   `touchesShellEnv` in the current-command check. It covers `$[w]`, `${*:w}`
   and `${@:w}`, which `touchesShellEnv` misses.
3. **File contents are part of the token.** The token is
   `{ state: <fingerprint>, files: [{ path, sha256 }] }`. `files` holds every
   script body the reviewer read and every program file that resolution named.
   The host re-hashes each file under the session lock before it submits, and
   refuses on any mismatch. This closes the same-message `write` swap and
   https://github.com/STRML/omp-classifier/issues/254.
4. **Routes.** The gate skips the review when the bash input sets `pty`,
   `async`, or a service `name`. The host refuses a `shellState` on every route
   except a persistent foreground run, and it never falls back to a one-shot
   shell when the token is set.
5. **Every command-position word goes to `inspect`.** That includes words in
   substitutions, path-shaped words (a function can be named `./x.sh`), and the
   `cd` of a leading `cd`. Resolution must be `file:<path the gate read>`, or a
   builtin the engine reports as an intrinsic or a tool.
6. **No core, no review, no token run.** `inspect` never builds a core. If no
   core exists, it returns `undefined` and the gate skips. A token-bearing run
   that finds no core is refused, so it never sources the snapshot.
7. **The gate strips any incoming `shellState`** on every return path. It sets
   the field only on its own allow.

## Amendment 2026-11-05: names resolve on the live PATH

The first live run skipped with "the session's shell has a different PATH".
A session's PATH comes from the rc snapshot, so it never equals the PATH omp
was launched with (it repeats and reorders entries). Requiring equality ruled
out every session. The gate now resolves bare names, wrappers and scripts on
the PATH the shell reported (`withSearchPath`), drops the equality check, and
skips only when that PATH has an empty or relative entry. A word still has to
resolve to the same file in both lookups.

The same live run found that the loop writes the gate's revised input back
into the assistant message (`pi-agent-core` `agent-loop.ts`,
`toolCall.arguments = beforeResult.args`). The model then sees `shellState`
in its history and copies it into the next call. Refusing that call (the
first cut of amendment 7) turned every reviewer allow into a refusal on the
following call, so the gate now strips a copied token and judges the call
without it. An allow returns the stripped input, so the host never enforces a
token the gate did not set on this call.

Two limitations are accepted and documented:

- A later extension's `tool_call` handler can replace the input and drop the
  token. No installed extension does this, and the host logs it.
- The direnv overlay is computed at run time. Exploiting it needs a
  `direnv allow`, which is a judged call of its own, and `.envrc` already
  skips the review.

## Failure matrix

| State or input | What happens | How it can fail | What the caller is told |
|---|---|---|---|
| fresh session, UNSURE `tar -xf a.tar` | inspect builds the core; `tar` resolves to `file:/usr/bin/tar`, as the gate resolves it; review; allow carries the fingerprint; the run matches | n/a | the reviewer's verdict, and it runs |
| earlier `NOW=$(date +%s); echo $((NOW-1))`, then UNSURE `tar` | no exports changed; resolution matches; review | n/a | the reviewer's verdict |
| earlier `export PATH=x:$PATH` | `exportsChanged: [PATH]` | n/a | skip, names `export:PATH` |
| earlier `export GIT_SSH_COMMAND=…`, then `git fetch` | `exportsChanged` | n/a | skip |
| earlier `alias tar=./x`, `tar(){…}`, `hash -p ./x tar`, `enable -n git` | `resolution[tar or git]` is not the gate's file | n/a | skip, names the resolution |
| rc file defines `tar()` or prepends to PATH (snapshot) | resolution or `path` mismatch | over-blocks a user with rc functions, which is correct | skip |
| agent edits the snapshot, then forces a rebuild | `snapshotChanged` | n/a | skip |
| one message holds `export X=1` then the UNSURE call | gated on stale state; allow carries the fingerprint; the export runs first, so the fingerprint differs at run time | n/a | tool error: "shell changed after review" |
| another call mutates the shell while the reviewer runs | same | n/a | tool error |
| reviewed command is `echo $((PATH=7)); tar` | `touchesShellEnv` on this command | n/a | skip |
| reviewed command uses `~-/x.py`, `${!n}`, `${y@P}`, `compgen -C` | the rule for this command | n/a | skip |
| earlier `w='PATH=7'`, reviewed command has no arithmetic | nothing in this command evaluates `w` | n/a | review runs (`w` is inert without an evaluation) |
| session busy or broken at gate time | inspect returns `undefined` | n/a | skip |
| session busy at run time with `shellState` set | the host refuses rather than using a one-shot shell | n/a | tool error |
| host without the API (upstream omp, older fork) | today's latch | n/a | today's reasons |
| inspect throws, or the stage 2 deadline expires while it waits on the lock | skip | n/a | "shell state unavailable" |
| `shellState` on a non-bash tool or a malformed value | the bash tool rejects malformed values; other tools ignore it | n/a | tool error |
| the model writes or copies `shellState` into its own bash input | the gate strips it before judging, returns the stripped input on an allow, and sets the field only on its own allow | n/a | the call's own verdict |

## Tests

- Rust (`bun run test:rs`, pi-shell): resolution for each kind (alias,
  function, builtin, disabled builtin, a cached path, file); the fingerprint
  changes on each state class and does not change on a volatile name;
  `expect_fingerprint` mismatch returns `StateChanged` without executing (a
  marker file is not created); export baseline and snapshot hash survive a
  rebuild.
- Host: `inspectShellSession` returns `undefined` for a busy session; a
  `shellState` mismatch surfaces as a tool error; a model-supplied `shellState`
  is not in the tool schema.
- Plugin (`tests/reviewer.test.ts`, host functions stubbed with `spyOn`): one
  test per matrix row on the gate side. The existing #225 tests stay green
  under the fallback.
- E2E artifact: replay the DOPL transcript's bash calls through a real
  `Shell`, call `inspect` before each historical branch-5 refusal, and count
  how many would have reached the reviewer.

## Install

Fork-local commits go onto fork main from a dedicated worktree. Installing
them means `fork-sync.sh`, which replaces the `omp` binary every live session
uses, and that needs Sam's go-ahead. Until then, the plugin runs on the
fallback.
