import { afterEach, describe, expect, it, vi } from "vitest";

const KEY_ENV = "RAKAZO_LOCAL_MODELS_API_KEY";
const MODELS_ENV = "RAKAZO_LOCAL_MODELS";

async function withEnv<T>(env: Record<string, string | undefined>, fn: () => Promise<T>) {
  const previous = new Map(Object.keys(env).map((k) => [k, process.env[k]]));
  for (const [k, v] of Object.entries(env)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  vi.resetModules();
  try {
    return await fn();
  } finally {
    for (const [k, v] of previous) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    vi.resetModules();
  }
}

afterEach(() => vi.resetModules());

describe("local provider auth", () => {
  it("still sends the keyless placeholder by default", async () => {
    await withEnv({ [MODELS_ENV]: "gx10-fast", [KEY_ENV]: undefined }, async () => {
      const { registerLocalProvider, LOCAL_PROVIDER_ID } = await import("./pi-local-provider.js");
      const { builtinModels } = await import("@earendil-works/pi-ai/providers/all");
      const auth = await registerLocalProvider(builtinModels()).getAuth(LOCAL_PROVIDER_ID);
      expect(auth?.auth.apiKey).toBe("local");
    });
  });

  it("sends the configured token to a gateway that requires one", async () => {
    await withEnv({ [MODELS_ENV]: "gx10-fast", [KEY_ENV]: "sk-test-abc123" }, async () => {
      const { registerLocalProvider, LOCAL_PROVIDER_ID } = await import("./pi-local-provider.js");
      const { builtinModels } = await import("@earendil-works/pi-ai/providers/all");
      const auth = await registerLocalProvider(builtinModels()).getAuth(LOCAL_PROVIDER_ID);
      expect(auth?.auth.apiKey).toBe("sk-test-abc123");
    });
  });

  it("trims surrounding whitespace from the token", async () => {
    await withEnv({ [MODELS_ENV]: "gx10-fast", [KEY_ENV]: "  sk-padded  " }, async () => {
      const { registerLocalProvider, LOCAL_PROVIDER_ID } = await import("./pi-local-provider.js");
      const { builtinModels } = await import("@earendil-works/pi-ai/providers/all");
      const auth = await registerLocalProvider(builtinModels()).getAuth(LOCAL_PROVIDER_ID);
      expect(auth?.auth.apiKey).toBe("sk-padded");
    });
  });

  it("falls back to the placeholder when the value is blank", async () => {
    await withEnv({ [MODELS_ENV]: "gx10-fast", [KEY_ENV]: "   " }, async () => {
      const { registerLocalProvider, LOCAL_PROVIDER_ID } = await import("./pi-local-provider.js");
      const { builtinModels } = await import("@earendil-works/pi-ai/providers/all");
      const auth = await registerLocalProvider(builtinModels()).getAuth(LOCAL_PROVIDER_ID);
      expect(auth?.auth.apiKey).toBe("local");
    });
  });
});
