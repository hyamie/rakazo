#!/usr/bin/env bash
# Open a PR that merges elie222/rakazo main into this fork's deploy/hds, or file
# one issue saying why it cannot be done automatically.
#
# Run from cron on RipOrDie against the session checkout. It never touches the
# working tree: merge-tree, commit-tree and push are plumbing that read refs and
# write objects, so it is safe to run while someone is working in the repo.
#
# A human merges. The updater deploys. This only ever opens a PR.
#
# Exit 0 always: a watcher that fails the cron is noise. Real problems arrive as
# a PR, an issue, or an ntfy push.
set -uo pipefail

REPO="${RAKAZO_REPO:-/home/hyamie/projects/active/hyams-digital-solutions/rakazo}"
FORK="${RAKAZO_FORK:-hyamie/rakazo}"
BASE="${RAKAZO_BASE_BRANCH:-deploy/hds}"
UPSTREAM_REMOTE="${RAKAZO_UPSTREAM_REMOTE:-upstream}"
UPSTREAM_BRANCH="${RAKAZO_UPSTREAM_BRANCH:-main}"
NTFY_TOPIC="${NTFY_TOPIC:-hyamie-infra}"
NTFY_URL="${NTFY_URL:-https://ntfy.sh/${NTFY_TOPIC}}"
ISSUE_TITLE="Upstream sync blocked"

log() { printf '%s %s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$*"; }

notify() {
  # Title first, body on stdin, so a multi-line body never becomes argv.
  curl -s -m 20 -H "Title: Rakazo sync: $1" -H "Tags: arrows_counterclockwise" \
    --data-binary @- "$NTFY_URL" >/dev/null 2>&1
}

git -C "$REPO" rev-parse --git-dir >/dev/null 2>&1 || { log "not a git repo: $REPO"; exit 0; }

# `gh` in this clone resolves to UPSTREAM, because the fork's remote points there.
# Every gh call below names --repo explicitly. Never rely on the default.
command -v gh >/dev/null || { log "gh is not installed"; exit 0; }
gh auth status >/dev/null 2>&1 || { log "gh is not authenticated"; exit 0; }

git -C "$REPO" fetch --quiet "$UPSTREAM_REMOTE" "$UPSTREAM_BRANCH" || { log "fetch upstream failed"; exit 0; }
git -C "$REPO" fetch --quiet origin "$BASE" || { log "fetch origin failed"; exit 0; }

UP="$(git -C "$REPO" rev-parse "${UPSTREAM_REMOTE}/${UPSTREAM_BRANCH}")"
OURS="$(git -C "$REPO" rev-parse "origin/${BASE}")"
UP_SHORT="${UP:0:12}"

if git -C "$REPO" merge-base --is-ancestor "$UP" "$OURS"; then
  log "already up to date with ${UPSTREAM_REMOTE}/${UPSTREAM_BRANCH} at ${UP_SHORT}"
  exit 0
fi

BEHIND="$(git -C "$REPO" rev-list --count "${OURS}..${UP}")"
SYNC_BRANCH="sync/upstream-${UP_SHORT}"

# Idempotency keys off the upstream commit, not the date: a second run on the
# same day must not open a second PR, and a run a week later on an unchanged
# upstream must not either.
if git -C "$REPO" ls-remote --exit-code --heads origin "$SYNC_BRANCH" >/dev/null 2>&1; then
  log "sync branch ${SYNC_BRANCH} already exists; nothing to do"
  exit 0
fi

# Files this fork has changed that upstream also changed in the incoming range.
# These are where a conflict comes from, and where a clean auto-merge still
# deserves a human read. ops/ is ours alone and never collides.
MERGE_BASE="$(git -C "$REPO" merge-base "$UP" "$OURS")"
THEIRS_TOUCHED="$(git -C "$REPO" diff --name-only "${MERGE_BASE}" "$UP" | sort -u)"
OURS_TOUCHED="$(git -C "$REPO" diff --name-only "${MERGE_BASE}" "$OURS" | grep -v '^ops/' | sort -u)"
COLLISIONS="$(comm -12 <(printf '%s\n' "$THEIRS_TOUCHED") <(printf '%s\n' "$OURS_TOUCHED"))"
COLLISION_COUNT="$(printf '%s' "$COLLISIONS" | grep -c . || true)"

NEW_TAGS="$(git -C "$REPO" ls-remote --tags "$UPSTREAM_REMOTE" 'v*' 2>/dev/null \
  | awk '{print $2}' | sed 's#refs/tags/##' | grep -v '\^{}$' | tail -5 | tr '\n' ' ')"

TREE="$(git -C "$REPO" merge-tree --write-tree "$UP" "$OURS" 2>/dev/null)"
CONFLICTED=$?

BODY_FILE="$(mktemp)"
trap 'rm -f "$BODY_FILE"' EXIT

{
  echo "Upstream \`${UPSTREAM_REMOTE}/${UPSTREAM_BRANCH}\` is **${BEHIND} commits** ahead of \`${BASE}\`."
  echo
  echo "- upstream: \`${UP}\`"
  echo "- ours: \`${OURS}\`"
  echo "- merge base: \`${MERGE_BASE}\`"
  [ -n "${NEW_TAGS// /}" ] && echo "- latest upstream tags: ${NEW_TAGS}"
  echo
  if [ "$COLLISION_COUNT" -gt 0 ]; then
    echo "### Carried files upstream also touched (${COLLISION_COUNT})"
    echo
    echo '```'
    printf '%s\n' "$COLLISIONS"
    echo '```'
    echo
    echo "Read these hunks by hand. Everything else is upstream's own work."
  else
    echo "Upstream touched none of the files this fork carries patches in."
  fi
} > "$BODY_FILE"

if [ "$CONFLICTED" -ne 0 ] || [ -z "$TREE" ]; then
  CONFLICTS="$(git -C "$REPO" merge-tree --write-tree --name-only "$UP" "$OURS" 2>&1 | tail -n +2)"
  {
    echo
    echo "### Conflicts"
    echo
    echo "\`git merge-tree\` could not produce a tree. Resolve by hand:"
    echo
    echo '```'
    printf '%s\n' "$CONFLICTS"
    echo '```'
    echo
    echo "\`\`\`"
    echo "git worktree add ~/projects/.worktrees/rakazo/sync-${UP_SHORT} -b ${SYNC_BRANCH} ${BASE}"
    echo "cd ~/projects/.worktrees/rakazo/sync-${UP_SHORT} && git merge ${UP}"
    echo "\`\`\`"
  } >> "$BODY_FILE"

  # An issue is the durable, deduplicated record. If the repository has issues
  # disabled, or the API refuses for any other reason, say so and fall back to
  # ntfy carrying the conflict list itself. Never log success for a call that
  # failed: a silent conflict is the one outcome this whole loop exists to catch.
  URL=""
  # Match on the listed titles, not `--search`. The search API is a separate,
  # eventually-consistent index: an issue opened seconds ago is not findable
  # there yet, so a search-based check opens a duplicate on every run until the
  # index catches up. Listing is read-your-writes.
  #
  # `.[0].number` on an empty result is `null`, and interpolating that yields the
  # literal "null", which reads as a real issue number. `// empty` yields nothing.
  EXISTING_NUM="$(gh issue list --repo "$FORK" --state open --limit 100 \
    --json number,title --jq "[.[] | select(.title == \"${ISSUE_TITLE}\")] | .[0].number // empty" 2>/dev/null)"
  if [ -n "$EXISTING_NUM" ]; then
    EXISTING_BODY="$(gh issue view "$EXISTING_NUM" --repo "$FORK" --json body --jq '.body // empty' 2>/dev/null)"
    if printf '%s' "$EXISTING_BODY" | grep -q "$UP"; then
      log "conflict issue #${EXISTING_NUM} already reports ${UP_SHORT}; not re-notifying"
      exit 0
    fi
    if gh issue edit "$EXISTING_NUM" --repo "$FORK" --body-file "$BODY_FILE" >/dev/null 2>&1; then
      URL="https://github.com/${FORK}/issues/${EXISTING_NUM}"
      log "updated conflict issue #${EXISTING_NUM} for ${UP_SHORT}"
    else
      log "WARN could not update issue #${EXISTING_NUM}"
    fi
  else
    if URL="$(gh issue create --repo "$FORK" --title "$ISSUE_TITLE" --body-file "$BODY_FILE" 2>&1 | tail -1)" \
        && [ "${URL#https://}" != "$URL" ]; then
      log "opened conflict issue: ${URL}"
    else
      log "WARN could not open an issue on ${FORK} (${URL:-no output}); falling back to ntfy only"
      URL=""
    fi
  fi

  if [ -n "$URL" ]; then
    printf 'Upstream is %s commits ahead and the merge conflicts.\n\n%s\n' "$BEHIND" "$URL" \
      | notify "conflict at ${UP_SHORT}"
  else
    # No issue tracker to point at, so the notification has to carry the content.
    {
      printf 'Upstream is %s commits ahead and the merge conflicts.\n' "$BEHIND"
      printf 'No issue could be filed on %s, so this push is the only record.\n\n' "$FORK"
      printf 'Conflicted paths:\n%s\n' "$CONFLICTS"
    } | notify "conflict at ${UP_SHORT} (no issue tracker)"
  fi
  exit 0
fi

# Clean merge. Build the commit with plumbing so the working tree is untouched.
# First parent is ours, so `git log --first-parent deploy/hds` stays readable.
MSG="Merge upstream ${UPSTREAM_BRANCH} at ${UP_SHORT}

${BEHIND} commits from ${UPSTREAM_REMOTE}/${UPSTREAM_BRANCH}.
Carried files upstream also touched: ${COLLISION_COUNT}.

upstream-sha: ${UP}"

COMMIT="$(printf '%s' "$MSG" | git -C "$REPO" commit-tree "$TREE" -p "$OURS" -p "$UP" 2>/dev/null)"
[ -n "$COMMIT" ] || { log "commit-tree failed (is a committer identity set?)"; exit 0; }

git -C "$REPO" push --quiet origin "${COMMIT}:refs/heads/${SYNC_BRANCH}" 2>/dev/null \
  || { log "push of ${SYNC_BRANCH} failed"; exit 0; }

URL="$(gh pr create --repo "$FORK" --base "$BASE" --head "$SYNC_BRANCH" \
  --title "Merge upstream ${UPSTREAM_BRANCH} at ${UP_SHORT} (${BEHIND} commits)" \
  --body-file "$BODY_FILE" 2>/dev/null | tail -1)"

if [ -z "$URL" ]; then
  log "branch ${SYNC_BRANCH} pushed but gh pr create failed"
  exit 0
fi

log "opened sync PR: ${URL}"
printf '%s commits, %s carried files touched.\n\n%s\n' "$BEHIND" "$COLLISION_COUNT" "$URL" \
  | notify "PR open for ${UP_SHORT}"
