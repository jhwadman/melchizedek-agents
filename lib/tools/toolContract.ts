/**
 * lib/tools/toolContract.ts — define a tool ONCE, serve it anywhere.
 *
 * WHY this file exists:
 *   A native tool that should be reachable both by our own agents (ADK
 *   FunctionTool, Gemini-dialect Schema) and by outside MCP clients
 *   (standard JSON Schema in tools/list) previously needed its schema
 *   hand-written twice — two dialects of the same contract, guaranteed to
 *   drift. Here a tool is one object — name, description, zod schema,
 *   execute — and thin adapters DERIVE each deployment surface:
 *
 *     defineTool(...) ──► toFunctionTool()       ADK / syndicate agents
 *                    └──► toMcpToolDefinition()  MCP tools/list entry
 *
 *   The zod schema is the single source of truth. zod v4's native
 *   z.toJSONSchema() emits standard JSON Schema (what MCP and every
 *   non-Gemini provider natively want); toGeminiSchema() below derives the
 *   ADK dialect from it — the exact inverse of the request-time bridge in
 *   lib/models/schemaNormalize.ts, which keeps lowercasing FunctionTool
 *   schemas for Anthropic/OpenAI/xAI/Ollama and is unaffected by this file.
 *
 *   DELIBERATELY NOT HERE: exposure. Defining a contract publishes nothing.
 *   An agent sees the tool only when its name is added to TOOL_MAP in
 *   lib/toolRegistry.ts AND declared in the syndicate YAML; an MCP client
 *   sees it only when a server script explicitly lists it (see
 *   scripts/financial_mcp_server.ts). Both remain deliberate acts.
 */

import { FunctionTool } from '@google/adk';
import type { Schema } from '@google/genai';
import { z } from 'zod';

export interface ToolContract<S extends z.ZodType = z.ZodType> {
  name: string;
  /** LLM-facing prompt text, not developer docs — it steers when agents call the tool. */
  description: string;
  /** Single source of truth for the input shape; both wire dialects derive from it. */
  schema: S;
  execute: (input: z.infer<S>) => Promise<string>;
}

/** Identity helper whose only job is inferring the execute() input type from the schema. */
export function defineTool<S extends z.ZodType>(contract: ToolContract<S>): ToolContract<S> {
  return contract;
}

/**
 * Validate args against the contract's schema and run it. Validation failure
 * returns an error STRING (never throws) so the calling model sees what to
 * fix and can retry — the same convention the hand-written tools used for
 * upstream API failures. Unknown keys are stripped by zod's default object
 * behavior.
 */
export async function executeContract(
  contract: ToolContract<any>,
  args: unknown,
): Promise<string> {
  const parsed = contract.schema.safeParse(args ?? {});
  if (!parsed.success) {
    const issues = parsed.error.issues
      .map((i: { path: Array<string | number>; message: string }) =>
        `${i.path.join('.') || '(root)'}: ${i.message}`)
      .join('; ');
    return `Error: invalid arguments for ${contract.name}: ${issues}`;
  }
  return contract.execute(parsed.data);
}

/**
 * Standard JSON Schema for the contract's input — the canonical dialect
 * (MCP inputSchema; also what four of our five providers natively accept).
 * `$schema` is dropped: it's metadata about the document, noise on the wire.
 */
export function toStandardJsonSchema(contract: ToolContract<any>): Record<string, unknown> {
  const { $schema: _drop, ...schema } = z.toJSONSchema(contract.schema) as Record<
    string,
    unknown
  >;
  return schema;
}

/**
 * Standard JSON Schema → Gemini/ADK dialect. The inverse of
 * schemaNormalize.toLowercaseJsonSchema(): every `type` value is UPPERCASED
 * ('object' → 'OBJECT'). Also drops keywords the Gemini API rejects or
 * ignores: `additionalProperties` (zod emits it on every object) and
 * `default` (defaults are applied by zod at parse time, not by the model).
 * `enum` and `required` are value lists, copied verbatim.
 */
export function toGeminiSchema(jsonSchema: unknown): Record<string, unknown> {
  const result = geminiNode(jsonSchema);
  if (result && typeof result === 'object' && !Array.isArray(result)) {
    return result as Record<string, unknown>;
  }
  return { type: 'OBJECT', properties: {} };
}

function geminiNode(node: unknown): unknown {
  if (Array.isArray(node)) return node.map(geminiNode);
  if (!node || typeof node !== 'object') return node;

  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(node as Record<string, unknown>)) {
    if (key === 'additionalProperties' || key === 'default' || key === '$schema') {
      continue;
    } else if (key === 'type') {
      if (typeof value === 'string') {
        out[key] = value.toUpperCase();
      } else if (Array.isArray(value)) {
        out[key] = value.map((v) => (typeof v === 'string' ? v.toUpperCase() : v));
      } else {
        out[key] = value;
      }
    } else if (key === 'enum' || key === 'required') {
      out[key] = Array.isArray(value) ? [...value] : value;
    } else {
      out[key] = geminiNode(value);
    }
  }
  return out;
}

/**
 * ADK surface: a live FunctionTool whose Gemini-dialect parameters are
 * derived from the zod schema and whose execute() zod-validates its input.
 * Non-Gemini providers keep receiving this schema through
 * schemaNormalize.toLowercaseJsonSchema() at request-build time, unchanged.
 */
export function toFunctionTool(contract: ToolContract<any>): FunctionTool {
  return new FunctionTool({
    name: contract.name,
    description: contract.description,
    parameters: toGeminiSchema(toStandardJsonSchema(contract)) as unknown as Schema,
    execute: (input: unknown) => executeContract(contract, input),
  });
}

/**
 * MCP surface: a tools/list entry. Pair with executeContract() in the
 * server's CallTool handler — see scripts/financial_mcp_server.ts.
 */
export function toMcpToolDefinition(contract: ToolContract<any>): {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
} {
  return {
    name: contract.name,
    description: contract.description,
    inputSchema: toStandardJsonSchema(contract),
  };
}
