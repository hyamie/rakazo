# HDS deployment

Everything in this directory is HDS-specific and never appears upstream, so
merging `upstream/main` cannot conflict with our deployment configuration. The
two behavioural changes we need could not live here (they are source changes)
and are carried as branches instead, each shaped as an upstream PR.

## Where it runs

| | |
|---|---|
| Host | Proxmox VM 102 `rakazo` on `pve-node-2` |
| Resources | 12 GB fixed (no balloon), 2 vCPU, 150 GB |
| CPU model | `x86-64-v3`, not `host`, so it can migrate cluster-wide |
| Disk | `extra-storage` (`/dev/sda`, SATA SSD, own VG) |
| Network | VLAN 60 `AI-Sandbox`, `192.168.60.10/24`, gateway `.1` |
| Checkout | `/opt/rakazo`, branch `deploy/hds` |
| Secrets | `/opt/rakazo/.env`, mode 600, generated at deploy |

Ballooning is deliberately off. Bot computers spawn Chromium, and Proxmox
adjusts the balloon on a ~10 s pvestatd cycle, which is slow next to a browser
memory spike. A balloon that inflates late shows up as an OOM kill inside the
guest, which is the hardest failure to attribute.

The disk sits on `extra-storage` because it is a separate physical device.
`local-lvm` is on the NVMe that `hyams-postgres` uses, and that Postgres is the
memory store for the LangGraph agents on node-5. Browser profile and artifact
churn stays off it.

### Why a dedicated guest at all

The sandbox supervisor holds a root-equivalent Docker socket. node-2's own
daemon runs `hyams-postgres`, `steel-browser`, `save-pipeline`, `crawl4ai` and
the Home Assistant VM, so the supervisor does not go there. The VM boundary is
the containment, and the VLAN is the second layer: a bot has a browser and a
shell, and the live CVE class here (browser-use CVE-2025-47241) is exactly
"agent browser reaches internal services".

## Deploying

```bash
ssh rakazo-vm
cd /opt/rakazo
git fetch origin && git reset --hard origin/deploy/hds
./ops/deploy.sh up          # build + start
./ops/deploy.sh ps
./ops/deploy.sh logs api
```

`ops/deploy.sh` pins the compose invocation. Do not hand-roll it: Compose
resolves every relative path against the project directory, which it takes from
the first `-f` file (`infra/compose`). Passing `--project-directory` repoints
the upstream prod file's own `env_file: ../../.env` at `/.env` and nothing
resolves.

`compose/docker-compose.sandbox.yml` grafts the `supervisor` and `computer`
services onto `infra/compose/docker-compose.prod.yml` and flips
`SANDBOX_PROVIDER` back to `docker`. The prod file is the hardened topology but
pins `e2b` and ships no supervisor; E2B is out on economics, because its free
tier caps a sandbox session at one hour and Rakazo's model is a persistent Team
Computer, which lands it on the $150/mo Pro tier.

The `updater` is excluded via an unactivated Compose profile. A second
root-equivalent Docker socket is not worth it for a single-operator tool, and
its official path refuses anyway while only a `v0.1.0-beta` prerelease tag
exists.

## Carried patches

Both are on their own branches off `main`, merged into `deploy/hds`, and are
written to be opened upstream as-is.

**`feat/configurable-vision-modalities`** — `local` and `openai-compatible`
models hardcode `input: ["text"]`, and `modelAcceptsImageInput` gates the
screenshot-returning computer tools on `input.includes("image")`. A vision model
behind LiteLLM therefore silently loses `computer_observe`, `computer_act`,
`open_path` and `launch_app`, and no bot can drive a computer. Adds
`RAKAZO_OPENAI_COMPATIBLE_VISION_MODELS` / `RAKAZO_LOCAL_VISION_MODELS` so the
operator can declare what their endpoint actually serves. Text-only stays the
default. Refs upstream #199 and #203.

**`feat/sandbox-resource-limits`** — `containerCreateOptions` set `ShmSize` and
nothing else, so every bot computer ran with no `Memory`, `NanoCpus` or
`PidsLimit`. Adds all three with 2g / 2 CPUs / 512 pids defaults, overridable,
and opt-out via `"0"`, `"none"` or `"unlimited"`.

## Models

All LLM traffic goes through LiteLLM at `192.168.10.11:4000`, never a direct
provider key. The virtual key is `LiteLLM - VKey Rakazo` in the 1Password
`ClaudeAgents` vault, scoped to `gpt4o-vision`, `claude-sonnet`, `claude-haiku`.

> Those three are metered provider spend on the OpenAI and Anthropic accounts
> behind LiteLLM, not subscription capacity. A bot driving a computer sends a
> screenshot per step, so a long computer-use session is the expensive shape.

## Getting in

Use `ssh rakazo-vm`, which jumps via `pve-node-2`.

The direct path does not work: the UDM's IPS matches `ET SCAN Potential SSH Scan
OUTBOUND` (signature 2003068) on inter-VLAN SSH and drops the flow into its
`ips` ipset with a ~200 s timeout, so sessions fail and intermittently recover.
Verified on the gateway, not inferred:

```
# ipset list ips
192.168.60.10,tcp:22,192.168.10.117 timeout 197
```

node-2 holds an address on VLAN 60, so it reaches the VM at L2 and never
touches the gateway. This is the same false positive already written up in
`~/projects/active/ubiquiti/docs/ips-github-ssh-fix-options.md`. The permanent
fix is an IPS exception scoped to that signature; it has not been applied
because it changes the production gateway's security posture.
