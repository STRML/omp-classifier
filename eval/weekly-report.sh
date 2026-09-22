#!/bin/bash
# The weekly jev-v3 shadow report (#116), run by a launchd agent
# (eval/launchd/ai.strml.omp-classifier-shadow-report.plist).
#
# Writes the full report, rows included, to a local file, and posts only the
# counts as a comment on the tracking issue: the rows carry logged command
# text, which can hold a secret (#71), and the repository is public. Stops
# reporting once the issue is closed, which is how the flip ends it.
set -uo pipefail

repo="$(cd "$(dirname "$0")/.." && pwd)"
issue="${OMP_SHADOW_ISSUE:-116}"
slug="STRML/omp-classifier"
bun="${BUN:-$HOME/.bun/bin/bun}"
gh="${GH:-/opt/homebrew/bin/gh}"
dir="$HOME/.omp/omp-classifier"
full="$dir/shadow-report-$(date +%F).txt"

notify() {
	/usr/bin/osascript -e "display notification \"$1\" with title \"omp-classifier shadow report\"" >/dev/null 2>&1 || true
}

state="$("$gh" issue view "$issue" -R "$slug" --json state --jq .state 2>&1)" || {
	notify "Could not read issue #$issue: $state"
	exit 1
}
[ "$state" = "OPEN" ] || exit 0

mkdir -p "$dir"
"$bun" "$repo/eval/live-report.ts" --hours 168 >"$full" 2>&1
counts="$("$bun" "$repo/eval/live-report.ts" --hours 168 --counts-only 2>&1)"
status=$?

verdict="Report complete."
[ "$status" -eq 0 ] || verdict="Report INCOMPLETE or failed (exit $status): fix the log before reading it."

body="Weekly jev-v3 shadow report, $(date +%F), last 7 days. $verdict

\`\`\`
$counts
\`\`\`

Counts only: the command rows stay local in \`$full\`, because logged command text can hold a secret (#71). Flip criterion: REGRESSIONS must read \`none\`."

# OMP_SHADOW_DRY_RUN=1 prints the comment instead of posting it.
if [ -n "${OMP_SHADOW_DRY_RUN:-}" ]; then
	printf '%s\n' "$body"
	exit 0
fi

if printf '%s' "$body" | "$gh" issue comment "$issue" -R "$slug" --body-file - >/dev/null 2>&1; then
	notify "Posted to #$issue. $verdict"
else
	notify "Could not post to #$issue. Full report: $full"
	exit 1
fi
