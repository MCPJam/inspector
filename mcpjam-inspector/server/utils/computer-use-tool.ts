/**
 * computer-use-tool.ts — Anthropic Computer Use tools for the local AI-SDK eval
 * path, backed by the headless-Chromium harness (PR 3).
 *
 * Browser-rendered MCP App eval PR 4. Registers two AI SDK tools:
 *   - `computer` — the Anthropic provider-native computer tool
 *     (`anthropic.tools.computer_20250124` / `computer_20251124`). Including the
 *     factory in the tool map is what makes the AI SDK Anthropic provider
 *     auto-attach the matching beta header (`computer-use-2025-01-24` /
 *     `-11-24`) — no providerOptions / extraHeaders plumbing. Its `execute`
 *     drives the harness; `toModelOutput` turns the implementation result into a
 *     model-visible screenshot + a summary of any widget-initiated tools/call.
 *   - `finish_widget` — a regular AI SDK tool the model calls to dismiss a
 *     rendered widget when it's done interacting.
 *
 * Computer Use is Claude-only; `resolveComputerUseToolVersion` returns `null`
 * for unsupported driver models so the caller drops both tools.
 */

import { tool, type ToolSet } from "ai";
import { anthropic } from "@ai-sdk/anthropic";
import { z } from "zod";
import type {
  BrowserActionSpec,
  McpAppBrowserHarness,
  WidgetToolCall,
} from "./mcp-app-browser-harness";

export type ComputerUseToolVersion = "20250124" | "20251124";

/**
 * Model id → computer-tool version. A single source of truth so the unit test
 * can enumerate every entry against the AI SDK provider-tool registry and catch
 * drift on SDK upgrades. Matched by longest id prefix (so dated/suffixed ids
 * like `claude-sonnet-4-5-20250929` resolve correctly). Updated whenever a new
 * Claude model with Computer Use ships.
 */
export const COMPUTER_USE_TOOL_VERSIONS: Record<string, ComputerUseToolVersion> =
  {
    // computer_20251124 (Opus 4.5+ generation / newest)
    "claude-opus-4-8": "20251124",
    "claude-opus-4-7": "20251124",
    "claude-opus-4-6": "20251124",
    "claude-sonnet-4-7": "20251124",
    "claude-sonnet-4-6": "20251124",
    "claude-haiku-4-6": "20251124",
    // computer_20250124 (4.x generation)
    "claude-sonnet-4-5": "20250124",
    "claude-haiku-4-5": "20250124",
    "claude-opus-4-5": "20250124",
    "claude-sonnet-4": "20250124",
    "claude-opus-4": "20250124",
    "claude-haiku-4": "20250124",
  };

// Longest-prefix order so e.g. `claude-opus-4-8` wins over `claude-opus-4`.
const VERSION_KEYS_BY_LENGTH = Object.keys(COMPUTER_USE_TOOL_VERSIONS).sort(
  (a, b) => b.length - a.length,
);

function normalizeModelId(
  model: string | { id?: string; modelId?: string } | null | undefined,
): string | undefined {
  const raw =
    typeof model === "string"
      ? model
      : (model?.id ?? model?.modelId ?? undefined);
  if (!raw) return undefined;
  // Strip a provider prefix (`anthropic/`, `anthropic.`) and lowercase.
  return raw.toLowerCase().replace(/^anthropic[./]/, "");
}

/**
 * Resolve the computer-tool version for a driver model, or `null` if the model
 * doesn't support Computer Use (non-Claude, or an unmapped Claude id) — in
 * which case the caller must not advertise the `computer` / `finish_widget`
 * tools.
 */
export function resolveComputerUseToolVersion(
  model: string | { id?: string; modelId?: string } | null | undefined,
): ComputerUseToolVersion | null {
  const id = normalizeModelId(model);
  if (!id) return null;
  for (const key of VERSION_KEYS_BY_LENGTH) {
    if (id === key || id.startsWith(`${key}-`)) {
      return COMPUTER_USE_TOOL_VERSIONS[key];
    }
  }
  return null;
}

/** Broad structural type covering both versions' action inputs. */
export interface ComputerActionInput {
  action: string;
  coordinate?: [number, number];
  start_coordinate?: [number, number];
  text?: string;
  duration?: number;
  scroll_amount?: number;
  scroll_direction?: "up" | "down" | "left" | "right";
  region?: [number, number, number, number];
}

/** Implementation output of the `computer` tool (not model-visible directly). */
export interface ComputerImplOutput {
  screenshotBase64?: string;
  widgetToolCalls: WidgetToolCall[];
  action: ComputerActionInput;
  elapsedMs: number;
  /** Harness note (e.g. "budget_exceeded", "no rendered widget"). */
  note?: string;
}

type ComputerModelOutput = {
  type: "content";
  value: Array<
    | { type: "text"; text: string }
    | { type: "image-data"; data: string; mediaType: string }
  >;
};

/** Map the AI SDK computer action to the harness's supported action subset. */
export function mapToBrowserAction(input: ComputerActionInput): BrowserActionSpec {
  switch (input.action) {
    case "left_click":
    case "double_click":
    case "right_click":
    case "mouse_move":
      return { action: input.action, coordinate: input.coordinate };
    case "triple_click":
      // No triple-click in the harness; double_click is the closest analogue.
      return { action: "double_click", coordinate: input.coordinate };
    case "type":
      return { action: "type", text: input.text };
    case "key":
      return { action: "key", text: input.text };
    case "scroll":
      return {
        action: "scroll",
        coordinate: input.coordinate,
        scrollAmount: input.scroll_amount,
        scrollDirection: input.scroll_direction,
      };
    case "wait":
      return { action: "wait", duration: input.duration };
    case "screenshot":
    case "cursor_position":
      return { action: "screenshot" };
    default:
      // hold_key, left_mouse_down/up, left_click_drag, middle_click, zoom, …
      // are not modeled by the harness — return current state via a screenshot.
      return { action: "screenshot" };
  }
}

function detectImageMediaType(base64: string): string {
  // JPEG base64 begins with "/9j/"; PNG with "iVBOR".
  return base64.startsWith("/9j/") ? "image/jpeg" : "image/png";
}

/** Human-readable summary of widget-initiated tools/call for the model. */
export function summarizeWidgetToolCalls(calls: WidgetToolCall[]): string | null {
  if (!calls.length) return null;
  const parts = calls.map((c) => {
    const argStr = Object.entries(c.args ?? {})
      .map(([k, v]) => `${k}=${formatArg(v)}`)
      .join(", ");
    const status = c.ok ? "OK" : `ERROR(${c.error ?? "unknown"})`;
    return `${c.name}(${argStr}) → ${status}`;
  });
  return `During this action the widget invoked: ${parts.join("; ")}`;
}

function formatArg(v: unknown): string {
  if (typeof v === "string") return v.length > 40 ? `${v.slice(0, 37)}…` : v;
  if (v === null || typeof v !== "object") return String(v);
  return "…";
}

/** Translate the implementation output into model-visible content parts. */
export function toComputerModelOutput(
  output: ComputerImplOutput,
): ComputerModelOutput {
  const value: ComputerModelOutput["value"] = [];
  if (output.screenshotBase64) {
    value.push({
      type: "image-data",
      data: output.screenshotBase64,
      mediaType: detectImageMediaType(output.screenshotBase64),
    });
  }
  const summary = summarizeWidgetToolCalls(output.widgetToolCalls);
  if (summary) value.push({ type: "text", text: summary });
  if (output.note) {
    value.push({ type: "text", text: `[harness: ${output.note}]` });
  }
  if (value.length === 0) {
    value.push({ type: "text", text: "No visible change." });
  }
  return { type: "content", value };
}

export interface BuildComputerUseToolsOptions {
  version: ComputerUseToolVersion;
  harness: McpAppBrowserHarness;
  /** The tool-call id of the widget that `computer` actions target (the active
   *  rendered widget). Returns null when no widget is mounted. */
  getActiveToolCallId: () => string | null;
  /** Viewport == screenshot pixel space == the model's coordinate space. */
  viewport: { width: number; height: number };
}

/**
 * Build the `computer` (Anthropic provider-native) + `finish_widget` tools.
 * Including the resolved provider-tool factory in the returned set is what makes
 * the AI SDK Anthropic provider attach the matching beta header.
 */
export function buildComputerUseTools(
  opts: BuildComputerUseToolsOptions,
): ToolSet {
  const { harness, getActiveToolCallId, viewport } = opts;

  const execute = async (
    input: ComputerActionInput,
  ): Promise<ComputerImplOutput> => {
    const toolCallId = getActiveToolCallId();
    if (!toolCallId) {
      return {
        widgetToolCalls: [],
        action: input,
        elapsedMs: 0,
        note: "no rendered widget",
      };
    }
    const result = await harness.executeAction({
      toolCallId,
      action: mapToBrowserAction(input),
    });
    return {
      screenshotBase64: result.screenshotBase64,
      widgetToolCalls: result.widgetToolCalls,
      action: input,
      elapsedMs: result.elapsedMs,
      note: result.note,
    };
  };

  const toModelOutput = ({ output }: { output: ComputerImplOutput }) =>
    toComputerModelOutput(output);

  const factoryArgs = {
    displayWidthPx: viewport.width,
    displayHeightPx: viewport.height,
    execute,
    toModelOutput,
  };

  const computer =
    opts.version === "20251124"
      ? anthropic.tools.computer_20251124(factoryArgs)
      : anthropic.tools.computer_20250124(factoryArgs);

  const finish_widget = tool({
    description:
      "Call this when you are done interacting with the currently rendered " +
      "MCP App widget. Dismisses the widget so the conversation can continue.",
    inputSchema: z.object({
      toolCallId: z
        .string()
        .describe("The tool call id of the rendered widget to dismiss."),
    }),
    execute: async ({ toolCallId }: { toolCallId: string }) => {
      await harness.dismissWidget(toolCallId);
      return { ok: true as const, dismissed: toolCallId };
    },
  });

  return { computer, finish_widget };
}
