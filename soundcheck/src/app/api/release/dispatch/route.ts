/**
 * POST /api/release/dispatch
 *
 * Server route for the Run Release button. Dispatches `release.yml` on
 * `main` with the three form inputs. Re-checks WorkOS sign-in + lockdown
 * server-side (defense in depth — the middleware already blocks
 * unauthenticated calls) before exposing the write-scoped PAT.
 *
 * Write auth:
 *   - Reads `GITHUB_DISPATCH_PAT` (separate from the read-only `GITHUB_PAT`).
 *   - Must be a fine-grained token scoped to `MCPJam/inspector` only with
 *     `actions:write`.
 *
 * Audit:
 *   - Logs the signed-in email + dispatched inputs to stdout. Railway
 *     retains these in its log viewer, and WorkOS retains the sign-in
 *     side. A GitHub-App-based per-user token flow would give us a
 *     `actor.login` in the workflow_run itself; that's the v2 upgrade.
 */

import { NextResponse } from "next/server";
import { withAuth } from "@workos-inc/authkit-nextjs";
import { isAllowedEmployeeEmail, isLockdownEnabled } from "@/lib/lockdown";
import { dispatchWorkflow } from "@/lib/github";

export const dynamic = "force-dynamic";

type Scope = "packages-only" | "inspector-only" | "full";

interface DispatchBody {
  scope: Scope;
  deploy_backend_prod: boolean;
  promote_production: boolean;
}

function isScope(value: unknown): value is Scope {
  return (
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
  return {
    scope: body.scope,
    deploy_backend_prod: body.deploy_backend_prod,
    promote_production: body.promote_production
  };
}

export async function POST(request: Request) {
  // ── 1. Re-enforce lockdown server-side ──────────────────────────────
  const { user } = await withAuth({ ensureSignedIn: true });
  if (isLockdownEnabled() && !isAllowedEmployeeEmail(user.email)) {
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
          "Expected { scope, deploy_backend_prod, promote_production } with valid values"
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

  // ── 4. Audit log (Railway stdout + WorkOS sign-in covers the who) ───
  console.info(
    JSON.stringify({
      event: "soundcheck.release.dispatch",
      email: user.email,
      scope: parsed.scope,
      deploy_backend_prod: parsed.deploy_backend_prod,
      promote_production: parsed.promote_production
    })
  );

  // ── 5. Dispatch ─────────────────────────────────────────────────────
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
  } catch (err) {
    return NextResponse.json(
      { error: (err as Error).message },
      { status: 502 }
    );
  }

  return NextResponse.json({
    ok: true,
    message:
      "release.yml dispatched. The progress tile will pick up the new run within ~10s."
  });
}
