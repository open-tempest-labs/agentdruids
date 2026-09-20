#!/usr/bin/env bash
# Hook: block `git push` when the branch changes a shared representation and no
# seam audit covers the commits being pushed.
#
# Why this is a hook and not a checklist item: it was already project guidance,
# and it was skipped in three consecutive pull requests. Each time the defect was
# the same shape — a representation changed, and a consumer of it was not traced.
# Review caught them; the gate is cheaper than review.
#
# What it can and cannot do: it verifies that an audit was recorded against the
# exact commit being pushed. It cannot verify the audit was any good, and the
# marker can be written without doing the work. It stops forgetting, not bad
# faith.
#
# Wired up via .claude/settings.example.json (PreToolUse on Bash).

set -euo pipefail

if ! command -v jq >/dev/null 2>&1; then
  echo "require-seam-audit: jq not installed; hook disabled. brew install jq to enable." >&2
  exit 0
fi

input=$(cat)
command=$(echo "$input" | jq -r '.tool_input.command // ""')

# Only police git push.
case "$command" in
  *"git push"*) ;;
  *) exit 0 ;;
esac

repo_root=$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)
cd "$repo_root"

# Never gate the default branch: merges land there already reviewed.
branch=$(git rev-parse --abbrev-ref HEAD 2>/dev/null || echo "")
if [[ "$branch" == "main" || -z "$branch" ]]; then
  exit 0
fi

# Compare against the upstream default branch, falling back to origin.
base="upstream/main"
git rev-parse --verify --quiet "$base" >/dev/null 2>&1 || base="origin/main"
git rev-parse --verify --quiet "$base" >/dev/null 2>&1 || exit 0

changed=$(git diff --name-only "$base"...HEAD 2>/dev/null || echo "")
[[ -z "$changed" ]] && exit 0

# ---------------------------------------------------------------------------
# Narrow trigger: only when a shared representation plausibly changed.
#
# Deliberately not "any file under src/". A gate that fires on every pull
# request becomes noise and gets switched off, which is worse than no gate. The
# three cases below are where the skipped audits would have paid:
#
#   1. a migration            — the stored shape changed
#   2. src/models/            — the typed shape changed
#   3. an added/removed export — something became, or stopped being, shared
#
# A bug fix inside an existing function body introduces no new representation
# and does not trigger.
# ---------------------------------------------------------------------------
reasons=()

if echo "$changed" | grep -q '^src/database/migrations/'; then
  reasons+=("a migration changes the stored representation")
fi

if echo "$changed" | grep -q '^src/models/'; then
  reasons+=("src/models/ changes a shared type")
fi

# Added or removed exports, ignoring pure moves within a line.
export_delta=$(git diff -U0 "$base"...HEAD -- 'src/**/*.ts' 2>/dev/null \
  | grep -E '^[+-][[:space:]]*export ' \
  | grep -vE '^[+-][[:space:]]*export (type|interface) .*\{$' \
  | wc -l | tr -d ' ')
if [[ "${export_delta:-0}" -gt 0 ]]; then
  reasons+=("$export_delta exported symbol line(s) added or removed")
fi

# Nothing representational changed — let the push through.
[[ ${#reasons[@]} -eq 0 ]] && exit 0

# ---------------------------------------------------------------------------
# A marker must name the exact commit being pushed. Amending or adding commits
# invalidates it, so the audit always covers what actually goes out.
# ---------------------------------------------------------------------------
marker="$repo_root/.claude/.seam-audit"
head_sha=$(git rev-parse HEAD)

if [[ -f "$marker" ]] && grep -qx "$head_sha" "$marker"; then
  exit 0
fi

recorded="(none)"
[[ -f "$marker" ]] && recorded=$(head -1 "$marker")

cat >&2 <<EOF
Blocked: this branch changes a shared representation and no seam audit covers HEAD.

Triggered because:
$(printf '  - %s\n' "${reasons[@]}")

  HEAD:     $head_sha
  Audited:  $recorded

Run the seam auditor over this diff — it enumerates every producer and consumer
of the changed representation and reports the ones the diff fails to handle —
then record it:

  /seam-audit

Address anything it finds, or state in the PR description why a finding does not
apply. Re-run after amending: the marker is tied to the commit.

If this genuinely needs no audit (a revert, a docs-only change misdetected by the
export heuristic), record it with a reason:

  echo "\$(git rev-parse HEAD)" > .claude/.seam-audit
  echo "# skipped: <reason>" >> .claude/.seam-audit

The marker is gitignored; it records local diligence, not repository state.
EOF
exit 2
