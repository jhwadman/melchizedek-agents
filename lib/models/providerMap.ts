/**
 * lib/models/providerMap.ts — the single source of truth mapping a model id
 * (as declared in an agent YAML) to its provider.
 *
 * WHY a leaf module:
 *   Both the LLM registry (lib/models/registry.ts) and the web-search
 *   abstraction (lib/tools/webSearchTool.ts) need this mapping; keeping it
 *   dependency-free avoids an import cycle between adapters and tools.
 *
 * Model-name conventions (see DOCUMENTATION.md §7):
 *   claude-*   → anthropic     gpt-* / o<digit>* → openai
 *   grok-*     → xai           ollama/<model>    → ollama (local, keyless)
 *   everything else            → gemini (the ADK-native default)
 */

export type ProviderId = 'gemini' | 'anthropic' | 'openai' | 'xai' | 'ollama';

interface ProviderInfo {
  /** Env var holding the API key; null = keyless (local). */
  keyEnv: string | null;
  /** Human-readable label for logs and demo banners. */
  label: string;
}

export const PROVIDERS: Record<ProviderId, ProviderInfo> = {
  gemini: { keyEnv: 'GOOGLE_GENAI_API_KEY', label: 'Google Gemini' },
  anthropic: { keyEnv: 'ANTHROPIC_API_KEY', label: 'Anthropic Claude' },
  openai: { keyEnv: 'OPENAI_API_KEY', label: 'OpenAI GPT' },
  xai: { keyEnv: 'XAI_API_KEY', label: 'xAI Grok' },
  ollama: { keyEnv: null, label: 'Ollama (local)' },
};

/** Maps a model id to its provider. Unknown ids default to gemini — the
 *  ADK-native provider — matching the LLMRegistry's fallback behavior. */
export function providerForModel(model: string): ProviderId {
  if (/^ollama\//.test(model)) return 'ollama';
  if (/^claude-/.test(model)) return 'anthropic';
  if (/^gpt-/.test(model) || /^o[0-9]/.test(model)) return 'openai';
  if (/^grok-/.test(model)) return 'xai';
  return 'gemini';
}

/** True when the provider's key is present (always true for local Ollama). */
export function providerKeyPresent(provider: ProviderId): boolean {
  const keyEnv = PROVIDERS[provider].keyEnv;
  if (!keyEnv) return true;
  // Gemini historically accepts either env name.
  if (provider === 'gemini') {
    return !!(process.env.GOOGLE_GENAI_API_KEY || process.env.GEMINI_API_KEY);
  }
  return !!process.env[keyEnv];
}
