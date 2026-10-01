/**
 * lib/models/schemaNormalize.ts — JSON-Schema dialect bridge.
 *
 * WHY this file exists:
 *   The ADK is Gemini-native, and Gemini's Schema type spells JSON-Schema
 *   types in UPPERCASE ('OBJECT', 'STRING', …). Every other provider this
 *   framework routes to (Anthropic, OpenAI, xAI, Ollama's OpenAI-compatible
 *   endpoint) requires standard lowercase JSON-Schema types and rejects the
 *   Gemini spelling — Anthropic, for example, with:
 *     400 invalid_request_error: tools.N.custom.input_schema.type:
 *         Input should be 'object'
 *   Tools are declared once (YAML / MCP discovery) in the Gemini dialect, so
 *   every non-Gemini adapter runs its tool schemas through this function at
 *   request-build time. See DOCUMENTATION.md §7.1.
 */

/**
 * Deep-clones a Gemini/ADK-style JSON schema, lowercasing every `type` value
 * ('OBJECT' → 'object', ['STRING','NULL'] → ['string','null']) while leaving
 * `description`, `enum`, `required`, `format`, and unknown keywords untouched.
 * Never mutates the input — a Gemini agent may hold the same tool object.
 */
export function toLowercaseJsonSchema(schema: unknown): Record<string, unknown> {
  const result = normalizeNode(schema);
  if (result && typeof result === 'object' && !Array.isArray(result)) {
    return result as Record<string, unknown>;
  }
  return { type: 'object', properties: {} };
}

function normalizeNode(node: unknown): unknown {
  if (Array.isArray(node)) return node.map(normalizeNode);
  if (!node || typeof node !== 'object') return node;

  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(node as Record<string, unknown>)) {
    if (key === 'type') {
      // `type` may be a string or an array of strings (nullable unions).
      if (typeof value === 'string') {
        out[key] = value.toLowerCase();
      } else if (Array.isArray(value)) {
        out[key] = value.map((v) => (typeof v === 'string' ? v.toLowerCase() : v));
      } else {
        out[key] = value;
      }
    } else if (key === 'enum' || key === 'required') {
      // Value lists, not schema nodes — copy verbatim (enum values are data
      // and must keep their original casing).
      out[key] = Array.isArray(value) ? [...value] : value;
    } else {
      out[key] = normalizeNode(value);
    }
  }
  return out;
}

/**
 * The declaration a non-Gemini adapter should send for one ADK tool:
 * name, description, and a lowercase JSON-Schema `parameters`.
 *
 * Read from the tool's own `_getDeclaration()` — the same source ADK's Gemini
 * path uses — and only fall back to a `parameters` property for plain objects
 * (tests, hand-built tools). Reading `.parameters` directly was the bug behind
 * plans/gpt-agenttool-delegation.md: `AgentTool` and ADK's `load_memory` keep
 * their schema ONLY in `_getDeclaration()`, so every Claude / GPT / Grok /
 * Ollama / gateway orchestrator was told its subagents took no arguments and
 * called them with `{}`. A FunctionTool built from a zod object is also
 * converted here (ADK's `toSchema`), where `.parameters` would be the raw zod
 * object. Returns undefined for tools that declare nothing (the server-side
 * search sentinels) and for tools with no name.
 */
export function toolDeclarationFor(tool: unknown): {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
} | undefined {
  if (!tool || typeof tool !== 'object') return undefined;
  const t = tool as Record<string, any>;
  let decl: Record<string, any> | undefined;
  if (typeof t._getDeclaration === 'function') {
    try {
      decl = t._getDeclaration() ?? undefined;
    } catch {
      decl = undefined;
    }
    // A tool that implements _getDeclaration and returns nothing declares
    // nothing (search sentinels): do not resurrect it from other fields.
    if (!decl) return undefined;
  }
  const name = decl?.name ?? t.name;
  if (!name || typeof name !== 'string') return undefined;
  const description = decl?.description ?? t.description ?? '';
  const parameters = decl ? decl.parameters : t.parameters;
  return {
    name,
    description: typeof description === 'string' ? description : '',
    parameters: toLowercaseJsonSchema(parameters ?? { type: 'object', properties: {} }),
  };
}

/**
 * The lowercase schema in the shape OpenAI-style "strict" structured output
 * demands: every object node carries `additionalProperties: false` and lists
 * ALL of its properties as required. Optional fields are expressed by the
 * model emitting a null/empty value, not by omission — that is the strict
 * contract, and it is what makes a judge's rubric fields arrive under the
 * names the harness expects rather than improvised ones.
 */
export function toStrictJsonSchema(schema: unknown): Record<string, unknown> {
  return strictNode(toLowercaseJsonSchema(schema)) as Record<string, unknown>;
}

function strictNode(node: unknown): unknown {
  if (Array.isArray(node)) return node.map(strictNode);
  if (!node || typeof node !== 'object') return node;
  const out: Record<string, unknown> = { ...(node as Record<string, unknown>) };
  const type = out.type;
  const isObject = type === 'object' || (Array.isArray(type) && type.includes('object')) || isPlainObject(out.properties);
  if (isObject && isPlainObject(out.properties)) {
    const props: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(out.properties as Record<string, unknown>)) props[k] = strictNode(v);
    out.properties = props;
    out.required = Object.keys(props);
    out.additionalProperties = false;
  }
  if (out.items !== undefined) out.items = strictNode(out.items);
  return out;
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return !!v && typeof v === 'object' && !Array.isArray(v);
}
