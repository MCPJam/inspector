/**
 * A hosted deploy with no sandbox origin is a SECURITY REGRESSION, not a
 * config nicety.
 *
 * `VITE_MCPJAM_SANDBOX_ORIGIN` is what puts MCP Apps widgets on an origin that
 * shares no cookies with the host app. Unset, the iframe falls back to
 * same-origin and the isolation the sandbox exists to provide is simply gone.
 *
 * `widget-react` already warns — but it warns from inside a shared package, at
 * RENDER time, on a `console.warn` nobody is watching, and only for a user who
 * happens to open a widget. Reporting it at BOOT means it is noticed once, by
 * whoever deployed it, through the channel that pages someone.
 *
 * Deliberately non-fatal: refusing to start would take the whole app down over
 * a widget-isolation setting, which is a worse outcome than a loud deploy.
 *
 * THE ONLY CASE A BROWSER CAN DECIDE IS "unset". A configured value equal to
 * `window.location.origin` produces the same same-origin iframe — but the page
 * cannot tell a deploy that pointed its sandbox at itself apart from the app
 * being loaded on the sandbox hostname, where the two are equal by definition.
 * Both look identical from inside the tab; only the deploy knows which
 * hostname it was supposed to be served as. A crawler walking our DNS names
 * proved the point by paging us with the benign one (INSPECTOR-CLIENT-247), so
 * that half of the invariant now lives on the server — see
 * `server/middleware/sandbox-host-partition.ts`.
 *
 * REPORTED ONCE PER TAB. This is a deployment fault, and it is true for every
 * visitor for as long as the deploy lives: capturing on each load turns one
 * static misconfiguration into an exception per page view (and, with replay on,
 * a session recording per visitor), which buries the signal it is meant to
 * raise. `sessionStorage` bounds it to one report per tab without needing
 * anything server-side. The console line stays unconditional — it costs
 * nothing and it is what a developer looking at THIS page load will see.
 */

const REPORTED_KEY = "mcpjam.sandbox-origin-fault-reported";

const MESSAGE =
  "VITE_MCPJAM_SANDBOX_ORIGIN is not configured in hosted mode. MCP Apps widgets will render SAME-ORIGIN with the host app, losing the cookie/storage isolation the sandbox provides.";

type SessionFlagStorage = Pick<Storage, "getItem" | "setItem">;

export interface SandboxOriginFault {
  message: string;
  /** False once this tab has reported; the console line runs either way. */
  shouldCapture: boolean;
}

export function detectSandboxOriginFault({
  hostedMode,
  sandboxOrigin,
  getStorage = () => window.sessionStorage,
}: {
  hostedMode: boolean;
  sandboxOrigin: string | null;
  /** Where the once-per-tab flag lives. */
  getStorage?: () => SessionFlagStorage;
}): SandboxOriginFault | null {
  if (!hostedMode || sandboxOrigin) {
    return null;
  }

  let alreadyReported = false;
  try {
    const storage = getStorage();
    alreadyReported = storage.getItem(REPORTED_KEY) === "1";
    storage.setItem(REPORTED_KEY, "1");
  } catch {
    // Storage can be unavailable (Safari private mode, a blocked third-party
    // context). Reporting every load is the safe direction for a security
    // regression — better noisy than silent.
  }

  return { message: MESSAGE, shouldCapture: !alreadyReported };
}
