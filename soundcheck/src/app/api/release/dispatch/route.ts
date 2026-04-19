/**
 * POST /api/release/dispatch
 *
 * Single dispatch route for every production deploy Soundcheck triggers:
 *
 *   - release.yml when scope !== "none"
 *   - deploy-mcp-prod.yml when deploy_mcp_production === true
 *   - both, if the form asked for both
 *
 * Re-checks WorkOS sign-in + lockdown server-side (defense in depth — the
 * middleware already blocks unauthenticated calls) before exposing the
 * write-scoped PAT.
 *
 * Write auth:
 *   - Reads `GITHUB_DISPATCH_PAT` (separate from the read-only `GITHUB_PAT`).
 *   - Fine-grained, scoped to `MCPJam/inspector` with `actions:write`. The
 *     same token covers both workflows — no separate MCP token needed.
 *
 * Audit:
 *   - Logs the signed-in email + dispatched inputs + which workflows fired
 *     to stdout. Railway retains these; WorkOS retains the sign-in side.
 *
 * Reviewer gate for MCP production:
 *   - Lives on the `mcp-production` GitHub Environment. If configured,
 *     GitHub holds the dispatched run pending approval; this route still
 *     returns ok: true because *dispatch* succeeded.
 */

import { NextResponse } from "next/server";
import { withAuth } from "@workos-inc/authkit-nextjs";
import { isAllowedEmployeeEmail } from "@/lib/lockdown";
import { dispatchWorkflow } from "@/lib/github";

export const dynamic = "force-dynamic";

/**
 * Same-origin sentinel. A plain HTML form (the classic CSRF vector)
 * can't set custom request headers, and a cross-origin `fetch` with a
 * custom header triggers a CORS preflight against this origin — which
 * this route doesn't respond to, so the browser blocks the request.
 * WorkOS AuthKit cookies with SameSite=None would otherwise attach to
 * cross-site POSTs, so `withAuth` alone isn't sufficient.
 */
const EXPECTED_DISPATCH_HEADER = "x-soundcheck-action";
const EXPECTED_DISPATCH_VALUE = "release-dispatch";

type Scope = "none" | "packages-only" | "inspector-only" | "full";

interface DispatchBody {
  scope: Scope;
  deploy_backend_prod: boolean;
  promote_production: boolean;
  deploy_mcp_production: boolean;
}

function isScope(value: unknown): value is Scope {
  return (
    value === "none" ||
    value === "packages-only" ||
    value === "inspector-only" ||
    value === "full"
  );
}

function parseBody(raw: unknown): DispatchBody | null {
  if (!raw || typeof raw !== "object") return null;
  const body = raw as Record<string, unknown>;
  if (!isScope(body.scope)) return null;
  if (typeof body.deploy_backend_prod !== "boolean") return null;
  if (typeof body.promote_production !== "boolean") return null;
  if (typeof body.deploy_mcp_production !== "boolean") return null;
  return {
    scope: body.scope,
    deploy_backend_prod: body.deploy_backend_prod,
    promote_production: body.promote_production,
    deploy_mcp_production: body.deploy_mcp_production
  };
}

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
  // Unlike the read tiles (which follow the MCPJAM_NONPROD_LOCKDOWN flag),
  // this route hands out the write-scoped PAT and dispatches production.
  // A forgotten/flipped lockdown env var must NOT open it up to every
  // WorkOS tenant user. The employee-email gate is required regardless of
  // lockdown mode.
  const { user } = await withAuth({ ensureSignedIn: true });
  let allowed = false;
  try {
    allowed = isAllowedEmployeeEmail(user.email);
  } catch (err) {
    console.error("dispatch route: lockdown misconfigured:", err);
    return NextResponse.json(
      { error: "Server lockdown env not configured" },
      { status: 500 }
    );
  }
  if (!allowed) {
    return NextResponse.json({ error: "Not authorized" }, { status: 403 });
  }

  // ── 2. Parse + validate body ────────────────────────────────────────
  let raw: unknown;
  try {
    raw = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }
  const parsed = parseBody(raw);
  if (!parsed) {
    return NextResponse.json(
      {
        error:
          "Expected { scope, deploy_backend_prod, promote_production, deploy_mcp_production } with valid values"
      },
      { status: 400 }
    );
  }

  const runsRelease = parsed.scope !== "none";
  const runsMcp = parsed.deploy_mcp_production;
  if (!runsRelease && !runsMcp) {
    return NextResponse.json(
      {
        error:
          "Nothing selected: pick a scope or enable deploy_mcp_production."
      },
      { status: 400 }
    );
  }

  // ── 3. Require the write PAT to be configured ───────────────────────
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

  // ── 4. Audit log (intent) ───────────────────────────────────────────
  // Recorded *before* dispatch so we still have an audit trail if the
  // server crashes mid-flight. A second entry after dispatch carries the
  // actual outcome — anything reasoning about what *landed* should read
  // the "outcome" event, not this one. `dispatch_id` ties the two
  // entries together; without it, concurrent dispatches from the same
  // user/scope are ambiguous in the log stream.
  const dispatchId = crypto.randomUUID();
  const attemptedWorkflows = [
    runsRelease ? "release.yml" : null,
    runsMcp ? "deploy-mcp-prod.yml" : null
  ].filter(Boolean) as string[];
  console.info(
    JSON.stringify({
      event: "soundcheck.release.dispatch.attempt",
      dispatch_id: dispatchId,
      email: user.email,
      scope: parsed.scope,
      deploy_backend_prod: parsed.deploy_backend_prod,
      promote_production: parsed.promote_production,
      deploy_mcp_production: parsed.deploy_mcp_production,
      workflows_attempted: attemptedWorkflows
    })
  );

  // ── 5. Dispatch ─────────────────────────────────────────────────────
  // Fire each workflow independently. If one dispatch fails and the other
  // succeeded, we report partial success so the operator knows the state
  // of the world — silently dropping the error would leave them thinking
  // both fired when only one did.
  const results: { workflow: string; ok: boolean; error?: string }[] = [];

  if (runsRelease) {
    try {
      await dispatchWorkflow(
        "MCPJam",
        "inspector",
        "release.yml",
        "main",
        {
          scope: parsed.scope,
          // Workflow dispatch inputs go over the wire as strings.
          deploy_backend_prod: String(parsed.deploy_backend_prod),
          promote_production: String(parsed.promote_production)
        },
        writeToken
      );
      results.push({ workflow: "release.yml", ok: true });
    } catch (err) {
      console.error("dispatch route: release.yml dispatch failed:", err);
      results.push({
        workflow: "release.yml",
        ok: false,
        error: "Failed to dispatch release.yml"
      });
    }
  }

  if (runsMcp) {
    try {
      await dispatchWorkflow(
        "MCPJam",
        "inspector",
        "deploy-mcp-prod.yml",
        "main",
        {},
        writeToken
      );
      results.push({ workflow: "deploy-mcp-prod.yml", ok: true });
    } catch (err) {
      console.error(
        "dispatch route: deploy-mcp-prod.yml dispatch failed:",
        err
      );
      results.push({
        workflow: "deploy-mcp-prod.yml",
        ok: false,
        error: "Failed to dispatch deploy-mcp-prod.yml"
      });
    }
  }

  const failed = results.filter((r) => !r.ok);
  const succeeded = results.filter((r) => r.ok);

  // ── 6. Audit log (outcome) ──────────────────────────────────────────
  // Use a distinct event key so log queries looking for *what actually
  // landed* don't collide with the intent entry above. Anyone reasoning
  // about ground truth reads this one — so it carries the full set of
  // inputs (not just scope) to stay self-contained without having to
  // join against the attempt entry.
  console.info(
    JSON.stringify({
      event: "soundcheck.release.dispatch.outcome",
      dispatch_id: dispatchId,
      email: user.email,
      scope: parsed.scope,
      deploy_backend_prod: parsed.deploy_backend_prod,
      promote_production: parsed.promote_production,
      deploy_mcp_production: parsed.deploy_mcp_production,
      workflows_attempted: attemptedWorkflows,
      workflows_succeeded: succeeded.map((r) => r.workflow),
      workflows_failed: failed.map((r) => r.workflow)
    })
  );

  if (failed.length === results.length) {
    return NextResponse.json(
      {
        error:
          "All dispatches failed. Check Soundcheck server logs for details."
      },
      { status: 502 }
    );
  }

  const successLabel = succeeded.map((r) => r.workflow).join(" + ");
  const failedLabel = failed.map((r) => r.workflow).join(", ");
  const message = failed.length
    ? `${successLabel} dispatched. ${failedLabel} failed — check Soundcheck server logs.`
    : `${successLabel} dispatched. The progress tile will pick it up within ~10s.`;

  return NextResponse.json({
    ok: true,
    partial: failed.length > 0,
    message
  });
}
