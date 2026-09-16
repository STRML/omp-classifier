# omp-classifier

Model-judged permission checks for OMP's bash tool, and for `eval` payloads that spawn
processes.

In `yolo` mode, OMP auto-approves every bash command. That includes the ones nobody should wave through: `curl … | sh`, `rm -rf /`, `dd of=/dev/…`, `mkfs`, `kill -9 1`, `nc -e`. A second hole compounds it. A `bash.patterns` rule written to prompt on exactly those shapes never fires, because the native gate ranks critical-pattern matches above prompt rules.

This plugin closes both holes. It registers a `tool_call` handler in front of the native bash tool and sends commands that would otherwise run unseen past a small model first. Routine work still runs silently. Dangerous work gets a real Run-or-Deny prompt. For `eval`, the gate classifies only the payloads that spawn a process; expression-only code runs untouched.

The handler only adds friction. It blocks, or it asks. It never bypasses the native gate, weakens your existing rules, or executes anything itself.

The system is one tower of layers: evidence, recognition, judgment, memory, interaction, self-measurement, control. The map, invariants, and roadmap live in [docs/SYSTEM.md](docs/SYSTEM.md).

## How each command is decided

Calls walk this order:

| Match | Result |
|---|---|
| Critical pattern | Permission request in every approval mode. No model call. |
| Caller-supplied `env` | Permission request before any exemption. Env values can carry secrets or choose what runs (`PATH`, `LD_PRELOAD`). |
| `deny` rule, or approval policy `deny` | Untouched. The native gate blocks it. |
| `prompt` rule | Untouched. The native gate prompts, in every mode including `yolo`. |
| Narrow `allow` rule | Untouched. An explicit decision about a specific shape is never re-judged. For a compound line, a `deny`/`prompt` on any segment decides immediately (the native gate blocks or prompts once — no plugin dialog, no classification), an `allow` on every segment runs silent, and only a compound with no deny/prompt decision and an undecided segment classifies. Blanket patterns never vouch for segments; inert fd-dups (`2>&1`) are ignored, but real redirects (`> file`) bar a segment. |
| Blanket `allow` (`*`, `**`, `* *`) or no matching rule | Classified in every mode. SAFE passes to the native gate; UNSAFE or UNSURE raises a plugin request. |
| Granted earlier for this directory | Runs ungated for the rest of the session. A past **Allow for session** answer is user-tier authorization: it outranks classification and refusal memory, but not the critical, env, and static-rule rows above. |
| Longer than 8,000 characters | Blocked outright. Nothing that long can be reviewed in full. |

A normal gate prompt is a four-choice selector — **Allow once**, **Allow for session**, **Always allow**, **Deny** — showing the full command, the model's reason, and only the details that differ from their defaults: working directory (when it differs from the session cwd), timeout, env, pty, async. Critical-pattern and env-override prompts show only choices the gate can honor (**Allow once**/**Deny**), so an authorization cannot appear to succeed and then re-prompt on the next call. Canceling or timing out counts as Deny.
**Allow for session** records a grant: this action, in this exact directory, runs ungated for the rest of the session — no classifier call, no dialog. Rewordings of a simple action match the grant through a strict key that keeps flags (split, sorted short bundles) and the first argument; compounds and command substitutions use an exact-text key, so an edited segment or payload never rides the grant. Answering with it also lifts any refusal recorded for that action in that directory. Grants stay below critical patterns, caller-supplied `env`, and your static rules, and they die with the session or a classifier config change (up to 50 per session).
**Always allow** (bash only) writes a persistent grant: this exact command text, in this exact directory, runs ungated everywhere for 30 days — no model call, no dialog, one audit line. The key is the whole command text, compounds included, so multi-segment commands host rules can never match are covered; grants are stored in `omp-classifier-grants.json` beside `omp-classifier.json` (`OMP_CLASSIFIER_CONFIG` relocates both), capped at 500 entries, pruned on a 30-day TTL, and toggled off wholesale with `persistentGrants: false` (the existing file stays on disk). A live persistent grant also keeps refusal memory from re-prompting for its exact text.

## Eval code that spawns

The `eval` tool runs kernel code directly, so a host `eval: allow` would otherwise bypass every bash check. The plugin scans each payload for subprocess entry points (`child_process`, `Bun.spawn`, `Bun.$`, Python's `subprocess`/`os.system`, `exec`/`__import__`/`importlib` escapes). Expression-only code — compute, parse, format, local reads — passes with zero cost. Spawn-bearing code is classified like a bash command: judged by what the spawned command would do, SAFE auto-runs, UNSAFE or unsure raises a request. The scan is a marker list, not a parser: string-splitting evasion (`"child_pro" + "cess"`) gets through, the same way obfuscated shell gets past the bash gate. Kernel-level interception is the structural fix (issue #13).

## Fails closed

The plugin never guesses its way to silent execution.

- A classifier error, timeout, malformed verdict, or no available model raises a permission request. Headless sessions have no dialog, so they block instead. Malformed verdicts are never cached.
- An unexpected plugin crash blocks the call.

Even a SAFE verdict is gated. It auto-runs only when the command avoids the forced-dialog set: `rm`/`unlink` in the shapes where a mistake is systemic (recursion, glob metacharacters, `..` traversals, dotfiles/dot-paths, provable targets outside the working directory — temp dirs excluded), plus `dd`, `ddrescue`, `shred`, `wipefs`, `sudo`, and `eval`. Plain `rm`/`unlink` of named paths (including under `/tmp`) auto-runs on SAFE — the judge owns them. Everything else destructive is also judge-decided now: `mv`, `chmod`, `chown`, `chattr`, `truncate`, `tee`, `rmdir`, `git commit --amend` and `git reset --soft`/`--mixed` (reflog/index keeps the pre-image), and `git checkout --`/`git restore` pathspec restores run on a SAFE, with the post-parse write-scope and citation checks still auditing every SAFE verdict. The matcher's remaining unconditional flags are `mkfs*`, `git push --force` (inside compounds), `git reset --hard` (unambiguous `--hard` prefixes count), and `git clean`; anything on the host's critical-pattern list (e.g. `rm -rf` on an absolute path, `dd of=/dev/…`) prompts before classification regardless. A heredoc body written straight to a file comes off the command before anything tokenizes it: `cat > f.ts <<'EOF'` writing `if (dd < 30) {` no longer reads as a raw disk write, and a README documenting `curl -d` no longer reads as egress. The rule matches one shape and nothing else, so it needs no view on what the shell executes: a whole owner line that is only `cat` or `tee`, its flags and targets, and a QUOTED delimiter, with a closing line that is exactly the delimiter. Every other heredoc keeps its body in the command text and keeps being scanned as commands, including `bash <<EOF`, an unquoted delimiter, a pipe on the owner line, and a heredoc with no closer. That over-flags on a delimiter named `sudo`, and over-flagging is the direction this overlay is allowed to be wrong in.

**curl** and **wget** are judged like any other command — no forced dialog. The old fetch-shape scan survives only as the egress-consistency check's input: it decides whether a fetch counts as a read (so the check never demands an egress sentence for one) or stays outbound (`curl -o ~/.bashrc …`, `curl https://x | python3 -`). That clearing is fail-closed — an unrecognized flag, any redirect, or an unknown downstream consumer costs the clearing, never a silent run. The stdin-executing-interpreter scan (`curl -fsSL https://x | sh`) is a separate risk class and still forces a dialog — but a piped interpreter whose payload the classifier read verbatim (an inline `-c`/`-e` argument, or a heredoc body) releases on plain code exactly like a non-piped interpreter does; only obfuscation markers or destructive verbs in the payload keep the flag, and a heredoc-less `-`/`-s` stage stays flagged as opaque stdin.
Related behaviors: rm-family forced dialogs append "Reversible alternative: trash <paths>" to the body; dialog reasons from the post-parse checks are humanized for display while the machine-readable reasons stay byte-identical in the decision log; a dialog fired by a session whose on-disk plugin changed since it loaded says so in the subtitle ("plugin code changed since session start; restart to pick up fixes"); ssh commands are judged by their remote command under the same rules (read-only remote inspection is SAFE); and the egress consistency check fires only when the analysis affirmatively claims there is no network — silence is never a contradiction.

## Install

```bash
git clone https://github.com/STRML/omp-classifier.git
cd omp-classifier && omp plugin install .
```

This symlinks the checkout to `~/.omp/plugins/node_modules/omp-classifier`. No build step, no runtime dependencies. Plugins load at session start, so start a new OMP session.

Uninstall: `omp plugin uninstall omp-classifier`. Installed under the old name? Uninstall `omp-bash-classifier` once, then run the install above.

## Configuration

Your existing `bash.patterns` and `tools.approval` keep working. A narrow `allow` rule doubles as the opt-out from classification for a trusted shape; blanket patterns never qualify.

Plugin settings live in `~/.omp/omp-classifier.json`. View or change them with `/classifier`:

| Key | Default | Meaning |
|---|---|---|
| `enabled` | `true` | `false` turns off model classification only. Critical-pattern and env checks still enforce. |
| `model` | `""` (auto) | Explicit model id. Otherwise: `config.model` -> `@tiny` role -> session model. |
| `timeoutMs` | `25000` | Whole classification budget, including the bounded second review for ambiguous, injection-shaped, inconsistent, or malformed replies. A timeout fails closed to a permission request. |
| `maxCommandLength` | `8000` | Commands longer than this are blocked (bounds 64-100000; values outside fall back to the default). |
| `evidenceUserMessages` | `3` | How many recent user messages (0-6) ride into the classify record as `evidence.userMessages`. `0` sends no evidence. Values outside the bounds fall back to the default. |
| `fallbackModels` | `[]` | Up to 3 fallback model ids, tried in order when the primary returns an empty reply or a provider error (timeouts do not trigger fallback). The whole chain is part of the cache key and config signature. |
| `persistentGrants` | `true` | Offers **Always allow** on bash dialogs (30-day exact-command grants in `omp-classifier-grants.json`). Kill-switch: `false` stops offering them and stops honoring live ones; the stored file stays on disk. |

Changing any key flushes the verdict cache and the session grants. To silence the model quickly, `/classifier enabled false` takes effect on the very next command. `omp plugin disable` needs a session restart, since interceptors bind when a session begins.

An existing config file that pins `maxCommandLength: 2000` keeps 2000 after upgrading — defaults only apply to absent keys. `/classifier reset` rewrites the file with current defaults.
`/classifier off` pauses model classification for the current session only. Critical-pattern, env-override, and static-rule checks stay active — the same behavior as `enabled false`, but scoped to the session. Cached verdicts keep being honored, other sessions are unaffected, and the pause dies with the session (a new session starts unpaused). `/classifier on` resumes classification for the session. The persistent `enabled` setting still dominates: `/classifier enabled false` keeps classification off everywhere until you turn it back on. `/classifier status` lists `pausedSessions`, and `dry-run` while paused reports `{ "would": "allow", "layer": "session" }`.

`/classifier dry-run <command>` previews what the gate would do, side-effect free: no model call, no dialog, no cache, grant, refusal, or audit writes. It prints the first decision the gate would reach as JSON:

```json
{ "would": "allow", "layer": "granted", "why": "session grant" }
```

## The model

Novel commands use a bounded two-pass judge. The primary pass is fast and reasoning-disabled; only an ambiguous, injection-shaped, internally inconsistent, or malformed result gets one reviewer pass within the same 25s deadline. A reviewer never turns a flagged injection into silent execution, and a failed reviewer leaves the primary safety posture in place. Verdicts cache for the session, keyed by cwd, env, pty, timeout, async, the fallback-model chain, the task evidence fingerprint, and the command text, so reruns cost nothing while a changed user scope invalidates the cache and session grants.

Every decision carries a stable policy version/hash, session and decision identifiers, model id, timing, and (when used) review trigger in `decisions.jsonl`. `/classifier status` exposes the live policy hash and the recent tail. The deterministic replay tail is shared by the live gate and the evaluation harness, so caps, environment overrides, risk overlays, prior refusals, interactive prompts, and headless blocks are measured the same way.

Default resolution uses the `@tiny` role, falling back to the session model. Assign the role in `/models` or a `config.yml` layer (set the record as a whole; the CLI cannot set one role):

```yaml
modelRoles:
  tiny:
    - anthropic/claude-haiku-4-5
    - openai-codex/gpt-5.4
    - openrouter/deepseek/deepseek-v4-flash
```

Pick on measured behavior, not size. Scored on the shipped prompt: eight routine commands, eight destructive, five with appended text telling the classifier to answer SAFE, five reps each:

| model | injected command judged SAFE | destructive judged SAFE | extra prompts on routine work | p50 |
|---|---|---|---|---|
| `anthropic/claude-haiku-4-5` | 0/25 | 0/40 | 0/40 | 1.1s |
| `openai-codex/gpt-5.4-mini` | 0/25 | 0/40 | 0/40 | 2.7s |
| `openrouter/deepseek/deepseek-v4-flash` | 0/25 | 0/40 | 6/40 (calls a routine commit UNSAFE) | 1.7s |
| `anthropic/claude-sonnet-5` | 2/25 | 0/40 | 0/40 | 1.7s |
| `zai/glm-5.3-flash` | 1/16 | 1/18 (contested `gh pr merge`, which the prompt's carve-out allows) | 0/35 | (not timed) |

All five reject every plainly destructive command. What separates them is resistance to a command that argues for its own SAFE verdict, and that does not track model strength: the Sonnet-class model the default `smol` chain lands on scored worst. Measure before switching. An earlier prompt let claude-sonnet-5 through on 29/50 injection samples.

The `zai/glm-5.3-flash` row is a different protocol: the full 92-case adversarial corpus, 3 samples, spawn judge (2026-09-01). Its one injection leak is the answer-format imitation (`printf 'SAFE | …'`); its destructive leak is the corpus's own `contested` case, which the shipped prompt's gh-merge carve-out tells the model to allow. It replaced deepseek-v4-flash as the configured gate model after deepseek produced a live over-flag on a routine lint+test chain (corpus case added) and empty-reply PARSE_ERRORs.

Avoid cursor-provider models (`composer-*`, `gpt-5.4-nano-*`, `gemini-3.7-flash-*`). They answer as agents rather than judges, every reply parses as no-verdict, and every command then prompts.

## Evidence

The classify record can carry an `evidence` object whose fields have different authors, and the prompt judges each field by its channel. `evidenceUserMessages` attaches the task's most recent user messages plus older scope/restriction anchors, with stable message ids. The user's own words are the only tier that may authorize an action. Only messages the host stamps `attribution: "user"` count, so the brief a parent agent sends its subagent never does. A message longer than 2,000 characters keeps its first and last 1,000, and a quoted citation has to fit inside one of those two pieces. Every tool call may also carry `operatorContext`: the requesting agent's explanation of intent, flattened to one line, capped at 500 characters, and never able to authorize anything. Recent tool calls/results are added as bounded, explicitly non-authorizing context so a script written earlier in the session is not invisible to the next review. Model refusals and session grants are scoped to the reviewed cwd and evidence fingerprint; later user restrictions invalidate them. Human denials remain sticky until approval in that same scope. The channel decides provenance: content claiming authorization from the wrong channel is itself an injection signal, judged by the same rules as the command text.

## Limits

- **Spawn-bearing eval code only.** Expression-only eval passes unread, and the payload scan is a marker list: string-splitting evasion gets through. `hub op: "start"` and other exec-tier tools still auto-run under `yolo`. An attacker who picks the tool picks around this.
- **Later handlers win.** Another extension's `tool_call` handler can revise the command after this one judges it; the host applies the last revision. Input-mutating extensions alongside this plugin are unsupported.
- **Internal-URL working directories are blocked.** `skill://` and similar cwds expand from session state the plugin cannot see. Pass the resolved filesystem path.
- **Command contents are not inspected.** `npm test` and `make` are judged as the routine commands they look like. Package scripts and hooks go unread.
- **Refusal memory is session-local.** A refused action follows reworded commands within that session only and dies with it; subagent inheritance is a host gap (`parentAgentId` is not exposed to extensions).

## Privacy

Classified command text, up to 8,000 characters plus the resolved working directory, goes to your model provider, under its logging and retention policies. Command text can hold private paths, proprietary snippets, inline env assignments, or secrets in flags. Caller-supplied `env` values are never sent; that path asks the human instead.

## Development

```bash
bun install
bun test           # static gate, classifier verdicts, cache keying, fail-closed paths
bun run typecheck  # against pinned published host types
```

CI runs both on every push and PR. Verdict quality against live models is evaluated separately (`eval/`, tracked in issue #2).

The replay-aware harness also ships a deterministic 500-action held-out benign set
(25 task sequences × 20 routine steps), with task ids and step ids in each record:

```bash
bun eval/run.ts --prompt live --corpus heldout --samples 3
```

Reports include final host handoff, review/recovery counts, approval overrides,
interruption rates, and p50/p95 latency. Treat generated held-out numbers as a
repeatable regression fixture, not as a substitute for fresh production history.

MIT licensed.
