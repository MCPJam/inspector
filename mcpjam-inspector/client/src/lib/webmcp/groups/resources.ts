/**
 * Resources-screen tools: read a resource (or a resolved resource template)
 * from the currently-selected server.
 *
 * Mount-scoped like the registry/evals/chatboxes groups: `ResourcesTab` owns
 * the command handler and the resource/template lists it resolves against, so
 * `ui_read_resource` exists exactly while `/resources` is mounted. There is no
 * target server in the payload — the read acts on the server selected on the
 * screen (the same one the Read button uses), resolved from the surface, never
 * from the agent.
 *
 * Read-only by construction: a resource read is a GET against the server, so it
 * carries no MCPJam-side side effect. Transcript safety is the real hazard here
 * — resource bodies can be huge or sensitive, so the returned CONTENT is capped
 * (the handler bounds each text block and `fromActionResult`/`clampText`
 * backstops the whole result at `MAX_RESULT_CHARS`). Full bodies never enter
 * the snapshot; only presence/size does.
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

export function buildResourcesUiTools(): UiToolDefinition[] {
  return [
    {
      name: "ui_read_resource",
      description:
        "Read a resource from the server selected on the Resources screen, exactly as the Read button does. 'resource' is a concrete resource's uri or name as the list shows it, OR a resource template's name/uriTemplate — pass 'templateArguments' to fill a template's parameters. The read reflects on screen and its content is returned TRUNCATED (large or binary bodies are capped/omitted for the transcript). Unknown resource → error; ambiguous → pass the exact uri. List what's available with ui_snapshot_app.",
      inputSchema: {
        type: "object",
        properties: {
          resource: {
            type: "string",
            description:
              "A resource's uri or name, or a resource template's name/uriTemplate, as shown on the Resources screen.",
          },
          templateArguments: {
            type: "object",
            description:
              "Values for a resource template's parameters (string→string). Ignored for a concrete resource.",
            additionalProperties: { type: "string" },
          },
        },
        required: ["resource"],
        additionalProperties: false,
      },
      readOnly: true,
      // A resource read is a GET against the server — no MCPJam-side mutation,
      // safe to repeat. openWorld: it reaches an external MCP server.
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
      },
      // Result is arbitrary content from a THIRD-PARTY MCP server — flag it
      // untrusted for native WebMCP agents.
      nativeUntrustedContentHint: true,
      execute: async (args) => {
        const resource = asOptionalString(args.resource);
        if (!resource) {
          return errorResult(
            "Missing required 'resource' string (a resource uri/name or a template name/uriTemplate).",
          );
        }
        const templateArguments = asStringRecord(args.templateArguments);
        if (!templateArguments.ok) {
          return errorResult(
            "'templateArguments' must be an object of string values when provided.",
          );
        }
        const response = await dispatchInspectorCommand({
          type: "readResource",
          payload: {
            resource,
            ...(templateArguments.record
              ? { templateArguments: templateArguments.record }
              : {}),
          },
        });
        return fromActionResult(commandResponseToActionResult(response));
      },
    },
  ];
}
