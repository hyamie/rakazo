import { createHash } from "node:crypto";

export const COMPUTER_IMAGE = process.env.RAKAZO_COMPUTER_IMAGE ?? "rakazo/computer:local";
export const TEAM_SCREEN_LIMIT = 8;
export const SCREEN_HOST = process.env.SANDBOX_SCREEN_HOST ?? "127.0.0.1";

/**
 * Host address the computer's screen ports are published on.
 *
 * The default binds to loopback, which is right when the supervisor and the web
 * app run directly on the same host as the bot containers. It breaks silently
 * the moment they are containerised, as they are in docker-compose.prod.yml:
 * the supervisor publishes the screen on the host's 127.0.0.1, then probes it
 * at SANDBOX_SCREEN_HOST, and from inside its own network namespace that
 * address is not the host. The probe cannot succeed, so it hangs for its full
 * timeout on every attempt, the run re-queues, and the bot never answers. The
 * failure surfaces as a run that loops "running -> queued" with no error, which
 * looks like a model problem and is not.
 *
 * Set this to an address the sibling containers can reach. The docker bridge
 * gateway is the right choice: siblings reach it, and unlike 0.0.0.0 it does
 * not put an unauthenticated VNC port on the LAN. Browsers never touch it
 * directly; the web app's signed screen proxy is the only path in.
 */
export const COMPUTER_BIND_HOST = process.env.RAKAZO_COMPUTER_BIND_HOST ?? "127.0.0.1";

/**
 * Resource ceilings for a bot computer.
 *
 * A computer runs Xvfb, a window manager and a full Chromium on behalf of an
 * agent that decides for itself what to open. Without a ceiling one bot's
 * runaway page is a host-wide memory and CPU event that takes every other bot
 * and the Rakazo services down with it, which is the same reason every service
 * in docker-compose.prod.yml carries mem_limit and pids_limit.
 *
 * Defaults are deliberately generous enough for real browsing and small enough
 * that a single computer cannot exhaust a documented 8 GB host. Set any of
 * these to "0" or "unlimited" to restore the previous uncapped behaviour.
 */
const DEFAULT_COMPUTER_MEMORY = "2g";
const DEFAULT_COMPUTER_CPUS = "2";
const DEFAULT_COMPUTER_PIDS_LIMIT = "512";

const MEMORY_UNITS: Record<string, number> = {
  b: 1,
  k: 1024,
  m: 1024 ** 2,
  g: 1024 ** 3,
};

function isUnlimited(raw: string): boolean {
  const value = raw.trim().toLowerCase();
  return value === "0" || value === "unlimited" || value === "none";
}

/** Bytes from a docker-style size string ("2g", "1536m", "1073741824"). */
export function parseMemoryBytes(name: string, raw: string): number {
  if (isUnlimited(raw)) return 0;
  const match = /^(\d+(?:\.\d+)?)\s*([bkmg])?b?$/i.exec(raw.trim());
  if (!match) {
    throw new Error(`${name} must be a size like "2g", "1536m" or a byte count, received "${raw}"`);
  }
  const scale = MEMORY_UNITS[(match[2] ?? "b").toLowerCase()] ?? 1;
  const bytes = Math.floor(Number(match[1]) * scale);
  if (!Number.isSafeInteger(bytes) || bytes <= 0) {
    throw new Error(`${name} must resolve to a positive byte count, received "${raw}"`);
  }
  return bytes;
}

/** Docker NanoCpus (1e9 per core) from a CPU count like "1.5". */
export function parseNanoCpus(name: string, raw: string): number {
  if (isUnlimited(raw)) return 0;
  const value = Number(raw.trim());
  if (!Number.isFinite(value) || value <= 0) {
    throw new Error(`${name} must be a positive number of CPUs, received "${raw}"`);
  }
  return Math.floor(value * 1e9);
}

function parsePidsLimit(name: string, raw: string): number {
  if (isUnlimited(raw)) return 0;
  const value = Number(raw.trim());
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new Error(`${name} must be a positive integer, received "${raw}"`);
  }
  return value;
}

/** The host resource ceilings applied to every bot computer. */
export function computerResourceLimits() {
  const memoryBytes = parseMemoryBytes(
    "RAKAZO_COMPUTER_MEMORY",
    process.env.RAKAZO_COMPUTER_MEMORY ?? DEFAULT_COMPUTER_MEMORY,
  );
  const nanoCpus = parseNanoCpus(
    "RAKAZO_COMPUTER_CPUS",
    process.env.RAKAZO_COMPUTER_CPUS ?? DEFAULT_COMPUTER_CPUS,
  );
  const pidsLimit = parsePidsLimit(
    "RAKAZO_COMPUTER_PIDS_LIMIT",
    process.env.RAKAZO_COMPUTER_PIDS_LIMIT ?? DEFAULT_COMPUTER_PIDS_LIMIT,
  );
  return {
    // Memory and MemorySwap are set together: leaving MemorySwap unset lets the
    // container swap to twice Memory, so the ceiling would not hold.
    Memory: memoryBytes,
    MemorySwap: memoryBytes,
    NanoCpus: nanoCpus,
    PidsLimit: pidsLimit,
  };
}

const WORKSPACE_ROOT = "/home/rakazo";

export type ExtraMount = { source: string; target: string; readOnly: boolean };

/**
 * Host paths and named volumes mounted into every bot computer beyond its own
 * workspace, from RAKAZO_COMPUTER_EXTRA_MOUNTS.
 *
 * Entries are `source:target` or `source:target:ro|rw`, comma-separated. Unset
 * gives a computer exactly the one workspace bind it has always had.
 *
 * The target may not be inside /home/rakazo, and that is a correctness rule
 * rather than tidiness. /home/rakazo is the portable workspace: AgentHomeStore
 * checkpoints it into DATA_DIR at every run completion, failure, explicit stop
 * and idle suspension. A read-only host tree mounted inside it would be walked
 * and copied on every one of those boundaries, so pointing a large source there
 * turns each run boundary into a full copy of it. Mount siblings instead, e.g.
 * /mnt/projects.
 */
export function computerExtraMounts(
  raw: string | undefined = process.env.RAKAZO_COMPUTER_EXTRA_MOUNTS,
): ExtraMount[] {
  return (raw ?? "")
    .split(",")
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0)
    .map((entry) => {
      const parts = entry.split(":");
      if (parts.length < 2 || parts.length > 3) {
        throw new Error(
          `RAKAZO_COMPUTER_EXTRA_MOUNTS entry must be source:target[:ro|rw], got "${entry}"`,
        );
      }
      const [source, target, mode = "ro"] = parts as [string, string, string?];
      if (!source || !target) {
        throw new Error(`RAKAZO_COMPUTER_EXTRA_MOUNTS entry has an empty side: "${entry}"`);
      }
      if (!target.startsWith("/")) {
        throw new Error(`RAKAZO_COMPUTER_EXTRA_MOUNTS target must be absolute: "${target}"`);
      }
      if (target === WORKSPACE_ROOT || target.startsWith(`${WORKSPACE_ROOT}/`)) {
        throw new Error(
          `RAKAZO_COMPUTER_EXTRA_MOUNTS target "${target}" is inside ${WORKSPACE_ROOT}, which is ` +
            "checkpointed on every run boundary; mount it as a sibling instead",
        );
      }
      if (mode !== "ro" && mode !== "rw") {
        throw new Error(`RAKAZO_COMPUTER_EXTRA_MOUNTS mode must be ro or rw, got "${mode}"`);
      }
      return { source, target, readOnly: mode === "ro" };
    });
}

export function screenPorts(index: number) {
  if (index < 0 || index >= TEAM_SCREEN_LIMIT) {
    throw new Error(
      `screen index ${index} exceeds the Team Computer limit of ${TEAM_SCREEN_LIMIT}`,
    );
  }
  return {
    display: `:${index + 1}`,
    displayNumber: index + 1,
    viewPort: String(6080 + index * 2),
    controlPort: String(6081 + index * 2),
    viewVncPort: 5900 + index * 2,
    controlVncPort: 5901 + index * 2,
  };
}

export function computerPortBindings() {
  const ExposedPorts: Record<string, object> = {};
  const PortBindings: Record<string, Array<{ HostIp: string; HostPort: string }>> = {};
  for (let index = 0; index < TEAM_SCREEN_LIMIT; index += 1) {
    const ports = screenPorts(index);
    ExposedPorts[`${ports.viewPort}/tcp`] = {};
    ExposedPorts[`${ports.controlPort}/tcp`] = {};
    PortBindings[`${ports.viewPort}/tcp`] = [{ HostIp: COMPUTER_BIND_HOST, HostPort: "0" }];
    PortBindings[`${ports.controlPort}/tcp`] = [{ HostIp: COMPUTER_BIND_HOST, HostPort: "0" }];
  }
  return { ExposedPorts, PortBindings };
}

export interface ComputerCreateInput {
  name: string;
  image: string;
  botId: string;
  workspaceId: string;
  homePath: string;
  networkMode?: string;
}

interface PointerInput {
  kind: "pointer";
  x: number;
  y: number;
  button?: "left" | "right";
  type: "move" | "down" | "up" | "click";
}

export type SandboxInput =
  | { kind: "key"; key: string; modifiers?: string[] }
  | PointerInput
  | { kind: "clipboard"; text: string };

export function containerCreateOptions(input: ComputerCreateInput) {
  const ports = computerPortBindings();
  return {
    Image: input.image,
    name: input.name,
    Tty: true,
    Env: [
      "DISPLAY=:1",
      "HOME=/home/rakazo",
      "PATH=/home/rakazo/.local/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin",
      "NPM_CONFIG_PREFIX=/home/rakazo/.local",
      "PIP_USER=1",
    ],
    Labels: {
      "rakazo.managed": "true",
      "rakazo.botId": input.botId,
      "rakazo.workspaceId": input.workspaceId,
    },
    ExposedPorts: ports.ExposedPorts,
    HostConfig: {
      Binds: [
        `${input.homePath}:/home/rakazo`,
        ...computerExtraMounts().map((m) => `${m.source}:${m.target}:${m.readOnly ? "ro" : "rw"}`),
      ],
      PortBindings: ports.PortBindings,
      ShmSize: 256 * 1024 * 1024,
      ...computerResourceLimits(),
      ReadonlyPaths: ["/usr/share/novnc"],
      AutoRemove: false,
      NetworkMode: input.networkMode ?? "bridge",
    },
    WorkingDir: "/home/rakazo",
  };
}

export function sanitizeIdentifier(botId: string) {
  const safe = botId.replace(/[^a-zA-Z0-9_.-]/g, "").slice(0, 40);
  return safe || "box";
}

export function containerNameFor(botId: string) {
  return `rakazo-bot-${sanitizeIdentifier(botId)}`;
}

export function computerNetworkNameFor(botId: string) {
  // Keep distinct botIds on distinct networks even when sanitization collapses
  // characters (e.g. "a/b" and "ab"). Do not change containerNameFor — that
  // name must stay stable so an existing computer can resume.
  const hash = createHash("sha256").update(botId).digest("hex").slice(0, 32);
  return `rakazo-computer-${sanitizeIdentifier(botId).slice(0, 32)}-${hash}`;
}

/** Current and prior network names used by this PR, for delete cleanup. */
export function computerNetworkNamesForCleanup(botId: string) {
  const safe = sanitizeIdentifier(botId);
  const digest = createHash("sha256").update(botId).digest("hex");
  return [
    computerNetworkNameFor(botId),
    `rakazo-computer-${safe}`,
    `rakazo-computer-${safe.slice(0, 32)}-${digest.slice(0, 8)}`,
  ];
}

export function screenUrlFor(hostPort: string, host = SCREEN_HOST) {
  return `http://${host}:${hostPort}/embed.html`;
}

/**
 * Decide which host:port clients (and readiness probes) should use.
 *
 * Per-bot NetworkMode isolation must not change this: a container always has a
 * docker-internal IP on its network, but browsers cannot load that 172.x
 * address. Only the internal compose topology may return the container IP;
 * the default topology must keep using the published host mapping.
 */
export function resolveScreenPublishTarget(input: {
  screenNetwork: string | undefined;
  networkMode: string | null | undefined;
  networks: Record<string, { IPAddress?: string } | undefined> | null | undefined;
  hostPort: string | undefined;
  containerPort: string;
  screenHost?: string;
}): { host: string; port: string } | undefined {
  if (input.screenNetwork === "internal") {
    const address = input.networkMode ? input.networks?.[input.networkMode]?.IPAddress : undefined;
    if (address) return { host: address, port: input.containerPort };
    return undefined;
  }
  if (input.hostPort) return { host: input.screenHost ?? SCREEN_HOST, port: input.hostPort };
  return undefined;
}

export function xdotoolCommand(input: SandboxInput): string[] {
  if (input.kind === "key") {
    const key = mapKey(input.key);
    const mods = (input.modifiers ?? []).map(mapKey);
    const combo = [...mods, key].join("+");
    return ["xdotool", "key", "--clearmodifiers", combo];
  }
  if (input.kind === "pointer") {
    const btn = input.button === "right" ? "3" : "1";
    if (input.type === "move")
      return ["xdotool", "mousemove", "--", String(input.x), String(input.y)];
    if (input.type === "down") {
      return ["xdotool", "mousemove", "--", String(input.x), String(input.y), "mousedown", btn];
    }
    if (input.type === "up") return ["xdotool", "mouseup", btn];
    return ["xdotool", "mousemove", "--", String(input.x), String(input.y), "click", btn];
  }
  return ["xdotool", "type", "--clearmodifiers", "--", input.text];
}

function mapKey(key: string) {
  const lower = key.toLowerCase();
  if (lower === "enter" || lower === "return") return "Return";
  if (lower === "esc" || lower === "escape") return "Escape";
  if (lower === "space") return "space";
  if (lower === "tab") return "Tab";
  if (lower === "backspace") return "BackSpace";
  if (lower === "ctrl" || lower === "control") return "ctrl";
  if (lower === "alt") return "alt";
  if (lower === "shift") return "shift";
  if (lower === "meta" || lower === "cmd" || lower === "super") return "super";
  return key;
}
