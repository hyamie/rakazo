/**
 * Which LAN hosts this deployment may reach an MCP server on.
 *
 * The connector guard in remote-mcp.ts refuses every private address by design. On
 * the hosted product a workspace-supplied endpoint is attacker-controlled input, so
 * a URL pointing at 169.254.169.254 or 10.0.0.5 is an SSRF into the operator's own
 * network, and refusing it is correct.
 *
 * A self-hosted install inverts that. Its MCP servers are on the same switch as the
 * deployment, the operator supplied the endpoint, and "reach a private address" is
 * the entire requirement. Today such an operator has no way to say so and gets a
 * flat "Connector URL targets a private host".
 *
 * RAKAZO_MCP_LAN_ALLOWLIST names the hosts this deployment trusts. Unset keeps the
 * upstream refusal, so nothing changes anywhere the operator has not opted in.
 *
 * A listed host relaxes exactly two rules: it may be reached over plain HTTP, and it
 * may resolve to a private address. Everything else holds. In particular redirects
 * stay rejected, so a listed host cannot bounce a request onto an unlisted one, and
 * the connect-time address check still runs for every host that is not listed, which
 * is what keeps DNS rebinding closed.
 *
 * Entries are `host` or `host:port`, comma-separated. A bare host matches any port;
 * an entry with a port must match that port exactly, which lets an operator open one
 * gateway on one port without opening the rest of the box.
 */
export const MCP_LAN_ALLOWLIST_ENV = "RAKAZO_MCP_LAN_ALLOWLIST";

export type LanAllowlistEntry = { host: string; port?: string };

/** Lowercase, drop the FQDN root dot, and unwrap an IPv6 literal's brackets. */
export function normalizeHost(hostname: string): string {
  return hostname
    .trim()
    .toLowerCase()
    .replace(/\.$/, "")
    .replace(/^\[|\]$/g, "");
}

function splitHostPort(raw: string): LanAllowlistEntry | undefined {
  const value = raw.trim();
  if (!value) return undefined;
  // An IPv6 literal is only unambiguous in bracket form, so a port may follow the
  // closing bracket. A bare IPv6 literal is all host, colons included.
  if (value.startsWith("[")) {
    const close = value.indexOf("]");
    if (close === -1) return undefined;
    const host = normalizeHost(value.slice(0, close + 1));
    const rest = value.slice(close + 1);
    if (!rest) return { host };
    if (!rest.startsWith(":")) return undefined;
    return { host, port: rest.slice(1) };
  }
  const colons = value.split(":").length - 1;
  if (colons > 1) return { host: normalizeHost(value) };
  if (colons === 1) {
    const [host, port] = value.split(":");
    if (!host || !port) return undefined;
    return { host: normalizeHost(host), port };
  }
  return { host: normalizeHost(value) };
}

export function lanAllowlistEntries(
  env: NodeJS.ProcessEnv = process.env,
): readonly LanAllowlistEntry[] {
  return (env[MCP_LAN_ALLOWLIST_ENV] ?? "")
    .split(",")
    .map(splitHostPort)
    .filter((entry): entry is LanAllowlistEntry => entry !== undefined && entry.host.length > 0);
}

/** The port a URL actually connects on, which is implicit for the default schemes. */
function effectivePort(url: URL): string {
  if (url.port) return url.port;
  if (url.protocol === "https:") return "443";
  if (url.protocol === "http:") return "80";
  return "";
}

/**
 * Whether the operator has opted this deployment into reaching `url` on the LAN.
 *
 * Takes the URL rather than a bare hostname so a port-scoped entry can be honoured;
 * `isLanAllowedHostname` is the connect-time form, where only the hostname is known.
 */
export function isLanAllowedUrl(url: URL, env: NodeJS.ProcessEnv = process.env): boolean {
  const host = normalizeHost(url.hostname);
  const port = effectivePort(url);
  return lanAllowlistEntries(env).some(
    (entry) => entry.host === host && (entry.port === undefined || entry.port === port),
  );
}

/**
 * Hostname-only form for the DNS lookup path, which sees no port.
 *
 * A port-scoped entry still matches here. That is deliberate and not a hole: the URL
 * check above has already rejected a wrong-port request before any socket is opened,
 * so widening at the lookup would require an allowed URL to somehow connect on a port
 * it was not validated for.
 */
export function isLanAllowedHostname(
  hostname: string,
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  const host = normalizeHost(hostname);
  return lanAllowlistEntries(env).some((entry) => entry.host === host);
}
