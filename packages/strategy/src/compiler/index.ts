import { AnthropicCompiler } from "./anthropic.js";
import { GoogleCompiler } from "./google.js";
import { OpenAICompiler } from "./openai.js";
import type { Compiler } from "./shared.js";

export { AnthropicCompiler } from "./anthropic.js";
export { GoogleCompiler } from "./google.js";
export { OpenAICompiler } from "./openai.js";
export {
  ClarificationRequired,
  type Compiler,
  type Proposal,
} from "./shared.js";

export const PROVIDERS = ["anthropic", "openai", "google"] as const;
export type Provider = (typeof PROVIDERS)[number];

/** Sensible defaults so an operator supplies a key and nothing else. */
export const DEFAULT_MODELS: Record<Provider, string> = {
  anthropic: "claude-sonnet-5",
  openai: "gpt-5",
  google: "gemini-2.5-pro",
};

export type CompilerSettings = {
  /** Force a provider. Without it, whichever key is present wins, in PROVIDERS order. */
  provider?: Provider | undefined;
  anthropicKey?: string | undefined;
  anthropicModel?: string | undefined;
  openaiKey?: string | undefined;
  openaiModel?: string | undefined;
  /**
   * Any OpenAI-compatible host: Groq, Together, OpenRouter, DeepSeek, Fireworks, a local Ollama.
   * The chat-completions shape is the same, so a base URL is the whole of the integration.
   */
  openaiBaseUrl?: string | undefined;
  googleKey?: string | undefined;
  googleModel?: string | undefined;
  googleBaseUrl?: string | undefined;
};

/**
 * The configured strategy compiler, or `undefined` when no key is set.
 *
 * Undefined rather than a throw: text authoring is an optional feature, and a deployment without
 * a key still authors strategies through the structured builder. The draft route already answers
 * 503 with an explanation when a prompt arrives and this returned nothing.
 *
 * Selection is by whichever key is present so that adding one to the environment is the entire
 * act of turning the feature on. `provider` overrides that for the case where several keys are
 * configured and the operator wants a specific one — and if they name a provider whose key is
 * missing, that is a misconfiguration worth failing on rather than silently using a different
 * vendor than the one they asked for.
 */
export function createCompiler(settings: CompilerSettings): Compiler | undefined {
  const keys: Record<Provider, string | undefined> = {
    anthropic: settings.anthropicKey,
    openai: settings.openaiKey,
    google: settings.googleKey,
  };
  const chosen = settings.provider ?? PROVIDERS.find((name) => keys[name]);
  if (!chosen) return undefined;
  const key = keys[chosen];
  if (!key)
    throw new Error(
      `AI_PROVIDER is "${chosen}" but no key is configured for it. Set the matching API key or unset AI_PROVIDER.`,
    );

  switch (chosen) {
    case "anthropic":
      return new AnthropicCompiler(key, settings.anthropicModel ?? DEFAULT_MODELS.anthropic);
    case "openai":
      return new OpenAICompiler(key, settings.openaiModel ?? DEFAULT_MODELS.openai, {
        baseUrl: settings.openaiBaseUrl,
      });
    case "google":
      return new GoogleCompiler(key, settings.googleModel ?? DEFAULT_MODELS.google, {
        baseUrl: settings.googleBaseUrl,
      });
  }
}
