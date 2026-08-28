import { afterEach, describe, expect, it, vi } from "vitest";

const ENV = "RAKAZO_MCP_LAN_ALLOWLIST";

async function withEnv<T>(value: string | undefined, fn: () => Promise<T>) {
  const previous = process.env[ENV];
  if (value === undefined) delete process.env[ENV];
  else process.env[ENV] = value;
  vi.resetModules();
  try {
    return await fn();
  } finally {
    if (previous === undefined) delete process.env[ENV];
    else process.env[ENV] = previous;
    vi.resetModules();
  }
}

afterEach(() => vi.resetModules());

/** Every resolution answers with the LAN address, as the real gateway's DNS would. */
const resolvePrivate = async () => [{ address: "192.168.10.117", family: 4 }];

describe("LAN MCP allowlist parsing", () => {
  it("is empty when unset, so the connector guard is unchanged", async () => {
    await withEnv(undefined, async () => {
      const { lanAllowlistEntries } = await import("./mcp-lan-allowlist.js");
      expect(lanAllowlistEntries()).toEqual([]);
    });
  });

  it("reads a bare host, a host:port, and trims blanks", async () => {
    await withEnv(" 192.168.10.117:8181 , qmd.lan ,, ", async () => {
      const { lanAllowlistEntries } = await import("./mcp-lan-allowlist.js");
      expect(lanAllowlistEntries()).toEqual([
        { host: "192.168.10.117", port: "8181" },
        { host: "qmd.lan" },
      ]);
    });
  });

  it("treats a bracketed IPv6 literal's trailing colon as a port, a bare one as host", async () => {
    await withEnv("[fd00::1]:8181,fd00::2", async () => {
      const { lanAllowlistEntries } = await import("./mcp-lan-allowlist.js");
      expect(lanAllowlistEntries()).toEqual([
        { host: "fd00::1", port: "8181" },
        { host: "fd00::2" },
      ]);
    });
  });

  it("matches a port-scoped entry only on that port, counting the scheme default", async () => {
    await withEnv("192.168.10.117:80", async () => {
      const { isLanAllowedUrl } = await import("./mcp-lan-allowlist.js");
      expect(isLanAllowedUrl(new URL("http://192.168.10.117/mcp"))).toBe(true);
      expect(isLanAllowedUrl(new URL("http://192.168.10.117:8181/mcp"))).toBe(false);
      expect(isLanAllowedUrl(new URL("https://192.168.10.117/mcp"))).toBe(false);
    });
  });

  it("matches any port for a bare host", async () => {
    await withEnv("qmd.lan", async () => {
      const { isLanAllowedUrl } = await import("./mcp-lan-allowlist.js");
      expect(isLanAllowedUrl(new URL("http://qmd.lan:8181/mcp"))).toBe(true);
      expect(isLanAllowedUrl(new URL("https://QMD.lan/mcp"))).toBe(true);
      expect(isLanAllowedUrl(new URL("http://other.lan:8181/mcp"))).toBe(false);
    });
  });
});

describe("connector guard with the allowlist unset", () => {
  it("still refuses a private address (the upstream default)", async () => {
    await withEnv(undefined, async () => {
      const { assertSafeRemoteUrl } = await import("./remote-mcp.js");
      await expect(
        assertSafeRemoteUrl("https://192.168.10.117:8181/mcp", resolvePrivate),
      ).rejects.toThrow(/private host/);
    });
  });

  it("still refuses plain HTTP", async () => {
    await withEnv(undefined, async () => {
      const { assertSafeRemoteUrl } = await import("./remote-mcp.js");
      await expect(assertSafeRemoteUrl("http://example.com/mcp", resolvePrivate)).rejects.toThrow(
        /HTTPS/,
      );
    });
  });

  it("still refuses a public name that resolves to a private address", async () => {
    await withEnv(undefined, async () => {
      const { assertSafeRemoteUrl } = await import("./remote-mcp.js");
      await expect(
        assertSafeRemoteUrl("https://rebind.example/mcp", resolvePrivate),
      ).rejects.toThrow(/private address/);
    });
  });
});

describe("connector guard with a host listed", () => {
  it("admits that host over plain HTTP at a private address", async () => {
    await withEnv("192.168.10.117:8181", async () => {
      const { assertSafeRemoteUrl } = await import("./remote-mcp.js");
      const url = await assertSafeRemoteUrl("http://192.168.10.117:8181/mcp", resolvePrivate);
      expect(url.href).toBe("http://192.168.10.117:8181/mcp");
    });
  });

  it("does not admit a different private host", async () => {
    await withEnv("192.168.10.117:8181", async () => {
      const { assertSafeRemoteUrl } = await import("./remote-mcp.js");
      await expect(
        assertSafeRemoteUrl("http://192.168.10.11:4000/mcp", resolvePrivate),
      ).rejects.toThrow(/HTTPS|private host/);
    });
  });

  it("does not admit the same host on an unlisted port", async () => {
    await withEnv("192.168.10.117:8181", async () => {
      const { assertSafeRemoteUrl } = await import("./remote-mcp.js");
      await expect(
        assertSafeRemoteUrl("http://192.168.10.117:9999/mcp", resolvePrivate),
      ).rejects.toThrow(/HTTPS/);
    });
  });

  it("still refuses credentials and fragments on a listed host", async () => {
    await withEnv("192.168.10.117:8181", async () => {
      const { assertSafeRemoteUrl } = await import("./remote-mcp.js");
      await expect(
        assertSafeRemoteUrl("http://u:p@192.168.10.117:8181/mcp", resolvePrivate),
      ).rejects.toThrow(/credentials/);
      await expect(
        assertSafeRemoteUrl("http://192.168.10.117:8181/mcp#frag", resolvePrivate),
      ).rejects.toThrow(/fragment/);
    });
  });

  it("still refuses a non-HTTP scheme on a listed host", async () => {
    await withEnv("192.168.10.117", async () => {
      const { assertSafeRemoteUrl } = await import("./remote-mcp.js");
      await expect(assertSafeRemoteUrl("ftp://192.168.10.117/mcp", resolvePrivate)).rejects.toThrow(
        /HTTPS/,
      );
    });
  });
});

describe("connect-time lookup", () => {
  async function lookupOnce(hostname: string) {
    const { createSafeLookup } = await import("./remote-mcp.js");
    const lookup = createSafeLookup(resolvePrivate);
    return new Promise<{ error: Error | null; address: string }>((resolve) => {
      lookup(hostname, { all: false }, (error, address) =>
        resolve({ error: error as Error | null, address: String(address) }),
      );
    });
  }

  it("refuses a private address for an unlisted host, which is what closes rebinding", async () => {
    await withEnv(undefined, async () => {
      const { error } = await lookupOnce("rebind.example");
      expect(error?.message).toMatch(/private address/);
    });
  });

  it("keeps refusing an unlisted host even while another host is listed", async () => {
    await withEnv("192.168.10.117", async () => {
      const { error } = await lookupOnce("rebind.example");
      expect(error?.message).toMatch(/private address/);
    });
  });

  it("lets a listed host resolve to its private address", async () => {
    await withEnv("192.168.10.117", async () => {
      const { error, address } = await lookupOnce("192.168.10.117");
      expect(error).toBeNull();
      expect(address).toBe("192.168.10.117");
    });
  });
});

describe("transport URL policy", () => {
  it("refuses plain HTTP to a LAN host when unset", async () => {
    await withEnv(undefined, async () => {
      const { secureFetch } = await import("./mcp-transport.js");
      const url = new URL("http://192.168.10.117:8181/mcp");
      const fetchImpl = secureFetch(url, {}, {}, { fetch: async () => new Response("ok") });
      await expect(fetchImpl(url)).rejects.toThrow(/HTTPS/);
      await fetchImpl.close();
    });
  });

  it("admits plain HTTP to a listed LAN host", async () => {
    await withEnv("192.168.10.117:8181", async () => {
      const { secureFetch } = await import("./mcp-transport.js");
      const url = new URL("http://192.168.10.117:8181/mcp");
      const fetchImpl = secureFetch(url, {}, {}, { fetch: async () => new Response("ok") });
      await expect(fetchImpl(url).then((r) => r.text())).resolves.toBe("ok");
      await fetchImpl.close();
    });
  });

  it("carries the configured Authorization header to the listed host", async () => {
    await withEnv("192.168.10.117:8181", async () => {
      const { secureFetch } = await import("./mcp-transport.js");
      const url = new URL("http://192.168.10.117:8181/mcp");
      let seen: string | null = null;
      const fetchImpl = secureFetch(
        url,
        {},
        { headers: { Authorization: "Bearer token" } },
        {
          fetch: async (input, init) => {
            seen = new Headers(init?.headers).get("authorization");
            void input;
            return new Response("ok");
          },
        },
      );
      await fetchImpl(url);
      expect(seen).toBe("Bearer token");
      await fetchImpl.close();
    });
  });

  it("still refuses a redirect from a listed host", async () => {
    await withEnv("192.168.10.117:8181", async () => {
      const { secureFetch } = await import("./mcp-transport.js");
      const url = new URL("http://192.168.10.117:8181/mcp");
      const fetchImpl = secureFetch(
        url,
        {},
        {},
        {
          fetch: async () =>
            new Response(null, { status: 302, headers: { location: "http://10.0.0.1/" } }),
        },
      );
      await expect(fetchImpl(url)).rejects.toThrow(/redirect/i);
      await fetchImpl.close();
    });
  });
});
