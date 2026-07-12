/**
 * inspectImageTool — native ADK FunctionTool for BLIND visual inventory.
 *
 * WHY a FunctionTool instead of an AgentTool subagent:
 *   Same constraint as generateImageTool in reverse — AgentTool converts all
 *   traffic to text, so image bytes can't ride into a subagent's context.
 *   A FunctionTool reads the saved file directly and calls the vision model
 *   itself.
 *
 * WHY the inventory prompt is hard-coded here and takes ONLY a file path:
 *   The whole point of the inventory is that it is blind. An agent that knows
 *   the spec asked for three amphorae will helpfully "see" three (expectation
 *   bias). Because this tool's signature accepts nothing but a path, the
 *   orchestrator CANNOT leak the spec into the inventory even by accident —
 *   the separation of perception from judgment is enforced by the type
 *   system, not by good intentions. Judgment happens downstream in the
 *   SpecAuditor subagent, which sees spec + inventory but never the image.
 */

import { FunctionTool } from '@google/adk';
import { GoogleGenAI, type Schema } from '@google/genai';
import { readFileSync } from 'node:fs';
import { resolve, extname, sep } from 'node:path';

const VISION_MODEL = 'gemini-3.5-flash';

const INVENTORY_PROTOCOL = `You are a blind visual inventory agent. You know NOTHING about what this image was supposed to be, who requested it, or why. Enumerate ONLY what is actually present:

1. SUBJECTS — every distinct subject and object, with EXACT counts.
2. COMPOSITION — framing, perspective, and placement (foreground / midground / background).
3. LIGHT — direction, quality, and any notable lighting phenomena.
4. PALETTE — dominant colors and tonal range.
5. MEDIUM CUES — photographic, painterly, or rendered qualities; grain, texture, brushwork.
6. TEXT & ARTIFACTS — any lettering, watermarks, or generation artifacts.

RULES:
- Counts are exact numbers, never "several".
- ZERO quality judgments: no "beautiful", no "well-composed", no "striking".
- ZERO guesses about intent or purpose.
- If something is genuinely ambiguous, write "uncertain:" and describe what is visible.
Return a plain, factual, numbered inventory.`;

export const inspectImageTool = new FunctionTool({
  name: 'inspect_image',
  description:
    'Performs a BLIND visual inventory of a previously saved image (subjects with exact counts, ' +
    'composition, light, palette, medium cues, artifacts). Pass ONLY the file path returned by ' +
    'generate_image — never describe the expected content, or the inventory will be primed.',
  parameters: {
    type: 'OBJECT' as const,
    properties: {
      image_path: {
        type: 'STRING' as const,
        description: 'Path to the saved image, e.g. "outputs/image_1234.png".',
      },
    },
    required: ['image_path'],
  } as unknown as Schema,
  execute: async (input: unknown): Promise<string> => {
    const { image_path } = input as { image_path: string };
    console.log(`[InspectTool] Blind inventory requested for: ${image_path}`);

    // Confine reads to the outputs/ directory — this tool inventories
    // generated artifacts, not the filesystem.
    const outputsDir = resolve(process.cwd(), 'outputs');
    const fullPath = resolve(process.cwd(), image_path);
    if (!fullPath.startsWith(outputsDir + sep)) {
      throw new Error('inspect_image only reads files under outputs/');
    }

    const apiKey = process.env.GEMINI_API_KEY || process.env.GOOGLE_GENAI_API_KEY;
    if (!apiKey) {
      throw new Error(
        'Gemini API Key is not configured (neither GEMINI_API_KEY nor GOOGLE_GENAI_API_KEY was found in environment).',
      );
    }

    const bytes = readFileSync(fullPath);
    const ext = extname(fullPath).slice(1).toLowerCase() || 'png';
    const mimeType = `image/${ext === 'jpg' ? 'jpeg' : ext}`;

    const ai = new GoogleGenAI({ apiKey });
    console.log(`[InspectTool] Sending image (${bytes.length} bytes, ${mimeType}) to ${VISION_MODEL}...`);
    const response = await ai.models.generateContent({
      model: VISION_MODEL,
      contents: [
        {
          role: 'user',
          parts: [
            { inlineData: { mimeType, data: bytes.toString('base64') } },
            { text: INVENTORY_PROTOCOL },
          ],
        },
      ],
    });

    const text =
      response.candidates?.[0]?.content?.parts
        ?.map((p) => (p as { text?: string }).text ?? '')
        .join('') ?? '';
    if (!text) {
      throw new Error('inspect_image: vision model returned no text inventory.');
    }
    console.log(`[InspectTool] Inventory received (${text.length} chars).`);
    return `BLIND INVENTORY of ${image_path}:\n${text}`;
  },
});
