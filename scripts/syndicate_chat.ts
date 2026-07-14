import { createInterface } from 'node:readline';
import { writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { loadSyndicate, parseCliBindings } from '../lib/loadSyndicate.ts';
import type { SyndicateYamlConfig } from '../lib/loadSyndicate.ts';
import { traceAgentRun } from '../lib/observability/tracer.ts';

// ADK Imports
import {
	LlmAgent,
	Runner,
	InMemorySessionService,
	getFunctionCalls,
	getFunctionResponses,
	AgentTool,
	setLogLevel,
	LogLevel
} from '@google/adk';
import { randomUUID } from 'node:crypto';

// Tool resolution (shared registry) + MCP factory
import { resolveTools as resolveNamedTools } from '../lib/toolRegistry.ts';
import { createMcpTools } from '../lib/tools/mcpToolFactory.ts';
import { loadEnv } from '../lib/loadEnv.ts';

// ── LLM Provider Registration ─────────────────────────────────────────────────
// WHY: Import only — registration is deferred to main() so it runs AFTER
// loadEnv() has populated process.env from .env. If registered here at module
// load time, ANTHROPIC_API_KEY would always be undefined and ClaudeLlm would
// never be added to the LLMRegistry, causing "Model not found" errors.
import { registerClaudeLlm } from '../lib/models/claudeLlm.ts';
import { registerOllamaLlm } from '../lib/models/ollamaLlm.ts';

// ── Persistence Factory ───────────────────────────────────────────────────────
// WHY: All Firebase-specific initialization is encapsulated in firebaseProvider.
// To swap the session/memory backend (e.g. Postgres, SQLite), replace this
// import with a sibling provider module that exports the same interface.
import {
	hasSupabaseCredentials,
	createSupabaseServices,
} from '../lib/persistence/supabaseProvider.ts';

// Silence ADK verbose INFO logging natively
setLogLevel(LogLevel.WARN);

const c = {
	reset: '\x1b[0m',
	bold: '\x1b[1m',
	dim: '\x1b[2m',
	cyan: '\x1b[36m',
	green: '\x1b[32m',
	yellow: '\x1b[33m',
	magenta: '\x1b[35m',
	red: '\x1b[31m',
};

// ── Persistence Mode Detection ────────────────────────────────────────────
// WHY: We detect which cloud credentials are present in the environment and
// selectively enable Firebase session persistence and/or Firestore memory.
// This lets the same CLI script work in three modes:
//   1. Full cloud — Firebase sessions + Firestore Vector memory (production)
//   2. Session only — Firebase sessions, no long-term memory
//   3. Local only — InMemorySessionService (development, no credentials)
// The user sees which mode is active in the startup banner.

interface PersistenceConfig {
	sessionService: 'supabase' | 'in-memory';
	memoryService: 'supabase-vector' | 'none';
}

function detectPersistenceConfig(memorySystem?: 'internal-only' | 'session-only' | 'long-term'): PersistenceConfig {
	// WHY: Credential detection is delegated to the persistence factory so that
	// the same logic governs both detection here and initialization below.
	const supabaseAvailable = hasSupabaseCredentials();
	const hasGeminiKey = !!(process.env.GOOGLE_GENAI_API_KEY || process.env.GEMINI_API_KEY);

	if (!memorySystem) {
		return {
			sessionService: supabaseAvailable ? 'supabase' : 'in-memory',
			memoryService: supabaseAvailable && hasGeminiKey ? 'supabase-vector' : 'none',
		};
	}

	let sessionService: 'supabase' | 'in-memory' = 'in-memory';
	let memoryService: 'supabase-vector' | 'none' = 'none';

	if (memorySystem === 'session-only' || memorySystem === 'long-term') {
		sessionService = supabaseAvailable ? 'supabase' : 'in-memory';
		if (!supabaseAvailable) console.warn(`\n${c.yellow}⚠ Requested ${memorySystem} memory system but missing Supabase credentials. Falling back to in-memory sessions.${c.reset}`);
	}

	if (memorySystem === 'long-term') {
		memoryService = supabaseAvailable && hasGeminiKey ? 'supabase-vector' : 'none';

		if (!hasGeminiKey) console.warn(`\n${c.yellow}⚠ Requested long-term memory system but missing Gemini API Key. Falling back to no long-term memory.${c.reset}`);
	}

	return { sessionService, memoryService };
}


function banner(
	config: SyndicateYamlConfig,
	persistence: PersistenceConfig,
	bindings: Record<string, unknown> = {},
	sessionId?: string
): void {
	console.log('');
	console.log(`${c.cyan}${c.bold}  ╔══════════════════════════════════════╗${c.reset}`);
	console.log(`${c.cyan}${c.bold}  ║   Melchizedek Syndicate (ADK v1.0)   ║${c.reset}`);
	console.log(`${c.cyan}${c.bold}  ╚══════════════════════════════════════╝${c.reset}`);
	console.log(`${c.dim}  Syndicate    : ${c.yellow}${config.syndicate_name}${c.reset}`);
	console.log(`${c.dim}  Orchestrator : ${c.yellow}${config.orchestrator.name} (${config.orchestrator.model})${c.reset}`);
	const subagentNames = config.subagents.filter(s => s.name).map(s => s.name);
	if (subagentNames.length > 0) {
		console.log(`${c.dim}  Subagents    : ${c.yellow}${subagentNames.join(', ')}${c.reset}`);
	}
	const keys = Object.keys(bindings);
	if (keys.length > 0) {
		const bindStr = keys.map(k => `${k}=${bindings[k]}`).join(', ');
		console.log(`${c.dim}  Bindings     : ${c.magenta}${bindStr}${c.reset}`);
	}

	// Persistence indicators
	const sessionLabel = persistence.sessionService === 'supabase'
		? `${c.green}Supabase Postgres${c.reset}`
		: `${c.yellow}In-Memory${c.reset}`;
	const memoryLabel = persistence.memoryService === 'supabase-vector'
		? `${c.green}Supabase Vector Search (semantic)${c.reset}`
		: `${c.yellow}None${c.reset}`;
	console.log(`${c.dim}  Sessions     : ${sessionLabel}`);
	console.log(`${c.dim}  Memory       : ${memoryLabel}`);

	if (sessionId) {
		const sessionMode = persistence.sessionService === 'supabase' ? 'persistent' : 'in-memory';
		console.log(`${c.dim}  Session ID   : ${c.green}${sessionId}${c.reset} ${c.dim}(${sessionMode}, multi-turn)${c.reset}`);
	}
	console.log(`${c.dim}  Type         : ${c.green}"exit"${c.dim} to end the session${c.reset}`);
	console.log('');
}

async function main(): Promise<void> {
	loadEnv(import.meta.url);

	// ── Register non-Gemini LLM providers ────────────────────────────────────
	// WHY: Must run AFTER loadEnv() so that API keys from .env are available.
	// registerClaudeLlm() is a no-op if ANTHROPIC_API_KEY is absent — Gemini
	// syndicates continue to work without an Anthropic key set.
	// registerOllamaLlm() is unconditional: a local provider has no key to
	// gate on. ollama/* syndicates run with no cloud credentials at all.
	if (process.env.ANTHROPIC_API_KEY) {
		registerClaudeLlm();
	}
	registerOllamaLlm();

	const apiKey = process.env.GOOGLE_GENAI_API_KEY || process.env.GEMINI_API_KEY;
	if (apiKey) {
		process.env.GEMINI_API_KEY = apiKey;
	}
	// The key requirement is enforced AFTER the syndicate loads: a syndicate
	// whose every agent is an open-weight ollama/* model needs no key at all.

	// ── Parse --syndicate flag ────────────────────────────────
	// WHY: Allows invoking any syndicate config without editing code.
	// Usage: npm run chat:syndicate -- --syndicate critic
	// Defaults to 'syndicate.yaml' for backwards compatibility.
	let syndicateFile = 'syndicate.yaml';
	const argv = process.argv.slice(2);
	for (let i = 0; i < argv.length; i++) {
		if (argv[i] === '--syndicate' && i + 1 < argv.length) {
			const name = argv[i + 1];
			syndicateFile = name.endsWith('.yaml') ? name : `${name}.yaml`;
			break;
		}
	}

	// Define syndicate variable bindings
	const bindings = {
		headline_count: 3,
		current_date: new Date().toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric' })
	};

	// Merge CLI overrides on top (--bind/--bindings flags win)
	const cliBindings = parseCliBindings(argv);
	const mergedBindings = { ...bindings, ...cliBindings };

	// Load the syndicate definition
	const config = loadSyndicate(syndicateFile, {
		bindings: mergedBindings,
	});

	// ── Enforce the key requirement (local syndicates are exempt) ────────────
	// WHY: An all-ollama/* syndicate runs entirely on the user's machine, so
	// demanding a Gemini key would be an artificial gate. Any cloud model in
	// the graph (or Gemini-backed tools like google_search / generate_image /
	// long-term memory embeddings) still requires the key.
	const declaredModels = [
		config.orchestrator.model,
		...config.subagents.map((s) => s.model),
	].filter((m): m is string => !!m);
	const allLocalModels =
		declaredModels.length > 0 && declaredModels.every((m) => m.startsWith('ollama/'));
	if (!apiKey && !allLocalModels) {
		console.error(`${c.yellow}⚠ API Key is not set.${c.reset}`);
		console.error(`${c.dim}  (Only syndicates whose every agent uses an ollama/* model run keyless.)${c.reset}`);
		process.exit(1);
	}

	// Generate stable session identifiers upfront so the banner can display them.
	// Memory/session silo for the local CLI. Override with MELCHIZEDEK_USER_ID
	// when testing per-user isolation (e.g. long-term memory for two different
	// people) — otherwise every CLI session shares the 'local-user' bucket.
	const SESSION_USER_ID = process.env.MELCHIZEDEK_USER_ID?.trim() || 'local-user';
	const SESSION_ID = randomUUID();

	// ── Detect persistence mode ──────────────────────────────────────────────
	const persistence = detectPersistenceConfig(config.memory_system);

	// ── Tool resolver ─────────────────────────────────────────────────────────
	// WHY: Tool names in YAML are strings. This function maps them to live ADK
	// tool instances. Add new FunctionTools here as the syndicate library grows.
	const resolveTools = (toolNames: string[] = []): any[] =>
		resolveNamedTools(toolNames, (name) =>
			console.warn(`${c.yellow}⚠ Unknown tool: '${name}' — skipping.${c.reset}`),
		);

	// 1. Build ADK Subagents
	const orchestratorTools: any[] = [];
	for (const subConfig of config.subagents) {
		const tools = resolveTools(subConfig.tools);
		
		if (subConfig.mcp_server_url) {
			const mcpTools = await createMcpTools(subConfig.mcp_server_url);
			for (const mcpTool of mcpTools) {
				if (!tools.some(t => t.name === mcpTool.name)) {
					tools.push(mcpTool);
				}
			}
		}

		const agent = new LlmAgent({
			name: subConfig.name,
			model: subConfig.model,
			instruction: subConfig.instruction,
			description: subConfig.description,
			tools: tools.length > 0 ? tools : undefined,
			inputSchema: {
				type: "OBJECT",
				properties: {
					query: {
						type: "STRING",
						description: `The search query or instruction for ${subConfig.name}`
					}
				},
				required: ["query"]
			} as any,
			outputSchema: subConfig.outputSchema as any,
			generateContentConfig: {
				...(subConfig.generateContentConfig as any),
				toolConfig: {
					...(subConfig.generateContentConfig as any)?.toolConfig,
					includeServerSideToolInvocations: true
				}
			} as any
		});

		orchestratorTools.push(new AgentTool({ agent }));
	}

	// 2. Build ADK Orchestrator and provide subagents + its own direct tools
	// WHY: The orchestrator may declare its own tools in YAML (e.g. generate_image,
	// load_memory, preload_memory) in addition to — or instead of — subagent AgentTools.
	const orchestratorDirectTools = resolveTools(config.orchestrator.tools);
	const allOrchestratorTools = [...orchestratorTools, ...orchestratorDirectTools];

	const orchestrator = new LlmAgent({
		name: config.orchestrator.name,
		model: config.orchestrator.model,
		instruction: config.orchestrator.instruction,
		description: 'The master orchestrator.',
		tools: allOrchestratorTools.length > 0 ? allOrchestratorTools : undefined,
		outputSchema: config.orchestrator.outputSchema as any,
		generateContentConfig: {
			...(config.orchestrator.generateContentConfig as any),
			toolConfig: {
				...(config.orchestrator.generateContentConfig as any)?.toolConfig,
				includeServerSideToolInvocations: true
			}
		} as any
	});

	// 3. Build the runner.
	//
	// WHY: We now construct a full `Runner` (not InMemoryRunner) when cloud
	// credentials are available. Runner accepts explicit sessionService and
	// memoryService instances, enabling persistent state across process restarts
	// (Firebase) and semantic long-term memory (Vertex). When no cloud credentials
	// are detected, we fall back to InMemoryRunner for local development.
	const appName = config.syndicate_name || 'melchizedek-syndicate';

	let runner: Runner;

	// ── Runner Construction ───────────────────────────────────────────────────
	// WHY: The persistence provider is resolved here, not inline. Supabase init,
	// service construction, and credential handling all live in supabaseProvider.ts.
	// To swap backends, update the import at the top of this file — nothing here
	// needs to change.
	if (persistence.sessionService === 'supabase') {
		// ── Supabase Mode ─────────────────────────────────────────
		// WHY: Full cloud persistence. Session state survives process restarts
		// (Supabase) and long-term memory accumulates across sessions (Supabase
		// pgvector). All Supabase-specific init is delegated to the factory.
		const { sessionService, memoryService } = await createSupabaseServices({
			// Empty only when an all-local syndicate runs keyless — in that case
			// detectPersistenceConfig has already forced withMemory to false.
			apiKey: apiKey ?? '',
			withMemory: persistence.memoryService === 'supabase-vector',
		});

		runner = new Runner({
			agent: orchestrator,
			appName,
			sessionService,
			memoryService,
		});
	} else {
		// ── In-Memory Mode ────────────────────────────────────────────────────
		// WHY: No Supabase credentials found. Use InMemorySessionService for
		// session state (volatile, process-scoped). Memory service is omitted
		// since it requires Supabase to function.
		const sessionService = new InMemorySessionService();

		runner = new Runner({
			agent: orchestrator,
			appName,
			sessionService,
			memoryService: undefined,
		});
	}

	// WHY: We create the session explicitly so we control the ID and can
	// display it in the banner. The session record lives in whichever
	// sessionService was wired into the runner.
	await runner.sessionService.createSession({
		appName,
		userId: SESSION_USER_ID,
		sessionId: SESSION_ID,
		state: {}
	});

	// Now that the session is live, render the startup banner with the session ID.
	banner(config, persistence, mergedBindings, SESSION_ID);

	// Suppress verbose ADK info and benign warnings
	const originalInfo = console.info;
	console.info = (...args) => {
		if (typeof args[0] === 'string' && args[0].includes('[ADK]')) return;
		originalInfo(...args);
	};
	const originalWarn = console.warn;
	console.warn = (...args) => {
		if (typeof args[0] === 'string' && args[0].includes('[ADK]') && args[0].includes('Event from an unknown agent')) return;
		originalWarn(...args);
	};
	const originalLog = console.log;
	console.log = (...args) => {
		if (typeof args[0] === 'string' && args[0].includes('[ADK]')) return;
		originalLog(...args);
	};

	// Strip --bind/--bindings/--syndicate pairs AND bare '--' separators from
	// argv to get the actual user query. The bare '--' leaks in when npm passes
	// the named syndicate shortcuts (e.g. syndicate:image) to the node process.
	const rawArgs = process.argv.slice(2);
	const queryParts: string[] = [];
	for (let i = 0; i < rawArgs.length; i++) {
		if (rawArgs[i] === '--') continue; // drop bare separator
		if ((rawArgs[i] === '--bind' || rawArgs[i] === '--bindings' || rawArgs[i] === '--syndicate') && i + 1 < rawArgs.length) {
			i++; // skip the value
		} else {
			queryParts.push(rawArgs[i]);
		}
	}
	const cliInput = queryParts.join(' ');

	async function runChat(trimmed: string) {
		try {
			// WHY: runAsync (not runEphemeral) is used here so that the runner
			// reads the existing session from InMemorySessionService, appends the
			// new user message, runs the agent, and writes the assistant reply back
			// — preserving full multi-turn history within this process lifetime.
			let stream = runner.runAsync({
				userId: SESSION_USER_ID,
				sessionId: SESSION_ID,
				newMessage: { role: 'user', parts: [{ text: trimmed }] }
			});

			stream = traceAgentRun(stream, {
				syndicateName: config.syndicate_name || 'melchizedek-syndicate',
				bindings: mergedBindings,
				input: trimmed
			});

			let currentMode: 'thinking' | 'text' | 'none' = 'none';

			for await (const event of stream) {
				const calls = getFunctionCalls(event);
				if (calls && calls.length > 0) {
					for (const call of calls) {
						if (call.name === 'transfer_to_agent') {
							console.log(`\n${c.dim}[${event.author} is delegating to subagent: ${JSON.stringify(call.args)}]${c.reset}`);
						} else {
							console.log(`\n${c.dim}[${event.author} is calling tool: ${call.name}]${c.reset}`);
						}
					}
				}

				const responses = getFunctionResponses(event);
				if (responses && responses.length > 0) {
					for (const response of responses) {
						console.log(`\n${c.dim}[Received response from: ${response.name}]${c.reset}`);
					}
				}

				// WHY: LlmResponse can carry errorCode/errorMessage (e.g. billing errors,
				// rate limits, invalid model) without raising a JS exception. Without this
				// check those errors are silently dropped, producing a blank response.
				// NOTE: 'STOP' is a normal finishReason mapped to errorCode by ADK when content is empty.
				const evAny = event as any;
				if ((evAny.errorCode || evAny.errorMessage) && evAny.errorCode !== 'STOP') {
					console.error(`\n${c.yellow}⚠ [${evAny.errorCode ?? 'ERROR'}] ${evAny.errorMessage ?? ''}${c.reset}`);
				}

				if (event.content && event.content.parts) {
					for (const part of event.content.parts) {
						if ((part as any).thought) {
							if (currentMode !== 'thinking') {
								console.log(`\n${c.cyan}✦ ${event.author} is thinking...${c.reset}`);
								currentMode = 'thinking';
							}
							process.stdout.write(c.dim + part.text + c.reset);
						} else if (part.text) {
							if (currentMode === 'thinking') {
								console.log(`\n\n${c.magenta}${c.bold}${event.author}${c.reset} › `);
								currentMode = 'text';
							} else if (currentMode === 'none') {
								process.stdout.write(`\n${c.magenta}${c.bold}${event.author}${c.reset} › `);
								currentMode = 'text';
							}
							process.stdout.write(part.text);
						} else if ((part as any).inlineData) {
							// WHY: Image generation models return binary data as base64-encoded
							// inlineData parts. We detect these, decode them, and save to disk
							// so the user gets a real file rather than raw base64 in the terminal.
							const { mimeType, data } = (part as any).inlineData;
							const ext = mimeType?.split('/')[1] ?? 'png';
							const outputDir = join(process.cwd(), 'outputs');
							mkdirSync(outputDir, { recursive: true });
							const filename = `image_${Date.now()}.${ext}`;
							const filepath = join(outputDir, filename);
							writeFileSync(filepath, Buffer.from(data, 'base64'));
							process.stdout.write(`\n${c.green}✓ Image saved → outputs/${filename}${c.reset}\n`);
						}
					}
				}
			}
			console.log('\n');

		} catch (err: unknown) {
			const msg = err instanceof Error ? err.message : String(err);
			console.error(`\n${c.yellow}⚠ Error: ${msg}${c.reset}\n`);
		}
	}

	if (cliInput) {
		console.log(`${c.green}${c.bold}You${c.reset} › ${cliInput}`);
		await runChat(cliInput);
		// WHY: After a single-shot CLI invocation, ingest the session into
		// long-term memory before exiting. This ensures even one-off queries
		// contribute to the agent's knowledge base.
		await ingestSessionMemory(runner, appName, SESSION_USER_ID, SESSION_ID);
		return;
	}

	const rl = createInterface({ input: process.stdin, output: process.stdout });
	const ask = (): void => {
		rl.question(`${c.green}${c.bold}You${c.reset} › `, async (userInput: string) => {
			const trimmed = userInput.trim();
			if (!trimmed) { ask(); return; }

			if (['exit', 'quit', 'bye'].includes(trimmed.toLowerCase())) {
				// WHY: On session end, ingest the full conversation into long-term
				// memory. This is the critical moment where ephemeral session data
				// becomes persistent knowledge — the Runner's memoryService
				// extracts facts, embeds them, and stores them for future retrieval.
				console.log(`\n${c.dim}  Ingesting session into long-term memory...${c.reset}`);
				await ingestSessionMemory(runner, appName, SESSION_USER_ID, SESSION_ID);
				console.log(`${c.cyan}  Goodbye! 👋${c.reset}\n`);
				rl.close();
				return;
			}

			await runChat(trimmed);
			ask();
		});
	};

	// WHY: If the user forcefully exits the CLI (Ctrl+C), we must intercept the 
	// termination signal to ensure the current session is gracefully ingested 
	// into long-term memory before the process dies.
	process.on('SIGINT', async () => {
		console.log(`\n${c.dim}  Intercepted exit signal. Ingesting session into long-term memory...${c.reset}`);
		await ingestSessionMemory(runner, appName, SESSION_USER_ID, SESSION_ID);
		console.log(`${c.cyan}  Goodbye! 👋${c.reset}\n`);
		process.exit(0);
	});

	ask();
}

/**
 * Ingests the current session into the Runner's memory service.
 *
 * WHY: The ADK Runner does not automatically call addSessionToMemory() —
 * that responsibility falls to the application layer. We fetch the full
 * session (with all accumulated events) from the session service and pass
 * it to the memory service's extraction pipeline. This is where session
 * transcripts get compressed into semantic facts and stored for future recall.
 */
async function ingestSessionMemory(
	runner: Runner,
	appName: string,
	userId: string,
	sessionId: string
): Promise<void> {
	if (!runner.memoryService) return;

	try {
		const session = await runner.sessionService.getSession({
			appName,
			userId,
			sessionId,
		});

		if (!session || session.events.length === 0) {
			console.log(`${c.dim}  No session data to ingest.${c.reset}`);
			return;
		}

		await runner.memoryService.addSessionToMemory(session);
		console.log(`${c.green}  ✓ Session ingested into long-term memory.${c.reset}`);
	} catch (err: unknown) {
		const msg = err instanceof Error ? err.message : String(err);
		console.error(`${c.yellow}  ⚠ Memory ingestion failed: ${msg}${c.reset}`);
	}
}

main().catch((err) => {
	if (err.code !== 'ERR_USE_AFTER_CLOSE') {
		console.error(err);
		process.exit(1);
	}
});
