# Repository context

## Source locations

- This plugin's source is `./index.ts`; its judgment module is `./jev.ts`.
- The installed OMP host package is available locally at
  `./node_modules/@oh-my-pi/pi-coding-agent/`.
- Read host TypeScript source under
  `./node_modules/@oh-my-pi/pi-coding-agent/src/`.
- Read the built runtime and declarations under
  `./node_modules/@oh-my-pi/pi-coding-agent/dist/`.
- `node_modules/@oh-my-pi` is deliberately symlinked to bun's global installation; resolve
  it with `realpath` when an absolute path is required. Read the installed package's
  `package.json` for the current version instead of assuming one.
- The active CLI is `~/.local/bin/omp` (the fork build; `~/.bun/bin/omp` no longer exists).
- OMP's maintained runtime documentation is available through `omp://`; read the relevant
  document directly instead of searching the filesystem for generated docs.

The host source is not part of this repository's git tree, but it **is on disk**. Do not
clone OMP, run `npm pack`, or hunt through unrelated directories to inspect it. Verification
subagents should use the local `node_modules/@oh-my-pi/pi-coding-agent/{src,dist}` paths.

## How the gate judges

- Judgment comes from Jev, TypeSafe's System One model, over plain `fetch` (no SDK
  dependency): `POST https://api.typesafe.ai/v1/systemone`, body
  `{ state, model, questions }`, `model` pinned to `jev-latest` (which resolves server-side
  to a dated build, `jev-1.13.0` at the time of writing). `jev.ts` owns that exchange
  end to end; `index.ts` owns everything around it — static rules, grants, refusals,
  dialogs, audit logging.
- There is no prompt and no text parsing any more. Jev never writes prose: it answers typed
  questions (`choice`, `noul`, `score`), and the verdict is derived in code from the
  returned probabilities (`deriveJevDecision` under policy version `jev-v1`). Do not go
  looking for `CLASSIFIER_PROMPT`, a `VERDICT:` regex, or an analysis string to check
  things against; a decision's `reason` is assembled from numbers and hazard ids.
- The battery is the contract: `jevQuestionsHash()` is the sha256 (first 16 hex chars) of
  the policy version, the serialized battery, and the default policy, and it participates in
  the cache key. Editing a question, an option description, or a default threshold therefore
  invalidates every cached verdict — that is the intent, not a bug to paper over with a
  version bump.
- The API key resolves from `TYPESAFE_API_KEY`, else from the macOS keychain entry `jev`
  (`security find-generic-password -s jev -w`). Never commit it, never echo it in tests,
  reports, or decision records. A missing key, a non-2xx response, an unparseable body, a
  malformed answer, or a timeout must surface as `JevUnavailableError` and fail closed to a
  permission request — never as a verdict.
- Measured answer probabilities and confidence move with the question set and with the
  shape of the state, so the thresholds in `DEFAULT_JEV_POLICY` are policy, not constants
  copied from anywhere. Do not tune a threshold to make one command classify the way you
  expect; change policy deliberately and measure the whole battery.
- The `skill://typesafe-ai` skill is installed at `.agents/skills/typesafe-ai` (with
  `.claude/skills/typesafe-ai` symlinked to it) and pinned in `skills-lock.json` to
  `typesafe-ai/skills`. The directory is untracked — a fresh clone needs the skill
  reinstalled. Read it before changing request or question shapes.
