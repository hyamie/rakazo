import { afterEach, describe, expect, it, vi } from "vitest";

const KEY_ENV = "RAKAZO_LOCAL_MODELS_API_KEY";

async function withKey<T>(value: string | undefined, fn: () => Promise<T>) {
  const previous = process.env[KEY_ENV];
  if (value === undefined) delete process.env[KEY_ENV];
  else process.env[KEY_ENV] = value;
  vi.resetModules();
  try {
    return await fn();
  } finally {
    if (previous === undefined) delete process.env[KEY_ENV];
    else process.env[KEY_ENV] = previous;
    vi.resetModules();
  }
}

afterEach(() => vi.resetModules());

describe("connecting the local provider without pasting a key", () => {
  it("uses the configured gateway token when the operator leaves the field empty", async () => {
    await withKey("sk-gateway-token-value", async () => {
      const { buildModelConnectPlaintext } = await import("./model-connect.js");
      expect(buildModelConnectPlaintext({ provider: "local", modelId: "gx10-fast" })).toBe(
        "sk-gateway-token-value",
      );
    });
  });

  it("still prefers a key the operator did paste", async () => {
    await withKey("sk-gateway-token-value", async () => {
      const { buildModelConnectPlaintext } = await import("./model-connect.js");
      expect(
        buildModelConnectPlaintext({ provider: "local", apiKey: "sk-pasted-override" }),
      ).toBe("sk-pasted-override");
    });
  });

  it("still refuses an empty key when no gateway token is configured", async () => {
    await withKey(undefined, async () => {
      const { buildModelConnectPlaintext } = await import("./model-connect.js");
      expect(() => buildModelConnectPlaintext({ provider: "local" })).toThrow(
        /at least 8 characters/,
      );
    });
  });

  it("does not loosen the requirement for hosted providers", async () => {
    await withKey("sk-gateway-token-value", async () => {
      const { buildModelConnectPlaintext } = await import("./model-connect.js");
      expect(() => buildModelConnectPlaintext({ provider: "openrouter", apiKey: "short" })).toThrow(
        /at least 8 characters/,
      );
      expect(() => buildModelConnectPlaintext({ provider: "anthropic" })).toThrow(
        /at least 8 characters/,
      );
    });
  });
});
