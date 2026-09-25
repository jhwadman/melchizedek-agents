import { FunctionTool } from '@google/adk';
import type { Schema } from '@google/genai';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { SSEClientTransport } from '@modelcontextprotocol/sdk/client/sse.js';

// Security (SSRF): mcp_server_url can arrive from a registry-stored syndicate
// config. Restrict the schemes we'll dial and block private/loopback/link-local
// hosts so a malicious config can't reach internal services or the cloud
// metadata endpoint. Set ALLOW_PRIVATE_MCP=true to permit private hosts in
// local development (where MCP servers commonly run on localhost).
function assertSafeMcpUrl(raw: string): URL {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Error(`Invalid MCP server URL: ${raw}`);
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new Error(`Unsupported MCP URL scheme: ${url.protocol}`);
  }
  if (process.env.ALLOW_PRIVATE_MCP === 'true') return url;

  const host = url.hostname.toLowerCase().replace(/^\[|\]$/g, '');
  const isPrivate =
    host === 'localhost' ||
    host === '0.0.0.0' ||
    host === '::1' ||
    host.endsWith('.localhost') ||
    host.endsWith('.internal') ||
    /^127\./.test(host) ||
    /^10\./.test(host) ||
    /^192\.168\./.test(host) ||
    /^169\.254\./.test(host) ||        // link-local incl. 169.254.169.254 metadata
    /^172\.(1[6-9]|2\d|3[01])\./.test(host) ||
    /^fc/.test(host) || /^fd/.test(host) || /^fe80:/.test(host); // IPv6 ULA/link-local
  if (isPrivate) {
    throw new Error(`Refusing to connect to private/loopback MCP host: ${host} (set ALLOW_PRIVATE_MCP=true for local dev)`);
  }
  return url;
}

// Credentials for MCP servers that require one. MCP_BEARER_TOKENS is a JSON
// object of hostname → token. A token goes only to the exact host it names and
// only over https, so a registry-stored mcp_server_url pointing anywhere else
// never receives it. A malformed value degrades to an unauthenticated connect,
// which such a server refuses — the same empty tool list as an unreachable one.
export function mcpAuthHeaders(url: URL, env: NodeJS.ProcessEnv = process.env): Record<string, string> {
  const raw = env.MCP_BEARER_TOKENS;
  if (!raw || url.protocol !== 'https:') return {};
  let tokens: unknown;
  try {
    tokens = JSON.parse(raw);
  } catch {
    console.warn('[MCP] MCP_BEARER_TOKENS is not a JSON object; connecting without credentials');
    return {};
  }
  if (!tokens || typeof tokens !== 'object' || Array.isArray(tokens)) return {};
  const host = url.hostname.toLowerCase();
  if (!Object.hasOwn(tokens, host)) return {};
  const token = (tokens as Record<string, unknown>)[host];
  return typeof token === 'string' && token ? { Authorization: `Bearer ${token}` } : {};
}

export async function createMcpTools(mcpServerUrl: string): Promise<FunctionTool[]> {
  try {
    const url = assertSafeMcpUrl(mcpServerUrl);
    const transport = new SSEClientTransport(url, {
      requestInit: { headers: mcpAuthHeaders(url) }
    });
    const client = new Client({
      name: 'melchizedek-a2a-client',
      version: '1.0.0'
    }, {
      capabilities: {}
    });

    await client.connect(transport);
    
    // Fetch available tools from the MCP server
    const toolsResponse = await client.listTools();
    
    // MCP servers describe tools in standard lowercase JSON Schema; the ADK
    // is Gemini-native and expects UPPERCASE type names. Uppercase deeply,
    // preserving enum/description/required and nested properties/items —
    // non-Gemini adapters normalize back to lowercase at request-build time
    // via lib/models/schemaNormalize.ts.
    const toGeminiSchema = (node: any): any => {
      if (Array.isArray(node)) return node.map(toGeminiSchema);
      if (!node || typeof node !== 'object') return node;
      const out: Record<string, any> = {};
      for (const [key, value] of Object.entries(node)) {
        if (key === 'type') {
          out[key] = typeof value === 'string' ? value.toUpperCase() : value;
        } else if (key === 'enum' || key === 'required') {
          out[key] = value; // value lists, not schema nodes
        } else {
          out[key] = toGeminiSchema(value);
        }
      }
      return out;
    };

    return toolsResponse.tools.map(tool => {
      const properties: Record<string, any> = {};
      const required: string[] = tool.inputSchema?.required || [];

      if (tool.inputSchema?.properties) {
        for (const [key, prop] of Object.entries<any>(tool.inputSchema.properties)) {
          properties[key] = toGeminiSchema({
            ...prop,
            type: prop.type ?? 'string',
            description: prop.description || ''
          });
        }
      }

      return new FunctionTool({
        name: tool.name,
        description: tool.description || `MCP Tool: ${tool.name}`,
        parameters: {
          type: 'OBJECT',
          properties,
          required
        } as unknown as Schema,
        execute: async (input: unknown): Promise<string> => {
          try {
            const result = await client.callTool({
              name: tool.name,
              arguments: input as Record<string, unknown>
            });
            // MCP callTool returns { content: [{ type: 'text', text: '...' }] }
            interface McpCallToolResult {
              content: Array<{
                type: string;
                text?: string;
                [key: string]: unknown;
              }>;
            }
            const content = (result as McpCallToolResult).content;
            const texts = content.filter(c => c.type === 'text').map(c => c.text ?? '');
            return texts.join('\n');
          } catch (error: any) {
            return `[MCP ERROR] Tool ${tool.name} failed: ${error.message}`;
          }
        }
      });
    });
  } catch (error) {
    console.warn(`[MCP] Failed to connect or load tools from ${mcpServerUrl}`, error);
    return [];
  }
}
