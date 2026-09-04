import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("@earendil-works/pi-agent-core", () => ({
  Agent: class {
    state = { messages: [] };

    subscribe() {}
    async prompt() {}
    async waitForIdle() {}
    abort() {}
  },
}));

vi.mock("@earendil-works/pi-ai/providers/all", () => ({
  builtinModels: () => ({
    getModel: (provider: string, id: string) => ({ provider, id }),
    streamSimple: vi.fn(),
  }),
}));

vi.mock("./pi-local-provider.js", () => ({
  registerLocalProvider: (models: unknown) => models,
  LOCAL_PROVIDER_ID: "local",
  localApiKey: () => "local",
}));

vi.mock("./pi-openai-compatible-provider.js", () => ({
  OPENAI_COMPATIBLE_PROVIDER_ID: "openai-compatible",
  registerOpenAiCompatibleCatalog: (models: unknown) => models,
  registerOpenAiCompatibleRuntime: (models: unknown) => models,
}));

/**
 * The `scripted` placeholder is what every bot with no explicit model override
 * runs as. It used to be rewritten to OpenRouter unconditionally, so a
 * deployment that pins PI_DEFAULT_PROVIDER refused its own default model on the
 * execution path and answered the user with the allowlist message instead.
 */
describe("scripted placeholder on a provider-pinned deployment", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.resetModules();
  });

  async function runScripted() {
    vi.resetModules();
    const { PiAgentRuntime } = await import("./pi-runtime.js");
    const runtime = new PiAgentRuntime();
    const texts: string[] = [];
    for await (const event of runtime.run(
      {
        botId: "bot",
        threadId: "thread",
        runId: "run",
        prompt: "hi",
        instructions: "test",
        history: [],
        tools: [],
        model: { provider: "scripted", id: "scripted" },
      },
      {
        operationId: "operation",
        traceId: "trace",
        spaceId: "workspace",
        userId: "user",
        signal: new AbortController().signal,
      },
    )) {
      if (event.type === "text") texts.push(event.text);
    }
    return texts;
  }

  it("resolves scripted to the deployment provider instead of refusing it", async () => {
    vi.stubEnv("PI_DEFAULT_PROVIDER", "local");
    vi.stubEnv("PI_DEFAULT_MODEL", "gx10-fast");
    vi.stubEnv("RAKAZO_PROVIDER_ALLOWLIST", "local");

    const texts = await runScripted();

    expect(texts.join("\n")).not.toContain("is not enabled on this deployment");
    expect(texts.join("\n")).not.toContain("Unknown model");
  });

  it("still refuses a provider the allowlist genuinely excludes", async () => {
    // Negative control: the refusal path must remain reachable, so the test
    // above is proving resolution and not just a dead allowlist.
    vi.stubEnv("PI_DEFAULT_PROVIDER", "openrouter");
    vi.stubEnv("PI_DEFAULT_MODEL", "deepseek/deepseek-v4-flash-0731");
    vi.stubEnv("RAKAZO_PROVIDER_ALLOWLIST", "local");

    const texts = await runScripted();

    expect(texts.join("\n")).toContain("is not enabled on this deployment");
  });
});
