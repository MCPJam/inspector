/**
 * POST /input-ping: a person is using the hosted desktop through VNC.
 *
 * VNC input goes straight to the desktop and never past the relay, so the
 * control plane would otherwise count a desktop somebody is typing into as
 * idle and pause it. The pane sends this at most once a minute. It counts as
 * a command, which watching never does.
 */
import type { Context, Hono } from "hono";
import type { ComputerBrowserClaims } from "../../utils/computers/browser-token.js";
import { shouldTouchActivity } from "../../utils/computers/activity-touch.js";
import { reportRouteFailure } from "../../utils/route-error-report.js";

type InputPingAuth =
  | { ok: true; claims: ComputerBrowserClaims }
  | { ok: false; status: 401 | 503; error: string };

export function registerBrowserInputPing(
  app: Hono,
  deps: {
    authorize: (c: Context) => Promise<InputPingAuth>;
    currentSession: (
      claims: ComputerBrowserClaims,
    ) => Promise<{ sessionId: string } | null>;
    touchSession: (args: {
      sessionId: string;
      kind: "command";
    }) => Promise<{ counted: boolean }>;
    touchActivity: (args: { computerId: string }) => Promise<void>;
  },
): void {
  app.post("/input-ping", async (c) => {
    const auth = await deps.authorize(c);
    if (!auth.ok) return c.json({ ok: false, error: auth.error }, auth.status);
    try {
      const session = await deps.currentSession(auth.claims);
      if (!session) {
        return c.json({ ok: false, error: "no_browser_session" }, 409);
      }
      const { counted } = await deps.touchSession({
        sessionId: session.sessionId,
        kind: "command",
      });
      const { computerId } = auth.claims;
      if (computerId && shouldTouchActivity(computerId)) {
        // As the keepalive does: a failed touch only risks an earlier pause.
        void deps.touchActivity({ computerId });
      }
      return c.json({ ok: true, counted });
    } catch (error) {
      reportRouteFailure("browser panel input ping failed", error, {
        source: "computer-browser-panel.input-ping",
        hop: "mcpjam_internal",
      });
      return c.json(
        {
          ok: false,
          error: "Could not record browser input. Try again in a moment.",
        },
        502,
      );
    }
  });
}
