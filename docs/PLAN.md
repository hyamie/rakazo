---
key: rakazo
title: "rakazo"
team: HDS
initiative: HDS Products
repo: hyamie/rakazo
lead: mike
appetite: "2 weeks"
plan_version: 1
---

## Problem
HDS runs Rakazo as a self hosted product on its own fork (`hyamie/rakazo`), with all
deployment specific configuration and behavioral patches carried on branch `deploy/hds`
(the `ops/` tree and the ops facing docs referenced below live only on that branch, not on
`main`, where this plan is filed). A cron job, `ops/sync-upstream.sh`, keeps `deploy/hds`
caught up with `elie222/rakazo` by opening a clean merge PR or filing a tracking issue on a
real conflict. It is doing exactly that right now: GitHub issue #14, "Upstream sync
blocked," has stood open since 2026-09-09 and was refreshed again today, reporting 29
commits behind `upstream/main` with five files in real conflict. Two earlier catch up
PRs, #12 and #13, were opened before that conflict appeared and no longer cover the full
range.

Separately, the fork carries three smaller pieces of maintenance debt, each already
described in the fork's own tracked history. The host that runs the deployment was
migrated to new hardware on 2026-09-10 (`ops/README.md`), and the pre-migration guest is
still kept powered off as a rollback that has not yet been retired. Whether the production
deployment has picked up the most recently merged fix (fork PR #20, the tool result
truncation fix, commit `78bbac15`) is readable only from its health endpoint, which reports
the deployed revision; I005 settles it. And the Expo mobile pins have needed a manual,
reactive fix twice in this fork's own history (PRs #18 and #19), because
`expo install --check` compares the pins against Expo's live expectations for the installed
SDK, so a newly published Expo patch turns the existing `pnpm check` job red on every open
`deploy/hds` PR until someone bumps the pins by hand.

## Outcome
`deploy/hds` is caught up with `upstream/main`, the production deployment is running that
caught up build, and each piece of carried maintenance debt (the retired VM, the
un-upstreamed fix, the Expo pin drift) is either closed out or backed by a check that
catches it automatically next time.
- SC-001 `git merge-base --is-ancestor` reports `upstream/main` as an ancestor of
  `origin/deploy/hds`.
- SC-002 GitHub issue #14 and pull requests #12 and #13 on `hyamie/rakazo` are closed.
- SC-003 The production deployment's health endpoint reports a revision at or after the
  merged sync commit.
- SC-004 The pre-migration VM no longer appears in the Proxmox cluster's resource list.
- SC-005 A newly published Expo patch produces a pin-bump PR on `deploy/hds` from a cron job
  on the RipOrDie host, before an unrelated PR turns red and someone fixes it by hand.

## Definition of Done
PR merged with CI green on `.github/workflows/ci.yml` (`pnpm install --frozen-lockfile`,
`pnpm db:generate`, `pnpm lint`, `pnpm check`, `pnpm test`, `pnpm test:integration`); for
any PR opened against `deploy/hds`, the `hds-deploy-check` workflow also green; for a
deployment change, the target's `/health` endpoint reports the deployed revision;
validation commands below executed and their output recorded on the issue or PR.

## Non-goals
- Upstream's own feature roadmap is upstream's to run; this fork tracks only its own
  patches, its own deployment, and staying current, per `ops/README.md` and
  `ops/sync-upstream.sh`.
- The multi-tenant "Rakazo Cloud" path described in `docs/self-host.md` ("What Rakazo
  Cloud still needs") is not something this plan builds toward.
- The dedicated network isolation VLAN for the deployment stays retired, per the tradeoff
  recorded in `ops/network.md`; the VM boundary is the accepted containment.
- Upstreaming the fork's remaining local patches (local provider API key, provider
  allowlist, MCP LAN allowlist, extra computer mounts) stays a later step in the fork's own
  update and migration plan, not this two week window; only the already merged truncation
  fix is upstreamed here.
- Client specific bot and routine configuration that runs on top of a Rakazo deployment
  (mailbox handling, ticketing integrations, and similar) is tenant usage of the product,
  not fork engineering, and stays out of this repo's lane.

## Milestones
### M1 Land the blocked upstream sync
exit: `git merge-base --is-ancestor upstream/main origin/deploy/hds` exits 0, and issue #14 plus PRs #12 and #13 are closed.

### M2 Close deployment and maintenance debt
exit: the production deployment's health endpoint reports the caught up revision, the pre-migration VM is gone from the cluster's resource list, and the Expo pin cron job has run against `deploy/hds` and either opened a bump PR or logged an up-to-date result.

## Issues
### I001 Resolve the upstream merge blocking issue #14 and open the sync PR
milestone: M1
priority: high
labels: [Improvement]
depends_on: []
description: >
  Issue #14 has tracked a real `git merge-tree` failure since 2026-09-09: `deploy/hds` is
  29 commits behind `upstream/main`, with conflicts in `apps/mobile/package.json`,
  `infra/sandboxes/supervisor/src/computer-spec.ts` and its test,
  `packages/adapters/src/model-connect.ts`, and `pnpm-lock.yaml`. The issue's own body
  carries the exact recipe: branch a worktree off `deploy/hds`, merge the named upstream
  commit, resolve the five files by hand, and regenerate the lockfile. PRs #12 and #13
  were opened before this conflict appeared and cover only part of the range; do not
  merge them as is.
acceptance:
  - "Given a worktree branched from deploy/hds, when upstream/main is merged and the five
    conflicting files are resolved, then pnpm install, pnpm lint, pnpm check and pnpm test
    all exit 0 and a PR is open against deploy/hds referencing issue #14."
validation:
  - "pnpm install --frozen-lockfile && pnpm db:generate && pnpm lint && pnpm check && pnpm
    test exit 0 on the merge commit, and the deploy/hds PR shows hds-deploy-check green."

### I002 Read the security sensitive adapter diffs by hand before approving the merge
milestone: M1
priority: high
labels: [Improvement]
depends_on: [I001]
description: >
  Issue #14 lists 29 files upstream also touched on this merge, five of them in true
  conflict. Among the 24 that merge cleanly are packages/adapters/src/remote-mcp.ts,
  mcp-transport.ts, web-ssrf.ts, network-address.ts and undici-fetch.ts. Those files
  back the fork's own
  LAN allowlist and TLS trust behavior described in ops/README.md (deploy/hds only). The
  issue's own text says to read these hunks by hand; confirm upstream's changes did not
  silently narrow or widen the address and allowlist guards the fork depends on before
  the merge PR from I001 is approved.
acceptance:
  - "Given the merged adapters files, when the fork's LAN allowlist and address guard
    tests are run, then they pass and each of the five named files carries a short
    reviewed note on the merge PR."
validation:
  - "pnpm --filter @rakazo/adapters test passes; the merge PR body lists each of the five
    files above with a one line reviewed note."

### I003 Close the superseded sync PRs and the tracking issue
milestone: M1
priority: medium
labels: [Improvement]
depends_on: [I001, I002]
description: >
  Once the merge from I001 lands on deploy/hds, PRs #12 and #13 no longer describe a
  useful merge (their upstream commits are already included) and issue #14 no longer
  reflects the current state. Close all three with a note pointing at the landed merge
  commit, then confirm the sync cron itself recognizes the fork as caught up rather than
  opening a redundant PR or issue on its next run.
acceptance:
  - "Given the I001 merge is on deploy/hds, when PRs #12 and #13 and issue #14 are closed,
    then the next run of ops/sync-upstream.sh reports the fork already up to date and
    opens neither a new PR nor a new issue."
validation:
  - "ops/sync-upstream.sh run once by hand logs 'already up to date' and exits 0 with no
    new sync branch pushed."

### I004 Upstream the tool result truncation fix to elie222/rakazo
milestone: M1
priority: medium
labels: [Improvement]
depends_on: [I001]
description: >
  Fork PR #20 (commit 78bbac15) fixed a real defect: every MCP tool result was clipped at
  a fixed character count with a bare ellipsis, which had already dropped material from a
  long tool result out of a live conversation's context. The fix is generic (the cap now
  derives from the active model's context window) and belongs upstream. Rebase it onto
  the caught up deploy/hds from I001 and open it against elie222/rakazo:main.
acceptance:
  - "Given deploy/hds is caught up with upstream/main, when the truncation fix is rebased
    and opened as a PR against elie222/rakazo:main, then upstream's own CI passes on it."
validation:
  - "gh pr view against elie222/rakazo shows the PR open with its CI checks green."

### I005 Redeploy the caught up build to the production deployment
milestone: M2
priority: high
labels: [Improvement]
depends_on: [I001]
description: >
  The production deployment has not yet picked up commit 78bbac15 (the truncation fix)
  or, once I001 lands, the upstream sync. ops/deploy.sh pins the compose invocation for
  this fork (two files, one project directory) and force recreates so a stale container
  cannot survive an .env or image change. Run it on the deployment host once the merge
  from I001 is on deploy/hds.
acceptance:
  - "Given the I001 merge is on deploy/hds, when ./ops/deploy.sh up runs on the deployment
    host, then the deployment's /health endpoint reports the revision of the new
    deploy/hds tip."
validation:
  - "curl --fail against the deployment's health endpoint returns a revision equal to git
    rev-parse --short origin/deploy/hds."

### I006 Decommission the pre-migration VM
milestone: M2
priority: medium
labels: [Improvement]
depends_on: [I005]
description: >
  ops/README.md records that the deployment moved hosts on 2026-09-10 by backup and
  restore rather than live migration, and that the pre-migration guest was deliberately
  left stopped, with its network link down, as a rollback while the new host proved
  itself. With I005 confirming the new host serves the caught up build correctly,
  destroy the old guest and update ops/README.md's account of the 2026-09-10 move so it
  no longer says the old guest stays stopped until it is destroyed.
acceptance:
  - "Given the redeploy in I005 is verified healthy, when the pre-migration VM is
    destroyed, then it no longer appears in the cluster's resource list and
    ops/README.md's account of the 2026-09-10 move no longer says the old guest stays
    stopped until it is destroyed."
validation:
  - "pvesh get /cluster/resources --type vm on a cluster node no longer lists the
    pre-migration guest's VMID."

### I007 Move Expo pin drift off the deploy/hds PR gate and onto a scheduled bump
milestone: M2
priority: low
labels: [Improvement]
depends_on: []
description: >
  The mobile app's own "check" script runs expo install --check ahead of a plain
  typecheck, and root pnpm check (turbo check) already runs it in ci.yml's Typecheck job
  on every PR into deploy/hds, which is how the mismatch was caught both times (PRs #18
  and #19). The unsolved part is that expo install --check reads Expo's live expectations
  for the installed SDK, so a newly published Expo patch turns every open deploy/hds PR
  red until the pins are bumped by hand, and the bump lands as a reactive fix inside
  someone else's PR window. Add a second cron job on the RipOrDie host beside
  ops/sync-upstream.sh (a GitHub schedule trigger would fire only from the default branch,
  main, which this fork never builds from) that runs the mobile check against deploy/hds
  and, when it reports drift, opens a deploy/hds PR bumping the named pins with the
  lockfile regenerated, so the fix arrives on its own cadence instead of blocking
  unrelated work.
acceptance:
  - "Given Expo publishes a new patch for the installed SDK, when the cron job next
    runs, then a deploy/hds PR bumping exactly the pins expo install --check names is
    open, with the lockfile regenerated and the mobile check green on its head."
  - "Given the pins already match, when the cron job runs, then it logs an
    up-to-date result and opens nothing."
validation:
  - "The cron job's log on the host shows either an up-to-date result or a bump PR opened;
    pnpm --filter @rakazo/mobile check exits 0 on the deploy/hds tip after that PR merges."

## Decisions
- `ops/README.md` and `ops/network.md` (tracked on `deploy/hds`, not on the branch this
  plan is filed from) record the deployment's carried patches, its host placement, and why
  the earlier network isolation VLAN was retired; this plan defers to both rather than
  restating them.
- `.claude/plans/rakazo-update-and-migration-plan.md` (untracked, local to the operator's
  checkout, referenced here by name only) is the source for the fork's longer running
  upstream and migration sequencing; this plan covers only the slice of it that is both
  current and actionable in the next two weeks.

## Changes
- 2026-09-11 v1: initial plan.
