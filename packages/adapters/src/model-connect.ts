import type { ModelConnectInput, ModelCredential } from "@rakazo/contracts";
import { OPENAI_COMPATIBLE_PROVIDER_ID as CONTRACT_OPENAI_COMPAT } from "@rakazo/contracts";
import { parseModelSecret, type StoredModelSecret, serializeModelSecret } from "./pi-oauth.js";
import { LOCAL_PROVIDER_ID, localApiKey } from "./pi-local-provider.js";
import {
  OPENAI_COMPATIBLE_PROVIDER_ID,
  prepareOpenAiCompatibleConnect,
} from "./pi-openai-compatible-provider.js";

export function buildModelConnectPlaintext(input: ModelConnectInput): string {
  if (input.provider === OPENAI_COMPATIBLE_PROVIDER_ID) {
    const prepared = prepareOpenAiCompatibleConnect(input);
    const secret: StoredModelSecret = {
      kind: "openai_compatible",
      baseUrl: prepared.baseUrl,
      ...(prepared.apiKey ? { apiKey: prepared.apiKey } : {}),
    };
    return serializeModelSecret(secret);
  }
  const apiKey = input.apiKey?.trim();
  // The local provider's token comes from RAKAZO_LOCAL_MODELS_API_KEY, so once
  // the deployment has set one there is nothing for the operator to paste.
  // Demanding it anyway blocks the connect dialog on every model switch, and
  // the field cannot prefill because the server never sends a secret back.
  if (input.provider === LOCAL_PROVIDER_ID && !apiKey) {
    const configured = localApiKey();
    if (configured !== "local") return configured;
  }
  if (!apiKey || apiKey.length < 8) {
    throw new Error("API key must contain at least 8 characters");
  }
  return apiKey;
}

export function modelCredentialDto(
  row: {
    id: string;
    provider: string;
    label: string;
    isDefault: boolean;
    defaultModel?: string | null;
  },
  plaintext?: string,
): ModelCredential {
  const credential: ModelCredential = {
    id: row.id,
    provider: row.provider,
    label: row.label,
    hasKey: true,
    isDefault: row.isDefault,
    ...(row.defaultModel ? { modelId: row.defaultModel } : {}),
  };
  if (row.provider !== CONTRACT_OPENAI_COMPAT || !plaintext) return credential;
  const parsed = parseModelSecret(plaintext);
  if (parsed.kind !== "openai_compatible") return credential;
  return {
    ...credential,
    baseUrl: parsed.baseUrl,
    modelId: row.defaultModel ?? undefined,
  };
}
