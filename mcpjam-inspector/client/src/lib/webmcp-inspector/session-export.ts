/**
 * Turning a WebMCP session into evidence somebody else can read.
 *
 * The timeline is the part of this surface that outlives the session: it is
 * what a developer attaches to a bug report, and what the eval stage will later
 * emit for a whole suite. Two shapes, because two audiences:
 *
 *   - JSON: the session as it happened, for a human or a script.
 *   - OTLP: invocations as spans, for whatever already ingests traces.
 *
 * Both are built from what the store already holds. Nothing is fetched, so an
 * export works on a session whose browser has since closed.
 */
import type {
  WebMcpActivityEntry,
  WebMcpSessionPublic,
  WebMcpToolDescriptor,
} from "@/shared/webmcp-inspector-protocol";

export interface WebMcpExportInput {
  session: WebMcpSessionPublic | undefined;
  tools: readonly WebMcpToolDescriptor[];
  activity: readonly WebMcpActivityEntry[];
  /** Screenshots roughly double the size, so including them is a choice. */
  includeScreenshots?: boolean;
  /** Stamped by the caller — this module never reads the clock. */
  exportedAt: number;
}

export interface WebMcpSessionExport {
  format: "mcpjam.webmcp.session";
  version: 1;
  exportedAt: number;
  session:
    | (Pick<
        WebMcpSessionPublic,
        "sessionId" | "status" | "url" | "createdAt"
      > & {
        viewportTransport: WebMcpSessionPublic["viewportTransport"]["kind"];
      })
    | null;
  tools: WebMcpToolDescriptor[];
  activity: WebMcpActivityEntry[];
  /** Counts a reader would otherwise have to derive. */
  summary: {
    toolCount: number;
    invocations: number;
    succeeded: number;
    failed: number;
    cancelled: number;
    timedOut: number;
    navigations: number;
  };
}

type SettledEntry = Extract<
  WebMcpActivityEntry,
  { kind: "invocation_settled" }
>;
type StartedEntry = Extract<
  WebMcpActivityEntry,
  { kind: "invocation_started" }
>;

function stripScreenshots(
  entries: readonly WebMcpActivityEntry[],
): WebMcpActivityEntry[] {
  return entries.map((entry) => {
    if ("screenshotBase64" in entry && entry.screenshotBase64) {
      const { screenshotBase64: _dropped, ...rest } = entry;
      return rest as WebMcpActivityEntry;
    }
    return entry;
  });
}

export function buildSessionExport(
  input: WebMcpExportInput,
): WebMcpSessionExport {
  const settled = input.activity.filter(
    (entry): entry is SettledEntry => entry.kind === "invocation_settled",
  );
  return {
    format: "mcpjam.webmcp.session",
    version: 1,
    exportedAt: input.exportedAt,
    session: input.session
      ? {
          sessionId: input.session.sessionId,
          status: input.session.status,
          url: input.session.url,
          createdAt: input.session.createdAt,
          viewportTransport: input.session.viewportTransport.kind,
        }
      : null,
    tools: [...input.tools],
    activity: input.includeScreenshots
      ? [...input.activity]
      : stripScreenshots(input.activity),
    summary: {
      toolCount: input.tools.length,
      invocations: settled.length,
      succeeded: settled.filter((entry) => entry.state === "succeeded").length,
      failed: settled.filter((entry) => entry.state === "failed").length,
      cancelled: settled.filter((entry) => entry.state === "cancelled").length,
      timedOut: settled.filter((entry) => entry.state === "timeout").length,
      navigations: input.activity.filter((entry) => entry.kind === "navigated")
        .length,
    },
  };
}

/** Hex ids OTLP requires: 32 chars for a trace, 16 for a span. */
function hexId(seed: string, length: number): string {
  // FNV-1a over the seed, repeated until the id is long enough. Ids only have
  // to be stable and unique within an export, so a non-cryptographic hash is
  // adequate — and unlike a random id, re-exporting the same session produces
  // the same trace, which is what makes two exports comparable.
  let out = "";
  let salt = 0;
  while (out.length < length) {
    let hash = 0x811c9dc5;
    const input = `${seed}#${salt}`;
    for (let index = 0; index < input.length; index += 1) {
      hash ^= input.charCodeAt(index);
      hash +=
        (hash << 1) + (hash << 4) + (hash << 7) + (hash << 8) + (hash << 24);
      hash >>>= 0;
    }
    out += hash.toString(16).padStart(8, "0");
    salt += 1;
  }
  return out.slice(0, length);
}

function attr(key: string, value: string | number | boolean) {
  if (typeof value === "number") {
    return Number.isInteger(value)
      ? { key, value: { intValue: String(value) } }
      : { key, value: { doubleValue: value } };
  }
  if (typeof value === "boolean") return { key, value: { boolValue: value } };
  return { key, value: { stringValue: value } };
}

/** OTLP wants nanoseconds since the epoch, as a decimal string. */
function nanos(ms: number): string {
  return `${Math.round(ms)}000000`;
}

/**
 * One span per invocation, plus a root span for the session.
 *
 * Only invocations become spans: a navigation or a registration is an event
 * about the page, not a unit of work with a duration, and inventing zero-length
 * spans for them would make every trace mostly noise. They stay in the JSON
 * export, which is the shape that keeps everything.
 */
export function buildOtlpExport(input: WebMcpExportInput): unknown {
  const sessionId = input.session?.sessionId ?? "webmcp-session";
  const traceId = hexId(`trace:${sessionId}`, 32);
  const rootSpanId = hexId(`span:${sessionId}`, 16);

  const started = new Map<string, StartedEntry>();
  for (const entry of input.activity) {
    if (entry.kind === "invocation_started") started.set(entry.invokeId, entry);
  }

  const spans: unknown[] = [];
  let earliest = input.session?.createdAt ?? input.exportedAt;
  let latest = input.exportedAt;

  for (const entry of input.activity) {
    if (entry.kind !== "invocation_settled") continue;
    const begin =
      started.get(entry.invokeId)?.ts ?? entry.ts - entry.durationMs;
    earliest = Math.min(earliest, begin);
    latest = Math.max(latest, entry.ts);

    const tool = input.tools.find((item) => item.toolKey === entry.toolKey);
    spans.push({
      traceId,
      spanId: hexId(`span:${entry.invokeId}`, 16),
      parentSpanId: rootSpanId,
      name: `webmcp.invoke ${tool?.name ?? entry.toolKey}`,
      kind: 3, // SPAN_KIND_CLIENT: we are calling out to the page.
      startTimeUnixNano: nanos(begin),
      endTimeUnixNano: nanos(entry.ts),
      attributes: [
        attr("webmcp.tool.key", entry.toolKey),
        attr("webmcp.tool.name", tool?.name ?? entry.toolKey),
        attr("webmcp.tool.origin", tool?.origin ?? ""),
        attr("webmcp.invocation.id", entry.invokeId),
        attr("webmcp.invocation.source", entry.source),
        attr("webmcp.invocation.state", entry.state),
        attr("webmcp.invocation.duration_ms", entry.durationMs),
        ...(entry.outputTruncated
          ? [attr("webmcp.result.truncated", true)]
          : []),
        ...(entry.outputBytes
          ? [attr("webmcp.result.bytes", entry.outputBytes)]
          : []),
        ...(tool?.registrationKind
          ? [attr("webmcp.tool.registration", tool.registrationKind)]
          : []),
        ...(tool?.fromSubframe ? [attr("webmcp.tool.subframe", true)] : []),
      ],
      status:
        entry.state === "succeeded"
          ? { code: 1 } // STATUS_CODE_OK
          : {
              code: 2, // STATUS_CODE_ERROR
              message: entry.errorMessage ?? entry.state,
            },
    });
  }

  spans.unshift({
    traceId,
    spanId: rootSpanId,
    name: "webmcp.session",
    kind: 1, // SPAN_KIND_INTERNAL
    startTimeUnixNano: nanos(earliest),
    endTimeUnixNano: nanos(latest),
    attributes: [
      attr("webmcp.session.id", sessionId),
      attr("webmcp.session.url", input.session?.url ?? ""),
      attr("webmcp.session.tool_count", input.tools.length),
      attr(
        "webmcp.session.viewport",
        input.session?.viewportTransport.kind ?? "unknown",
      ),
    ],
    status: { code: 0 }, // STATUS_CODE_UNSET
  });

  return {
    resourceSpans: [
      {
        resource: {
          attributes: [
            attr("service.name", "mcpjam-webmcp-inspector"),
            attr("telemetry.sdk.name", "mcpjam"),
          ],
        },
        scopeSpans: [{ scope: { name: "mcpjam.webmcp-inspector" }, spans }],
      },
    ],
  };
}

/**
 * Filename that identifies the session and says what it holds.
 *
 * Alphanumerics only, so the punctuation in an id cannot produce a name a
 * filesystem or a browser mangles — and taken AFTER stripping, so the
 * distinguishing part of the id survives rather than being spent on separators.
 */
export function exportFilename(
  sessionId: string | undefined,
  kind: "json" | "otlp",
): string {
  const suffix = kind === "otlp" ? "otlp.json" : "json";
  const slug =
    (sessionId ?? "").replace(/[^a-zA-Z0-9]/g, "").slice(0, 8) || "unknown";
  return `webmcp-session-${slug}.${suffix}`;
}
