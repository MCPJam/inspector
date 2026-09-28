/**
 * POST /api/release/dispatch
 *
 * Single dispatch route for every production deploy Soundcheck triggers:
 *
 *   - action "start": prepare-release.yml, which opens the version PR.
 *     Merging that PR is the release; release-trigger.yml runs release.yml
 *     once main is green.
 *   - action "publish": release.yml directly. The retry path, for versions
 *     already merged whose automatic run failed or never started.
 *   - deploy-mcp-prod.yml when deploy_mcp_production === true, alongside
 *     either or on its own (action "none").
 *
 * Re-checks WorkOS sign-in + lockdown server-side (defense in depth — the
 * middleware already blocks unauthenticated calls) before exposing the
 * write-scoped PAT.
 *
 * Write auth:
 *   - Reads `GITHUB_PAT` (same fine-grained token used for reads).
 *   - Scoped to `MCPJam/inspector` with `actions:read/write`. The same
 *     token covers every workflow — no separate MCP token needed.
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

type Action = "start" | "publish" | "none";

const ACTION_WORKFLOW: Record<Action, string | null> = {
  start: "prepare-release.yml",
  publish: "release.yml",
  none: null
};

interface DispatchBody {
  action: Action;
  deploy_backend_prod: boolean;
  deploy_webapp: boolean;
  deploy_mcp_production: boolean;
  skip_verify: boolean;
}

function isAction(value: unknown): value is Action {
  return value === "start" || value === "publish" || value === "none";
}

function parseBody(raw: unknown): DispatchBody | null {
  if (!raw || typeof raw !== "object") return null;
  const body = raw as Record<string, unknown>;
  if (!isAction(body.action)) return null;
  if (typeof body.deploy_backend_prod !== "boolean") return null;
  if (typeof body.deploy_webapp !== "boolean") return null;
  if (typeof body.deploy_mcp_production !== "boolean") return null;
  if (
    body.skip_verify !== undefined &&
    typeof body.skip_verify !== "boolean"
  ) {
    return null;
  }
  return {
    action: body.action,
    deploy_backend_prod: body.deploy_backend_prod,
    deploy_webapp: body.deploy_webapp,
    deploy_mcp_production: body.deploy_mcp_production,
    skip_verify: body.skip_verify ?? false
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
          "Expected { action, deploy_backend_prod, deploy_webapp, deploy_mcp_production } with optional boolean skip_verify"
      },
      { status: 400 }
    );
  }

  const releaseWorkflow = ACTION_WORKFLOW[parsed.action];
  const runsMcp = parsed.deploy_mcp_production;
  // Only release.yml has preflight gates to skip; prepare-release.yml opens a
  // PR, which runs every check anyway.
  const effectiveSkipVerify = parsed.action === "publish" && parsed.skip_verify;
  if (!releaseWorkflow && !runsMcp) {
    return NextResponse.json(
      {
        error:
          "Nothing selected: pick a release action or enable deploy_mcp_production."
      },
      { status: 400 }
    );
  }

  // ── 3. Require the PAT to be configured ─────────────────────────────
  const writeToken = process.env.GITHUB_PAT;
  if (!writeToken) {
    return NextResponse.json(
      {
        error:
          "GITHUB_PAT not configured on the server. Set a fine-grained PAT with actions:read/write on MCPJam/inspector."
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
  // user/action are ambiguous in the log stream.
  const dispatchId = crypto.randomUUID();
  const attemptedWorkflows = [
    releaseWorkflow,
    runsMcp ? "deploy-mcp-prod.yml" : null
  ].filter(Boolean) as string[];
  console.info(
    JSON.stringify({
      event: "soundcheck.release.dispatch.attempt",
      dispatch_id: dispatchId,
      email: user.email,
      action: parsed.action,
      deploy_backend_prod: parsed.deploy_backend_prod,
      deploy_webapp: parsed.deploy_webapp,
      deploy_mcp_production: parsed.deploy_mcp_production,
      skip_verify: effectiveSkipVerify,
      workflows_attempted: attemptedWorkflows
    })
  );

  // ── 5. Dispatch ─────────────────────────────────────────────────────
  // Fire each workflow independently. If one dispatch fails and the other
  // succeeded, we report partial success so the operator knows the state
  // of the world — silently dropping the error would leave them thinking
  // both fired when only one did.
  const results: { workflow: string; ok: boolean; error?: string }[] = [];

  if (releaseWorkflow) {
    // Workflow dispatch inputs go over the wire as strings. The deploy flags
    // mean the same thing to both workflows: prepare-release.yml writes them
    // into the version PR as checkboxes, release.yml acts on them directly.
    const inputs: Record<string, string> = {
      deploy_backend_prod: String(parsed.deploy_backend_prod),
      deploy_webapp: String(parsed.deploy_webapp)
    };
    if (parsed.action === "publish") {
      inputs.skip_verify = String(effectiveSkipVerify);
    }
    try {
      await dispatchWorkflow(
        "MCPJam",
        "inspector",
        releaseWorkflow,
        "main",
        inputs,
        writeToken
      );
      results.push({ workflow: releaseWorkflow, ok: true });
    } catch (err) {
      console.error(`dispatch route: ${releaseWorkflow} dispatch failed:`, err);
      results.push({
        workflow: releaseWorkflow,
        ok: false,
        error: `Failed to dispatch ${releaseWorkflow}`
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
  // inputs (not just action) to stay self-contained without having to
  // join against the attempt entry.
  console.info(
    JSON.stringify({
      event: "soundcheck.release.dispatch.outcome",
      dispatch_id: dispatchId,
      email: user.email,
      action: parsed.action,
      deploy_backend_prod: parsed.deploy_backend_prod,
      deploy_webapp: parsed.deploy_webapp,
      deploy_mcp_production: parsed.deploy_mcp_production,
      skip_verify: effectiveSkipVerify,
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
    : parsed.action === "start"
      ? `${successLabel} dispatched. The version PR opens in about a minute; merging it releases.`
      : `${successLabel} dispatched. The progress tile will pick it up within ~10s.`;

  return NextResponse.json({
    ok: true,
    partial: failed.length > 0,
    message
  });
}
