import type { ToolSet } from "ai";
import type { RunnerBrowserInteractionStep } from "@/shared/eval-trace";

export type BrowserScreenshotEvidence = {
  turnId: string;
  toolCallId: string;
  toolName: string;
  stepIndex: number;
  status: "ready" | "not_captured" | "unavailable";
  mediaType?: "image/jpeg" | "image/png";
  bytes?: number;
  url?: string;
};
const MAX_SCREENSHOT_CHARS = 512_000;
const record = (value: unknown): Record<string, unknown> | undefined =>
  value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
function screenshotOf(value: unknown): string | undefined {
  const obj = record(value);
  if (!obj) return undefined;
  if (typeof obj.screenshot === "string") return obj.screenshot;
  for (const key of ["page", "output", "result"]) {
    const nested = record(obj[key]);
    if (typeof nested?.screenshot === "string") return nested.screenshot;
    const page = record(nested?.page);
    if (typeof page?.screenshot === "string") return page.screenshot;
  }
  return undefined;
}
function capture(
  raw: string,
):
  | { base64: string; mediaType: "image/jpeg" | "image/png"; bytes: number }
  | undefined {
  if (raw.length > MAX_SCREENSHOT_CHARS) return undefined;
  const base64 = raw.replace(/^data:image\/(?:png|jpeg);base64,/, "");
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(base64)) return undefined;
  const bytes = Buffer.from(base64, "base64");
  const mediaType = bytes.subarray(0, 3).equals(Buffer.from([255, 216, 255]))
    ? "image/jpeg"
    : bytes
        .subarray(0, 8)
        .equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))
    ? "image/png"
    : undefined;
  return mediaType ? { base64, mediaType, bytes: bytes.length } : undefined;
}

/** Clone for persistence only: the model still receives the original image. */
export function redactBrowserScreenshots(
  value: unknown,
  pointer: Pick<
    BrowserScreenshotEvidence,
    "turnId" | "toolCallId" | "stepIndex"
  >,
): unknown {
  if (Array.isArray(value))
    return value.map((item) => redactBrowserScreenshots(item, pointer));
  const obj = record(value);
  if (!obj) return value;
  if (
    obj.type === "image-data" ||
    obj.type === "image" ||
    obj.type === "image_url"
  )
    return {
      type: "text",
      text: `[screenshot stored: turnId=${pointer.turnId} toolCallId=${pointer.toolCallId} stepIndex=${pointer.stepIndex}]`,
    };
  return Object.fromEntries(
    Object.entries(obj).map(([key, item]) => [
      key,
      (key === "screenshot" || key === "screenshotBase64") &&
      typeof item === "string"
        ? { ...pointer }
        : redactBrowserScreenshots(item, pointer),
    ]),
  );
}

export function wrapBrowserToolsForEvidence(
  tools: ToolSet,
  args: {
    turnId: string;
    promptIndex: number;
    /** Resolves only after an acknowledged artifact write; absence is unavailable. */
    persist: (
      step: RunnerBrowserInteractionStep,
    ) => Promise<string | undefined>;
    evidence: BrowserScreenshotEvidence[];
  },
): ToolSet {
  return Object.fromEntries(
    Object.entries(tools).map(([name, definition]) => {
      if (!definition.execute) return [name, definition];
      const execute = definition.execute;
      return [
        name,
        {
          ...definition,
          execute: async (
            input: unknown,
            options: Parameters<NonNullable<typeof definition.execute>>[1],
          ) => {
            const started = Date.now();
            const item: BrowserScreenshotEvidence = {
              turnId: args.turnId,
              toolCallId: options.toolCallId,
              toolName: name,
              stepIndex: 0,
              status: "not_captured",
            };
            let result: unknown;
            try {
              result = await execute(input as never, options);
              return result;
            } finally {
              const raw = screenshotOf(result);
              const image = raw ? capture(raw) : undefined;
              if (raw) item.status = "unavailable";
              if (image) {
                item.mediaType = image.mediaType;
                item.bytes = image.bytes;
              }
              args.evidence.push(item);
              try {
                const url = await args.persist({
                  turnId: args.turnId,
                  toolCallId: options.toolCallId,
                  toolName: name,
                  promptIndex: args.promptIndex,
                  stepIndex: 0,
                  action: "screenshot",
                  source: "browser_tool",
                  ts: started,
                  elapsedMs: Date.now() - started,
                  ok:
                    result !== undefined &&
                    !record(result)?.error &&
                    record(result)?.ok !== false,
                  ...(image ? { screenshotBase64: image.base64 } : {}),
                });
                if (image && url) {
                  item.status = "ready";
                  item.url = url;
                }
              } catch {
                if (raw) item.status = "unavailable";
              }
            }
          },
        },
      ];
    }),
  ) as ToolSet;
}

/** Redact only browser-call subtrees, retaining unrelated MCP image results. */
export function redactBrowserEvidenceTree(
  value: unknown,
  evidence: BrowserScreenshotEvidence[],
): unknown {
  if (Array.isArray(value))
    return value.map((item) => redactBrowserEvidenceTree(item, evidence));
  const obj = record(value);
  if (!obj) return value;
  const item = evidence.find((entry) => entry.toolCallId === obj.toolCallId);
  if (item) return redactBrowserScreenshots(obj, item);
  return Object.fromEntries(
    Object.entries(obj).map(([key, nested]) => [
      key,
      redactBrowserEvidenceTree(nested, evidence),
    ]),
  );
}
