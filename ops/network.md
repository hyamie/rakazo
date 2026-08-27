# Network placement

Rakazo runs on **VLAN 60 `AI-Sandbox`** (`192.168.60.0/24`), created 2026-08-27.
Nothing else lives there yet.

## Why a VLAN and not just the VM

The VM boundary contains the root-equivalent Docker socket the supervisor holds.
The VLAN contains something different: a bot drives its own browser and shell, so
the interesting failure is not "the host is compromised", it is "the agent was
talked into fetching an internal URL". That is a live CVE class
(browser-use CVE-2025-47241), and the answer to it is network policy, not a
container boundary.

## Policy

Applied on the UDM as zone-based firewall policies. All LAN networks sit in the
**Internal** zone, including new ones: the controller exposes no API to place a
network in `Dmz`, so the isolation is written explicitly rather than inherited.

| Idx | Policy | Effect |
|---|---|---|
| 10003 | `Allow-VPN-to-Sandbox` | Road-Warrior VPN reaches the sandbox, so the web UI and bot screens work from the phone and from away. No new ingress. |
| 10022 | `Allow-Sandbox-to-LiteLLM` | → `192.168.10.11:4000/tcp` only. |
| 10023 | `Allow-Sandbox-to-n8n` | → `192.168.10.13:5678/tcp` only. |
| 10024 | `Block-Sandbox-to-Private` | → Core, Main, Media, IoT, Cameras, Guest: denied. |
| 10025 | `Block-Sandbox-to-Gateway-Mgmt` | → the other VLANs' gateway IPs: denied. |

Inbound from Main is untouched: every block matches only traffic **sourced** from
VLAN 60, so a browser on Main reaches the web UI normally.

Verified from inside the VM after the rules were applied:

```
LiteLLM 192.168.10.11:4000      200          n8n 192.168.10.13:5678   200
internet github.com             200          DNS                      OK
RipOrDie      :22   blocked     RipOrDie :8181 (qmd/PII)      blocked
pve-node-2    :8006 blocked     Home Assistant :8123          blocked
UDM 192.168.1.1 / .10.1 / .30.1 :443          blocked
```

Both carve-outs are port-scoped, so the rest of what those hosts run stays out
of reach. Verified:

```
192.168.10.11:4000 LiteLLM   REACHABLE     192.168.10.13:5678 n8n     REACHABLE
192.168.10.11:5432 Postgres  blocked       192.168.10.13:3900 garage  blocked
192.168.10.11:8006 PVE mgmt  blocked
```

## Known gap

`192.168.60.1:443` is still reachable, so a bot can load the UDM management UI on
its own gateway. Closing it needs a port-scoped pair (allow 53 and DHCP to the
gateway zone, block the rest) rather than a flat block, because that same address
serves the sandbox its DNS. Not yet applied: it was not worth risking the
segment's DNS while the stack was building.

## Getting a shell

`ssh rakazo-vm` jumps via `pve-node-2`. The direct path fails: see the IPS note
in `ops/README.md`.
