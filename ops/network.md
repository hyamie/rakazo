# Network placement

Rakazo runs on **VLAN 10 `Main`** at `192.168.10.30/24`, alongside the rest of the
dev estate. It spent 2026-08-27 to 2026-08-28 on a dedicated VLAN 60 `AI-Sandbox`;
that is retired, and this document records why, because the reasoning is the
reusable part.

## Why it is not on its own VLAN

The original argument was sound in the abstract. A bot drives its own browser and
shell, so the interesting failure is not "the host is compromised", it is "the
agent was talked into fetching an internal URL". That is a live CVE class
(browser-use CVE-2025-47241), and the textbook answer is network policy rather
than a container boundary. So Rakazo went on VLAN 60 with LiteLLM, n8n and qmd as
the only carve-outs.

It did not survive contact with the gateway. **The UDM's IPS silently black-holes
inter-VLAN flows**, and it does it to whatever flow it feels like, not just the
one you planned for:

- First it took inter-VLAN **SSH**, matching `ET SCAN Potential SSH Scan OUTBOUND`
  (sig 2003068) and adding the flow to its `ips` ipset with a ~5 minute timeout.
  That was written off as SSH-specific and worked around with a ProxyJump.
- Then on 2026-08-28 it took the **LiteLLM** flow too, `192.168.60.10 ->
  192.168.10.11:4000`, logged as `THREAT_BLOCKED_V3` / VERY_HIGH. Which is the
  product's only path to a model. Runs failed with `Request timed out.` while the
  `Allow-Sandbox-to-LiteLLM` policy sat enabled with an advancing hit counter.

The measurement that settled it: `tcpdump` on pve-node-1 caught **zero packets**
from four connect attempts, while n8n `:5678` and qmd `:8181` from the same
container at the same instant connected in ~1 ms, and LiteLLM answered a VLAN 10
host 8/8. Nothing was wrong with the rule, the route, conntrack, or the host. The
gateway was eating the flow.

**The judgement call:** the isolation bought less than it appeared to. Those bots
already have open internet egress and hold a GitHub token for ~60 private repos,
so a bot that wants to leak something does not need lateral reach to do it. What
the VLAN actually bought was protection against lateral movement, and it was paid
for with a product that worked about a third of the time and a permanent
dependency on hand-written IPS exceptions for every new service a bot needs.

Accepted tradeoff: Rakazo sits on the dev VLAN. The **VM boundary is the
containment** and it still holds the root-equivalent Docker socket the supervisor
needs. If lateral isolation is wanted again, do it with an IPS exception in place
from day one, not after.

## Two lessons worth keeping

**A one-directional block with `connection_state_type: ALL` takes the whole host
offline.** UniFi's default matches the *return* leg of a connection someone else
opened, because a reply from the sandbox to Main is still "sourced from VLAN 60".
The VM stopped answering ping and every HTTP request timed out while the VM was
perfectly healthy. It reads as a dead host, not a firewall rule. If a
one-directional block appears to have killed a host, check `connection_state_type`
first.

**When a gateway drops traffic, read its own event log before theorising.** The
UDM names its own action verbatim in `unifi_list_events`
(`THREAT_BLOCKED_V3`, with source and destination). A tcpdump on the far end, the
destination's firewall, its routing table, conntrack counters and NIC config were
all read first, and all of them were clean, because the answer was never there.

## Getting a shell

`ssh rakazo-vm` reaches `192.168.10.30` directly. The ProxyJump via `pve-node-2`
is no longer needed: RipOrDie and the VM are on the same L2 segment, so SSH never
crosses the gateway and the IPS never sees it.
