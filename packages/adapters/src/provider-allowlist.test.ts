import { describe, expect, it, vi, afterEach } from "vitest";

const ENV = "RAKAZO_PROVIDER_ALLOWLIST";

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

describe("provider allowlist", () => {
  it("offers the full catalog when unset (upstream default)", async () => {
    await withEnv(undefined, async () => {
      const { listPiCatalog } = await import("./pi-models.js");
      const providers = new Set(listPiCatalog().map((e) => e.provider));
      expect(providers.has("openrouter")).toBe(true);
      expect(providers.size).toBeGreaterThan(2);
    });
  });

  it("hides every provider outside the allowlist", async () => {
    await withEnv("openai-compatible", async () => {
      const { listPiCatalog } = await import("./pi-models.js");
      const providers = [...new Set(listPiCatalog().map((e) => e.provider))];
      expect(providers).toEqual(["openai-compatible"]);
    });
  });

  it("keeps openrouter out even when PI_DEFAULT_* names it", async () => {
    const prevP = process.env.PI_DEFAULT_PROVIDER;
    const prevM = process.env.PI_DEFAULT_MODEL;
    process.env.PI_DEFAULT_PROVIDER = "openrouter";
    process.env.PI_DEFAULT_MODEL = "some/unlisted-model";
    try {
      await withEnv("openai-compatible", async () => {
        const { listPiCatalog } = await import("./pi-models.js");
        expect(listPiCatalog().some((e) => e.provider === "openrouter")).toBe(false);
      });
    } finally {
      if (prevP === undefined) delete process.env.PI_DEFAULT_PROVIDER;
      else process.env.PI_DEFAULT_PROVIDER = prevP;
      if (prevM === undefined) delete process.env.PI_DEFAULT_MODEL;
      else process.env.PI_DEFAULT_MODEL = prevM;
    }
  });

  it("gates the execution path, not just the picker", async () => {
    await withEnv("openai-compatible", async () => {
      const { isProviderAllowed } = await import("./pi-models.js");
      expect(isProviderAllowed("openai-compatible")).toBe(true);
      expect(isProviderAllowed("openrouter")).toBe(false);
      expect(isProviderAllowed("anthropic")).toBe(false);
    });
  });

  it("tolerates whitespace and empty entries", async () => {
    await withEnv(" openai-compatible , , local ", async () => {
      const { isProviderAllowed } = await import("./pi-models.js");
      expect(isProviderAllowed("openai-compatible")).toBe(true);
      expect(isProviderAllowed("local")).toBe(true);
      expect(isProviderAllowed("openrouter")).toBe(false);
    });
  });
});
