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
 * The page's identity, without anything that identifies a PERSON.
 *
 * Origin and path only: a query string is where session tokens, magic-link
 * codes and one-time secrets live, and this payload is built to be pasted into
 * an issue. `URL` also drops any `user:password@` on the way through, which is
 * the other place a credential hides. A URL that will not parse is reported as
 * the fact that it did not rather than passed through as-is.
 */
function redactUrl(url: string | undefined): string | undefined {
  if (!url) return undefined;
  try {
    const parsed = new URL(url);
    const trimmed = `${parsed.origin}${parsed.pathname}`;
    // Say that something was dropped, so a reader is not left wondering why
    // the URL in the report does not match the one in the address bar.
    return parsed.search || parsed.hash
      ? `${trimmed} [query redacted]`
      : trimmed;
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
