---
key: rakazo
title: "rakazo"
team: HDS
initiative: HDS Products
appetite: "2 weeks"
plan_version: 1
---

## Problem
HDS runs Rakazo as a self hosted product on its own fork (`hyamie/rakazo`), with all
deployment specific configuration and behavioral patches carried on branch `deploy/hds`,
which is this fork's trunk and where this plan is filed (`main` is an unmaintained mirror
of upstream that no pull request targets). A cron job, `ops/sync-upstream.sh`, keeps
`deploy/hds` caught up with `elie222/rakazo` by opening a clean merge PR or filing a
tracking issue on a real conflict. It is doing exactly that right now: GitHub issue #14,
"Upstream sync blocked," has stood open since 2026-09-09 and was refreshed again today,
reporting 29 commits behind `upstream/main` with five files in real conflict. Two earlier catch up
PRs, #12 and #13, were opened before that conflict appeared and no longer cover the full
range.

Separately, the fork carries three smaller pieces of maintenance debt, each already
described in the fork's own tracked history. The host that runs the deployment was
migrated to new hardware on 2026-09-10 (`ops/README.md`), and the pre-migration guest is
still kept powered off as a rollback that has not yet been retired. The production
deployment has not yet picked up the most recently merged fix (fork PR #20, the tool
result truncation fix, commit `78bbac15`). And the Expo mobile pins have needed a manual,
reactive fix twice in this fork's own history (PRs #18 and #19), because the repo's own
mobile install check only runs on push to `main` in `.github/workflows/ci.yml`, which
never fires for this fork's `deploy/hds` line.

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
- SC-005 A deliberately mismatched Expo SDK package pin fails CI before merge.

## Definition of Done
PR merged with CI green on `.github/workflows/ci.yml` (`pnpm install --frozen-lockfile`,
`pnpm db:generate`, `pnpm lint`, `pnpm check`, `pnpm test`, `pnpm test:integration`); for
any PR opened against `deploy/hds`, the `hds-deploy-check` workflow also green; for a
deployment change, the target's `/health` endpoint reports the deployed revision;
validation commands below executed and their output recorded on the issue or PR.

## Non-goals
- Upstream's own feature roadmap is upstream's to run; this fork tracks only its own
  patches, its own deployment, and staying current, per `AGENTS.md`'s scope.
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
exit: the production deployment's health endpoint reports the caught up revision, the pre-migration VM is gone from the cluster's resource list, and CI fails a deliberately mismatched Expo pin.

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
  conflict, including packages/adapters/src/remote-mcp.ts, mcp-transport.ts,
  web-ssrf.ts, network-address.ts and undici-fetch.ts. Those files back the fork's own
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
  derives from the active model's context window) and belongs upstream. Branch from
  upstream/main and cherry-pick only the truncation fix commits onto that branch, then
  open it against elie222/rakazo:main. Do not branch from deploy/hds: merging upstream
  into the fork does not make the two branches identical, so a PR opened from deploy/hds
  would carry every one of this fork's deployment and behavioral commits into upstream's
  review.
acceptance:
  - "Given a branch created from upstream/main carrying only the cherry-picked truncation
    fix commits, when it is opened as a PR against elie222/rakazo:main, then the PR's
    changed file list contains only the truncation fix and upstream's own CI passes on
    it."
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
  destroy the old guest, then correct the migration paragraph in ops/README.md that still
  says the old guest stays stopped until it is destroyed. The host table row is not the
  place to look: it never carried a rollback caveat, so an acceptance written against it
  would pass without anyone touching the stale sentence.
acceptance:
  - "Given the redeploy in I005 is verified healthy, when the pre-migration VM is
    destroyed, then it no longer appears in the cluster's resource list and the migration
    paragraph in ops/README.md no longer states that the old guest is kept stopped as a
    rollback."
validation:
  - "pvesh get /cluster/resources --type vm on a cluster node no longer lists the
    pre-migration guest's VMID."

### I007 Gate deploy/hds PRs on the mobile install check
milestone: M2
priority: low
labels: [Improvement]
depends_on: []
description: >
  The mobile app already has a working drift check: apps/mobile's own "check" script
  runs expo install --check ahead of a plain typecheck. But ci.yml only calls it inside
  publish-mobile-update, which is gated to push on main, so it never runs against a
  deploy/hds PR. That gap is why apps/mobile/package.json pins have needed two reactive
  fixes in this fork's history (PRs #18 and #19) with nothing catching the mismatch
  first. Add the same check as a step in hds-deploy-check.yml, the fork's own PR gate for
  deploy/hds, so a pin mismatch fails the PR instead of a later build.
acceptance:
  - "Given a PR into deploy/hds bumps expo or a sibling expo-*/react-native-* package out
    of alignment with the SDK's expected versions, when hds-deploy-check runs, then the
    new step fails before merge."
validation:
  - "pnpm --filter @rakazo/mobile check exits non-zero against a deliberately mismatched
    pin and exits 0 on the current tree."

## Decisions
- This plan is filed on `deploy/hds`, and `deploy/hds` is this repository's default
  branch. `main` here is an unmaintained mirror of `upstream/main`: it carries none of the
  fork's own work and is the base of no pull request, including the ones
  `ops/sync-upstream.sh` opens. The linear-os runner reads `docs/PLAN.md` from
  `origin/<default>` and treats a missing plan as a failure for the whole cohort run, so
  the plan and the default branch have to name the same branch.
- The `linear-os-validate` CI gate is deliberately not installed here yet. It consumes
  `hyamie/linear-os` as a GitHub Action; that repository is private and this one is
  public, so the workflow fails at action resolution before it validates anything. The
  same action at the same pinned commit resolves from a private repository in the cohort,
  and linear-os is not on PyPI, so there is no tokenless install path. Until the validator
  is reachable from a public repository, this plan is validated by the linear-os runner
  after merge rather than by a check before it.
- `ops/README.md` and `ops/network.md` record the deployment's carried patches, its host
  placement, and why the earlier network isolation VLAN was retired; this plan defers to
  both rather than restating them.
- `.claude/plans/rakazo-update-and-migration-plan.md` (untracked, local to the operator's
  checkout, referenced here by name only) is the source for the fork's longer running
  upstream and migration sequencing; this plan covers only the slice of it that is both
  current and actionable in the next two weeks.

## Changes
- 2026-09-11 v1: initial plan.
