/**
 * One paste-able description of what the viewport is actually doing.
 *
 * The pane degrades SILENTLY on purpose — a socket that will not open falls
 * back to SSE frames, a server too old to screencast falls back to a
 * screenshot poll, and a link that cannot carry the stream gets a lower
 * quality — so a person reporting "it's laggy" and a person reporting "it's
 * blurry" may be describing four different mechanisms working exactly as
 * designed. Nothing in the UI can show all of that without becoming a
 * dashboard, and none of it is worth a support round trip to ask about one
 * field at a time.
 *
 * So: one button, one JSON object, the whole picture. Deliberately free of
 * page content, and of the parts of a URL that carry credentials — this gets
 * pasted into issues.
 */
import { copyToClipboard } from "@/lib/clipboard";
import { toast } from "@/lib/toast";
import { frameStatsReport, type FrameStatsReport } from "./frame-stats";
import type { WebMcpFrameTransport } from "@/stores/webmcp-inspector-store";
import type {
  WebMcpSessionPublic,
  WebMcpViewportTransport,
} from "@/shared/webmcp-inspector-protocol";

/**
 * The page's ORIGIN, and nothing else about the URL.
 *
 * This payload is built to be pasted into an issue, and every other part of a
 * URL is somewhere a secret is routinely found: a query string carries session
 * tokens and magic-link codes, `user:password@` carries a credential outright,
 * and a PATH carries reset tokens, share links and account ids —
 * `/reset/9f3c…`, `/u/48213`. The origin is what a viewport bug report
 * actually needs (which site, which scheme, which port), so that is what it
 * keeps.
 *
 * What was dropped is named rather than silently lost, so a reader is not left
 * wondering why this does not match their address bar. A URL that will not
 * parse says so instead of being passed through.
 */
function redactUrl(url: string | undefined): string | undefined {
  if (!url) return undefined;
  try {
    const parsed = new URL(url);
    const dropped: string[] = [];
    if (parsed.pathname && parsed.pathname !== "/") dropped.push("path");
    if (parsed.search) dropped.push("query");
    if (parsed.hash) dropped.push("fragment");
    if (parsed.username || parsed.password) dropped.push("credentials");
    return dropped.length > 0
      ? `${parsed.origin} [${dropped.join(", ")} redacted]`
      : parsed.origin;
  } catch {
    return "[unparseable url]";
  }
}

export interface WebMcpDiagnosticsInput {
  session: WebMcpSessionPublic | undefined;
  frameTransport: WebMcpFrameTransport;
  frame?:
    { deviceWidth: number; deviceHeight: number; seq: number } | undefined;
}

export interface WebMcpDiagnostics {
  sessionId?: string;
  status?: string;
  url?: string;
  viewportTransport?: WebMcpViewportTransport;
  /** Absent unless the provider has an adaptive stream. */
  streamQuality?: number;
  frameTransport: WebMcpFrameTransport;
  frame?: { deviceWidth: number; deviceHeight: number; seq: number };
  devicePixelRatio?: number;
  userAgent?: string;
  frameStats: FrameStatsReport;
  ts: number;
}

export function buildWebMcpDiagnostics(
  input: WebMcpDiagnosticsInput,
): WebMcpDiagnostics {
  const { session } = input;
  return {
    ...(session
      ? {
          sessionId: session.sessionId,
          status: session.status,
          url: redactUrl(session.url),
          viewportTransport: session.viewportTransport,
          ...(session.streamQuality !== undefined
            ? { streamQuality: session.streamQuality }
            : {}),
        }
      : {}),
    frameTransport: input.frameTransport,
    ...(input.frame ? { frame: input.frame } : {}),
    // The viewer's own two facts. The ratio is half of why a picture looks
    // soft, and the user agent is the other half of every "it's fine here"
    // reply.
    ...(typeof window !== "undefined"
      ? {
          devicePixelRatio: window.devicePixelRatio,
          userAgent: window.navigator?.userAgent,
        }
      : {}),
    // Empty unless the measurement flag is on, which is the honest answer:
    // absent numbers rather than made-up ones.
    frameStats: frameStatsReport(),
    ts: Date.now(),
  };
}

/**
 * Build the report and put it on the clipboard, telling the person which
 * happened.
 *
 * Branching on the copy's own result rather than assuming it worked: the
 * clipboard is refused often enough (permissions, an insecure origin, a
 * browser without the API) that a success toast for a copy that never happened
 * is a real way to lose someone's bug report.
 */
export async function copyWebMcpDiagnostics(
  input: WebMcpDiagnosticsInput,
): Promise<boolean> {
  const copied = await copyToClipboard(
    JSON.stringify(buildWebMcpDiagnostics(input), null, 2),
  );
  if (copied) toast.success("Viewport diagnostics copied");
  else toast.error("Could not copy the diagnostics to your clipboard");
  return copied;
}
