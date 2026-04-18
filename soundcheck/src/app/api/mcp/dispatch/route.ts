/**
 * POST /api/mcp/dispatch
 *
 * Server route for the "Deploy MCP production" button. Dispatches
 * `deploy-mcp-prod.yml` on `main`. Re-checks WorkOS sign-in + employee
 * email gate server-side before exposing the write-scoped PAT.
 *
 * Why a separate route from /api/release/dispatch:
 *   - MCP is never part of release.yml's scope (it's ignored by Changesets
 *     and deploys via its own Cloudflare pipeline). Conflating the two
 *     would either force MCP into the release-plan contract or pollute
 *     the release dispatch route with non-release concerns.
 *   - Auditing is cleaner: `event: "soundcheck.mcp.dispatch"` is unique
 *     enough to filter on in Railway logs without snarls of string parsing.
 *
 * Write auth:
 *   - Reuses `GITHUB_DISPATCH_PAT`. The existing PAT is already scoped to
 *     MCPJam/inspector with `actions:write`, which covers any workflow in
 *     the repo — no new token is needed.
 *
 * Reviewer gate:
 *   - Lives on the `mcp-production` GitHub Environment in repo settings,
 *     not here. If configured, GitHub holds the dispatched run pending
 *     approval; this route's response still returns `ok: true` because
 *     dispatch succeeded — the operator watches the progress in GH Actions
 *     (or, eventually, a Soundcheck progress tile for this workflow).
 */

import { NextResponse } from "next/server";
import { withAuth } from "@workos-inc/authkit-nextjs";
import { isAllowedEmployeeEmail } from "@/lib/lockdown";
import { dispatchWorkflow } from "@/lib/github";

export const dynamic = "force-dynamic";

/**
 * Sentinel the in-app form sends. Required before auth. Catches a CSRF
 * vector where a logged-in employee visits a malicious site that POSTs
 * to this route — WorkOS AuthKit cookies with SameSite=None (used for
 * cross-subdomain flows) would otherwise be attached to the request and
 * pass `withAuth`. A plain HTML form can't set custom request headers,
 * and a cross-origin `fetch` sending custom headers triggers a CORS
 * preflight against this origin (which would fail), so requiring the
 * header effectively restricts callers to same-origin JS.
 */
const EXPECTED_DISPATCH_HEADER = "x-soundcheck-action";
const EXPECTED_DISPATCH_VALUE = "mcp-prod-dispatch";

export async function POST(request: Request) {
  // ── 0. Same-origin guard (cheap defense-in-depth) ───────────────────
  if (
    request.headers.get(EXPECTED_DISPATCH_HEADER) !== EXPECTED_DISPATCH_VALUE
  ) {
    return NextResponse.json(
      { error: "Invalid dispatch request" },
      { status: 403 }
    );
  }

  // ── 1. Enforce employee-only — unconditionally ──────────────────────
  // Same posture as /api/release/dispatch: this hands out a write-scoped
  // PAT to dispatch a production deploy. MCPJAM_NONPROD_LOCKDOWN being
  // flipped off must not open this to every WorkOS tenant user.
  const { user } = await withAuth({ ensureSignedIn: true });
  let allowed = false;
  try {
    allowed = isAllowedEmployeeEmail(user.email);
  } catch (err) {
    console.error("mcp dispatch route: lockdown misconfigured:", err);
    return NextResponse.json(
      { error: "Server lockdown env not configured" },
      { status: 500 }
    );
  }
  if (!allowed) {
    return NextResponse.json({ error: "Not authorized" }, { status: 403 });
  }

  // ── 2. Require the write PAT to be configured ───────────────────────
  const writeToken = process.env.GITHUB_DISPATCH_PAT;
  if (!writeToken) {
    return NextResponse.json(
      {
        error:
          "GITHUB_DISPATCH_PAT not configured on the server. Set a fine-grained PAT with actions:write on MCPJam/inspector."
      },
      { status: 500 }
    );
  }

  // ── 3. Audit log ────────────────────────────────────────────────────
  console.info(
    JSON.stringify({
      event: "soundcheck.mcp.dispatch",
      email: user.email,
      workflow: "deploy-mcp-prod.yml"
    })
  );

  // ── 4. Dispatch ─────────────────────────────────────────────────────
  try {
    await dispatchWorkflow(
      "MCPJam",
      "inspector",
      "deploy-mcp-prod.yml",
      "main",
      {},
      writeToken
    );
  } catch (err) {
    console.error("mcp dispatch route: workflow dispatch failed:", err);
    return NextResponse.json(
      {
        error:
          "Failed to dispatch deploy-mcp-prod.yml. Check Soundcheck server logs for details."
      },
      { status: 502 }
    );
  }

  return NextResponse.json({
    ok: true,
    message:
      "deploy-mcp-prod.yml dispatched. Watch the run in GitHub Actions; the MCP tile will reflect the new live SHA after deploy completes."
  });
}
