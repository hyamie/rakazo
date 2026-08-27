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

Every model reaches this deployment through **LiteLLM on `192.168.10.11:4000`
and nothing else**. `RAKAZO_PROVIDER_ALLOWLIST=openai-compatible` enforces it in
two places: the picker never lists another provider, and the runtime refuses one
before resolving a model, so a connection stored earlier cannot keep billing.

The virtual key is `LiteLLM - VKey Rakazo` in the 1Password `ClaudeAgents`
vault, scoped to two lanes and nothing else:

| Lane | Models |
|---|---|
| ChatGPT Pro subscription | `chatgpt-sol`, `chatgpt-terra` |
| Local hardware | `gx10-fast`, `gx10-coder` (vLLM on the GX10), `ollama-qwen3-5-35b-a3b`, `ollama-qwen3-5-9b` (19th Hole), `ollama-gemma4-12b` |

> **Do not put `gpt4o-vision` back.** On this LiteLLM it routes to
> `openrouter/openai/gpt-4o`, so selecting it sends traffic and money to
> OpenRouter no matter what the Rakazo-side config says. `nemotron-3-nano` and
> `nemotron-3-super` are OpenRouter routes too. `claude-*` are metered Anthropic.
> None of them are on this key, deliberately. Check
> `/model/info` and read `litellm_params.model` before adding any model here:
> the gateway name says nothing about where the request actually goes.

## Getting in

**Web UI: `https://192.168.60.10`** from Main or over the Road-Warrior VPN. The
certificate comes from Caddy's internal CA, so the first visit warns; the root is
at `/data/caddy/pki/authorities/local/root.crt` inside the caddy container if you
want to trust it once. `http://` 308-redirects to `https://`.

Two things about that edge were wrong out of the box and are fixed in
`ops/compose/Caddyfile.lan`:

- `Caddyfile.prod` defaults `RAKAZO_HOST` to `app.example.com` and attempts a
  **public ACME issuance** against a box with no public DNS. It fails on a loop
  and the edge never serves. `local_certs` replaces it.
- With `local_certs` alone, browsing to the **bare IP hangs**. Neither curl nor a
  browser sends SNI for an IP literal (RFC 6066), so Caddy has no site to match
  and never finishes the handshake: port 443 accepts, the request times out, the
  log says nothing. It is indistinguishable from a firewall drop, and it cost a
  detour into the gateway before `--resolve` with a hostname returned 200 against
  the same server. `default_sni` pins the fallback.

**Shell: `ssh rakazo-vm`**, which jumps via `pve-node-2`. Direct SSH to the VM
works and then stops working on a ~5 minute cycle: the UDM's IPS matches
`ET SCAN Potential SSH Scan OUTBOUND` (sig 2003068) on inter-VLAN SSH and
blocklists the flow. HTTPS is unaffected. Full measurement in `ops/network.md`.

## Redeploying

`./ops/deploy.sh up` passes `--force-recreate`, deliberately. Compose keys a
container's config hash off the rendered service definition, and an edit to
`.env` that only moves an interpolated bind-mount source can leave a running
container on the old file. That is not hypothetical: Caddy sat on the upstream
Caddyfile through a redeploy and kept retrying ACME for `app.example.com` while
`.env` had already been corrected.
