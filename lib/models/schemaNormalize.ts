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
