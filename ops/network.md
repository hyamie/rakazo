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
| 10024 | `Block-Sandbox-to-Private` | → Core, Main, Media, IoT, Cameras, Guest: denied. NEW connections only. |
| 10025 | `Block-Sandbox-to-Gateway-Mgmt` | → the other VLANs' gateway IPs: denied. NEW connections only. |

**Both blocks must match `NEW` connections only, and that is not a detail.** They
were created with UniFi's default `connection_state_type: ALL`, which also
matches the *return* leg of a connection someone else opened, because a reply
from the sandbox to Main is still "sourced from VLAN 60". The effect was total:
the VM stopped answering ping from Main and every HTTP request timed out, while
the VM itself was perfectly healthy and its own outbound traffic worked. It
reads as a dead host, not a firewall rule. If a one-directional block ever
appears to have taken the whole host offline, check `connection_state_type`
first.

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

Verified from Main after the state fix, so both properties hold at once:

```
ping 192.168.60.10                 0% loss
https://192.168.60.10/health       200  {"ok":true,...,"sandbox":"docker"}
https://192.168.60.10/             200
http://192.168.60.10/              308 -> https
```

## Known gap

`192.168.60.1:443` is still reachable, so a bot can load the UDM management UI on
its own gateway. Closing it needs a port-scoped pair (allow 53 and DHCP to the
gateway zone, block the rest) rather than a flat block, because that same address
serves the sandbox its DNS.

## Getting a shell

Use `ssh rakazo-vm`, which jumps via `pve-node-2`.

Direct SSH to `192.168.60.10` **works and then stops working, on a cycle**. The
UDM's IPS matches `ET SCAN Potential SSH Scan OUTBOUND` (sig 2003068) on
inter-VLAN SSH and adds the flow to its `ips` ipset with a ~5 minute timeout.
Sessions already open survive; the next connection times out until the entry
ages out. Measured directly:

```
# three normal SSH sessions, five seconds apart -> all succeed, and then:
# ipset list ips
192.168.60.10,tcp:22,192.168.10.117 timeout 283
# next three connections -> Connection timed out, x3
```

**This is SSH-specific.** HTTPS to the web UI kept returning 200 throughout, so
the thing Mike actually uses is unaffected. The permanent fix is a
signature-scoped IPS exception (the mechanism is written up for the git-over-SSH
case in `~/projects/active/ubiquiti/docs/ips-github-ssh-fix-options.md`); it
changes the production gateway's security posture, so it has not been applied.
