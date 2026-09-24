AUDIENCE: a coding agent working for a software engineer who is choosing or changing a model for an agent, adding a provider key, or reading a provider error.
KIND: a SKILL.md skill file.
PURPOSE: after reading it the agent can set a `model:` line that routes where intended, name the key it needs, run without any key on Ollama, use the gateway fallback correctly, tune per-agent generation settings, and read the provider errors.

STRUCTURE (exact):
Frontmatter, verbatim:
---
name: melchizedek-models
description: Choose and wire a model for a Melchizedek agent: how a model id routes to Gemini, Claude, GPT, Grok, or local Ollama, which environment variable each needs, the gateway fallback, the doctor, and per-agent generation settings. Use when the user changes a model line, adds a provider key, sees Model not found or a gateway error, or asks which keys a syndicate needs.
---
Then `##` sections in this order: "How a model id routes", "Which key unlocks what", "Run with no key at all", "One key for every cloud provider", "Settings per agent", "Mixing providers in one syndicate", "Reading the errors".

FACTS:
How a model id routes:
- The `model:` string's prefix names the provider: `claude-*` to Anthropic, `gpt-*` and `o<digit>*` to OpenAI, `grok-*` to xAI, `ollama/<model>` to a local Ollama, and everything else to Gemini (the ADK-native default).
- There is no allowlist in the engine: any id a provider currently serves works as written. A new model is a one-line YAML change.
- Ids verified in this deployment: `gemini-3.8-flash` (production), `gemini-3.1-flash-lite` (subagents, cost), `claude-sonnet-4-6`, `claude-opus-4-6`, `claude-haiku-4-5-20251001`, `gpt-5-mini`, `gpt-5`, `grok-4.7`, `ollama/qwen3:8b`.
- `gemini-2.5-flash` returns a 400 about tool call context circulation with the server-side tool flag the framework sets; use `gemini-3.8-flash` or newer.
- Subagents inherit the orchestrator's `model` when they set none.
Which key unlocks what:
- `GOOGLE_GENAI_API_KEY` for Gemini (also the embedding model behind long-term memory); `ANTHROPIC_API_KEY`; `OPENAI_API_KEY`; `XAI_API_KEY`; no key for `ollama/*`.
- A provider registers only when its key is present; a missing key logs the provider as disabled, and an agent on that provider fails with `Model not found`.
- `npx melchizedek-doctor` (clone: `npm run doctor`) reads every syndicate, resolves each agent's model under the current `.env`, and prints per agent: model, provider, which server-side search tools the path keeps or drops, and whether it is funded; per syndicate a verdict; and the variables that would unlock the most. `--json`, `--check` (exit 1 when any syndicate is blocked). Read-only, no key value printed.
- The `# tier:` first line of every starter-pack file states its cost class (`keyless`, one provider name, or `multi-provider`); the doctor checks the claim against the models.
Run with no key at all:
- Install Ollama, `ollama pull qwen3:8b`, and run any syndicate whose agents are all `ollama/*` (`tutor.yaml`, `council.yaml`): `npx melchizedek-chat --syndicate tutor`. Ollama's OpenAI-compatible endpoint at `http://localhost:11434/v1` serves them; nothing leaves the machine.
- `qwen3:8b` is the smallest pulled model with tool calling.
One key for every cloud provider (the gateway fallback):
- `MODEL_GATEWAY=vercel` or `MODEL_GATEWAY=openrouter` with `MODEL_GATEWAY_API_KEY` serves any cloud model id whose direct key is absent through that gateway's OpenAI-compatible endpoint.
- It is a fallback only: a present provider key always wins for its own provider; `ollama/*` never routes through a gateway; a caller's `X-API-Key` on the A2A server never selects it.
- Native server-side search (`web_search`, `google_search`, `x_search`, `collections_search`) is lost on the gateway path; the doctor says so per agent.
- Dials: `MODEL_GATEWAY_MODEL_MAP=<your id>=<the gateway's id>` renames an id the gateway rejects; `MODEL_GATEWAY_BASE_URL` points at a self-hosted proxy.
- Telemetry attributes the call to the upstream provider and records the transport separately.
Settings per agent:
- `generateContentConfig:` on any agent: `temperature` (where the provider still exposes it), `maxOutputTokens`, `thinkingConfig: { thinkingLevel: MEDIUM, includeThoughts: false }` on Gemini models that think. Thinking tokens count against `maxOutputTokens`.
- The framework's own pattern: data-gathering subagents on a lite model with a tight output cap; synthesis on the stronger model with a thinking level and room to reason.
Mixing providers in one syndicate:
- Any agent in a graph can run on a different provider; `model_zoo.yaml` declares one lightweight agent per provider, and in a clone `npm run demo:models` sends one prompt through each.
- In code, `registerAvailableProviders()` from `melchizedek-agents` registers every provider whose key is present so a plain ADK `LlmAgent` can take any of these ids; in a clone `npm run demo:direct -- --model ollama/qwen3:8b hello` runs one agent with no YAML.
Reading the errors:
- `Model not found` for a `claude-*`, `gpt-*` or `grok-*` id: the provider's key is unset. Set it, or set the gateway pair.
- `GATEWAY_HTTP_ERROR ... 404/400`: the gateway rejected the mapped id; fix the name with `MODEL_GATEWAY_MODEL_MAP`.
- `GATEWAY_KEY_MISSING`: `MODEL_GATEWAY` is set without `MODEL_GATEWAY_API_KEY`.
- `OLLAMA_UNREACHABLE`: Ollama is not running (`ollama serve`) or the model is not pulled (`ollama list`).

IDENTIFIERS (verbatim): model:, claude-*, gpt-*, grok-*, ollama/, gemini-3.8-flash, gemini-3.1-flash-lite, gemini-2.5-flash, ollama/qwen3:8b, GOOGLE_GENAI_API_KEY, ANTHROPIC_API_KEY, OPENAI_API_KEY, XAI_API_KEY, npx melchizedek-doctor, --json, --check, # tier:, ollama pull qwen3:8b, http://localhost:11434/v1, MODEL_GATEWAY, MODEL_GATEWAY_API_KEY, MODEL_GATEWAY_MODEL_MAP, MODEL_GATEWAY_BASE_URL, X-API-Key, generateContentConfig:, maxOutputTokens, thinkingConfig, model_zoo.yaml, npm run demo:models, registerAvailableProviders, GATEWAY_HTTP_ERROR, GATEWAY_KEY_MISSING, OLLAMA_UNREACHABLE, Model not found
LIMITS: the routing prefixes may be a short table. Body under 160 lines.
