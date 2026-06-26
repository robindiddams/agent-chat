/**
 * bootstrap.ts — Credential exchange + model resolution for the agent.
 *
 * The agent calls `bootstrap()` to exchange its (reusable) bootstrap token for
 * a credential bundle from the server. The bundle contains the system prompt,
 * provider, model id, provider API key, and a long-lived access token for WS
 * authentication. The bootstrap token is not one-time — it can be reused on
 * restart/reconnect.
 *
 * `resolveModel()` turns a (provider, modelId) pair into a pi-ai `Model`,
 * preferring pi-ai's built-in `getModel` catalog and falling back to a
 * hand-built `Model` for OpenAI-compatible providers not in the catalog.
 */

import { getModel } from "@earendil-works/pi-ai";
import type { Model } from "@earendil-works/pi-ai";

// ── Types ─────────────────────────────────────────────

export interface BootstrapBundle {
  name: string;
  systemPrompt: string;
  provider: string;
  model: string;
  apiKey: string;
  accessToken: string;
  wsUrl: string;
  baseUrl?: string; // future gateway override
}

// ── Provider → baseUrl map (OpenAI-compatible endpoints) ──

const PROVIDER_BASE_URLS: Record<string, string> = {
  fireworks: "https://api.fireworks.ai/inference/v1",
  openai: "https://api.openai.com/v1",
  openrouter: "https://openrouter.ai/api/v1",
  groq: "https://api.groq.com/openai/v1",
  together: "https://api.together.xyz/v1",
  deepseek: "https://api.deepseek.com/v1",
  mistral: "https://api.mistral.ai/v1",
  xai: "https://api.x.ai/v1",
};

// Providers whose API is NOT openai-completions and need getModel to handle them.
// If getModel can't resolve them either, we throw a clear error.
const NON_OPENAI_PROVIDERS = new Set(["anthropic", "google"]);

// ── bootstrap() ───────────────────────────────────────

/**
 * Exchange a one-time bootstrap token for a credential bundle.
 *
 * Never logs the token or the returned API key.
 */
export async function bootstrap(
  serverBaseUrl: string,
  token: string
): Promise<BootstrapBundle> {
  const url = `${serverBaseUrl}/api/agents/bootstrap`;

  let res: Response;
  try {
    res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ token }),
    });
  } catch (err) {
    throw new Error(
      `Bootstrap request failed: cannot reach ${serverBaseUrl}. ${(err as Error).message}`
    );
  }

  if (!res.ok) {
    let detail = "";
    try {
      const body = await res.json();
      detail = body.error || body.code || "";
    } catch {
      detail = await res.text().catch(() => "");
    }
    const status = res.status;
    if (status === 401) {
      throw new Error(`Bootstrap rejected (401): token is invalid or the agent has been deleted.${detail ? ` ${detail}` : ""}`);
    }
    if (status === 503) {
      throw new Error(`Bootstrap failed (503): server has no API key for the agent's provider.${detail ? ` ${detail}` : ""}`);
    }
    throw new Error(`Bootstrap failed (HTTP ${status}).${detail ? ` ${detail}` : ""}`);
  }

  const bundle = await res.json() as BootstrapBundle;

  // Minimal validation
  if (!bundle.name || !bundle.systemPrompt || !bundle.provider || !bundle.model || !bundle.apiKey || !bundle.accessToken || !bundle.wsUrl) {
    throw new Error("Bootstrap response is missing required fields.");
  }

  return bundle;
}

// ── resolveModel() ────────────────────────────────────

/**
 * Resolve a (provider, modelId) pair into a pi-ai `Model`.
 *
 * 1. Try `getModel(provider, modelId)` — uses pi-ai's built-in catalog
 *    (correct api, cost, context window, etc.).
 * 2. If that throws and the provider is OpenAI-compatible, hand-build a
 *    minimal `Model` with the provider's baseUrl.
 * 3. If the provider is anthropic/google and getModel fails, throw — those
 *    need provider-specific api implementations we can't fake.
 *
 * If `overrideBaseUrl` is provided (future gateway), it replaces the model's
 * baseUrl after resolution.
 */
export function resolveModel(
  provider: string,
  modelId: string,
  overrideBaseUrl?: string
): Model<any> {
  // Try the catalog first
  try {
    const model = getModel(provider as any, modelId as any);
    if (model) {
      if (overrideBaseUrl) {
        return { ...model, baseUrl: overrideBaseUrl };
      }
      return model;
    }
    // getModel returned undefined — fall through to hand-built
  } catch {
    // getModel threw — fall through to hand-built
  }

  // Can't hand-build for non-OpenAI-compatible providers
  if (NON_OPENAI_PROVIDERS.has(provider)) {
    throw new Error(
      `Cannot resolve model "${modelId}" for provider "${provider}". ` +
      `This provider is not in pi-ai's model catalog and requires a ` +
      `provider-specific API implementation. Add the model to pi-ai or ` +
      `use a compatible provider.`
    );
  }

  const baseUrl = overrideBaseUrl || PROVIDER_BASE_URLS[provider];
  if (!baseUrl) {
    throw new Error(
      `Cannot resolve model "${modelId}" for provider "${provider}". ` +
      `Not in pi-ai catalog and no baseUrl known for this provider.`
    );
  }

  // Hand-build a minimal OpenAI-compatible model
  return {
    id: modelId,
    name: modelId,
    api: "openai-completions",
    provider: provider as any,
    baseUrl,
    reasoning: false,
    input: ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 128_000,
    maxTokens: 8_192,
  };
}
