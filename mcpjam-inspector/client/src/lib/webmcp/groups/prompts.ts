/**
 * Prompts-screen tools: render a prompt with arguments from the currently
 * selected server.
 *
 * Mount-scoped like the registry/resources groups: `PromptsTab` owns the
 * command handler and the prompt list it resolves against, so `ui_get_prompt`
 * exists exactly while `/prompts` is mounted. No target server in the payload —
 * the render acts on the server selected on the screen (the same one the Run
 * button uses), resolved from the surface, never from the agent.
 *
 * Read-only by construction: rendering a prompt is a read (prompts/get) with no
 * MCPJam-side side effect. Transcript safety still applies — a rendered prompt
 * can be large, so the returned CONTENT is capped (the handler bounds each
 * message's text and `fromActionResult`/`clampText` backstops the whole result
 * at `MAX_RESULT_CHARS`). Full messages never enter the snapshot; only
 * presence/size does.
 */

import type { UiToolDefinition } from "../ui-tools-registry";
import {
  commandResponseToActionResult,
  dispatchInspectorCommand,
} from "../ui-actions";
import { asOptionalString, errorResult, fromActionResult } from "./shared";

function asStringRecord(
  value: unknown,
): { ok: true; record?: Record<string, string> } | { ok: false } {
  if (value === undefined) return { ok: true };
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return { ok: false };
  }
  const record: Record<string, string> = {};
  for (const [key, raw] of Object.entries(value as Record<string, unknown>)) {
    if (typeof raw !== "string") return { ok: false };
    record[key] = raw;
  }
  return { ok: true, record };
}

export function buildPromptsUiTools(): UiToolDefinition[] {
  return [
    {
      name: "ui_get_prompt",
      description:
        "Render a prompt from the server selected on the Prompts screen, exactly as the Run button does. 'prompt' is a prompt's name (or title) as the list shows it; 'arguments' supplies its argument values (all string-typed). The render reflects on screen and its content is returned TRUNCATED (large bodies are capped for the transcript). Unknown prompt → error; ambiguous → pass the exact name. List what's available with ui_snapshot_app.",
      inputSchema: {
        type: "object",
        properties: {
          prompt: {
            type: "string",
            description:
              "A prompt's name or title, as shown on the Prompts screen.",
          },
          arguments: {
            type: "object",
            description:
              "Values for the prompt's arguments (string→string). Omit for a prompt that takes none.",
            additionalProperties: { type: "string" },
          },
        },
        required: ["prompt"],
        additionalProperties: false,
      },
      readOnly: true,
      // Rendering a prompt is a read (prompts/get) — no MCPJam-side mutation,
      // safe to repeat. openWorld: it reaches an external MCP server.
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
      },
      execute: async (args) => {
        const prompt = asOptionalString(args.prompt);
        if (!prompt) {
          return errorResult("Missing required 'prompt' string (a prompt name).");
        }
        const promptArguments = asStringRecord(args.arguments);
        if (!promptArguments.ok) {
          return errorResult(
            "'arguments' must be an object of string values when provided.",
          );
        }
        const response = await dispatchInspectorCommand({
          type: "getPrompt",
          payload: {
            prompt,
            ...(promptArguments.record
              ? { arguments: promptArguments.record }
              : {}),
          },
        });
        return fromActionResult(commandResponseToActionResult(response));
      },
    },
  ];
}
