/**
 * credentials.ts — provider API-key resolution from the environment.
 *
 * The server is the credential authority.  Provider keys live in
 * packages/server/.env and are handed to agents at bootstrap.
 *
 * Never log the returned key.
 */

const PROVIDER_ENV_MAP: Record<string, string> = {
  fireworks: "FIREWORKS_API_KEY",
  anthropic: "ANTHROPIC_API_KEY",
  openai: "OPENAI_API_KEY",
  openrouter: "OPENROUTER_API_KEY",
  google: "GEMINI_API_KEY",
  groq: "GROQ_API_KEY",
  xai: "XAI_API_KEY",
  deepseek: "DEEPSEEK_API_KEY",
  together: "TOGETHER_API_KEY",
  mistral: "MISTRAL_API_KEY",
};

/** Returns the API key for a provider, or undefined if not configured. */
export function getProviderKey(provider: string): string | undefined {
  const envVar = PROVIDER_ENV_MAP[provider.toLowerCase()];
  if (!envVar) return undefined;
  return process.env[envVar];
}

/** List of provider names that have a key configured in the environment. */
export function availableProviders(): string[] {
  return Object.keys(PROVIDER_ENV_MAP).filter((p) => process.env[PROVIDER_ENV_MAP[p]]);
}
