import type { TelemetryCatalog } from "./telemetry.js";

const FIELDS: Readonly<Record<string, readonly string[]>> = {
  chunkType: [
    "text-start",
    "text-delta",
    "text-end",
    "reasoning-start",
    "reasoning-delta",
    "reasoning-end",
    "tool-*",
    "data-*",
    "start",
    "start-step",
    "finish-step",
    "abort",
    "message-metadata",
    "custom",
    "source-url",
    "source-document",
    "file",
    "reasoning-file",
    "finish",
    "error",
    "unknown",
  ],
  contentType: ["application/json", "text/event-stream", "text/html"],
  origin: ["user_server", "user_config", "mcpjam", "ambiguous"],
};

export function rebuildSentryFacts(
  input: Record<string, unknown>,
  catalog: TelemetryCatalog
): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  for (const [key, values] of Object.entries({
    ...FIELDS,
    ...catalog.diagnosticFields,
    slug: catalog.slugs ?? [],
  })) {
    const value = key === "code" ? (input.code ?? input.errorCode) : input[key];
    if (typeof value === "string" && values.includes(value))
      result[key] = value;
  }
  for (const [key, min, max] of [
    ["fieldCount", 0, 1000],
    ["httpStatus", 100, 599],
  ] as const) {
    const value = input[key];
    if (
      typeof value === "number" &&
      Number.isInteger(value) &&
      value >= min &&
      value <= max
    )
      result[key] = value;
  }
  if (
    typeof input.requestId === "string" &&
    /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(
      input.requestId
    )
  )
    result.requestId = input.requestId;
  return result;
}
