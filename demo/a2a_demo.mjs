/**
 * A2A Demo Script
 * Demonstrates conversing with the Melchizedek A2A server.
 * Uses native fetch for zero dependencies.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// Load environment variables from .env if present
try {
  const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
  const envPath = path.join(root, '.env');
  if (fs.existsSync(envPath)) {
    const raw = fs.readFileSync(envPath, 'utf-8');
    for (const line of raw.split('\n')) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('#')) continue;
      const eq = trimmed.indexOf('=');
      if (eq === -1) continue;
      const key = trimmed.slice(0, eq).trim();
      const val = trimmed.slice(eq + 1).trim();
      if (!process.env[key]) process.env[key] = val;
    }
  }
} catch (e) {
  // Ignore env load errors
}

const API_KEY = process.env.GOOGLE_GENAI_API_KEY || process.env.GEMINI_API_KEY || "<YOUR_GEMINI_API_KEY>";
const A2A_SERVER_SECRET = process.env.A2A_SERVER_SECRET || "local_demo_secret_token";
const A2A_URL = process.env.A2A_URL || "http://localhost:4000/a2a/jsonrpc";

async function main() {
  console.log("========================================");
  console.log("📡 Melchizedek A2A Client Demo");
  console.log("========================================\n");

  const requestPayload = {
    jsonrpc: "2.0",
    id: 1,
    method: "message/send",
    params: {
      message: {
        messageId: crypto.randomUUID(),
        role: "user",
        parts: [{ kind: "text", text: "Hello! Please tell me a brief joke." }]
      },
      contextId: "demo-session-001"
    }
  };

  console.log("➡️  Sending A2A JSON-RPC Request:");
  console.log(JSON.stringify(requestPayload, null, 2));

  try {
    const headers = {
      "Content-Type": "application/json",
      "X-API-Key": API_KEY,
      "X-Provider": "google" // Required by Melchizedek's BYOK middleware
    };

    if (A2A_SERVER_SECRET) {
      headers["Authorization"] = `Bearer ${A2A_SERVER_SECRET}`;
    }

    const response = await fetch(A2A_URL, {
      method: "POST",
      headers,
      body: JSON.stringify(requestPayload)
    });

    if (!response.ok) {
      console.error(`\n❌ HTTP Error: ${response.status} ${response.statusText}`);
      const text = await response.text();
      console.error("Response:", text);
      return;
    }

    const data = await response.json();
    console.log("\n⬅️  Received A2A Response:");
    
    if (data.error) {
       console.error("❌ RPC Error:", JSON.stringify(data.error, null, 2));
       return;
    }

    // Safely print the result from the agent
    console.log(JSON.stringify(data.result, null, 2));
    
    console.log("\n✅ A2A Conversation Successful!");
  } catch (error) {
    console.error("\n❌ Request failed:", error.message);
    console.log("\nDid you remember to start the server?");
    console.log("1. cd /Users/koainpker/Desktop/Git/melchizedek");
    console.log("2. npm run start:a2a");
  }
}

main();
