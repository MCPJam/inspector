/**
 * Thin client for the backend `computerEnvironments` runtime-context queries
 * (blueprint `knowledge` / `maintenance` delivery for chat surfaces).
 *
 * Follows the established inspector→Convex pattern (`ConvexHttpClient` +
 * string function names + local DTOs, like `convex-skills-client.ts`): no
 * generated-type codegen dependency, so the inspector builds independently of
 * the backend. All gating (membership, execution scope, computer capability)
 * lives in Convex — this is a transport shim.
 */
import { ConvexHttpClient } from "convex/browser";
import type { ExecutionScope } from "../execution-scope.js";

/**
 * A pinned environment's model-facing text: the image name, its `knowledge`
 * entries (verbatim), and its `maintenance` commands (surfaced for the agent
 * to run itself — never auto-executed). `null` whenever there is nothing to
 * inject (base-image computer, no pin, no runtime sections).
 */
export interface EnvironmentRuntimeContext {
  imageName: string;
  knowledge: { name: string; contents: string }[];
  maintenance: { name?: string; run: string }[];
}

/** Convex query names — kept in one place so a rename is one edit. */
const FN = {
  computerStatus: "projectComputers:getComputerStatus",
  runtimeContext: "computerEnvironments:getEnvironmentRuntimeContext",
  // Execution-scoped variant (reachable by guests / swarm grants). Keyed on an
  // opaque executionScope the backend re-resolves — never a raw projectId.
  runtimeContextExecution:
    "computerEnvironments:getEnvironmentRuntimeContextForExecution",
} as const;

function stripBearer(token: string): string {
  return token.replace(/^Bearer\s+/i, "").trim();
}

/**
 * A caller's bearer may only travel over an encrypted connection.
 *
 * `setAuth` puts the token on every request this client makes, so a
 * `CONVEX_URL` of `http://` would put a live user credential on the wire in
 * cleartext. Loopback is the one exception, and a real one: `convex dev` runs
 * a local backend on `http://127.0.0.1:3210`, and refusing it would break
 * every local developer to defend a hop that never leaves the machine.
 */
function assertSafeTransport(url: string): void {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error("CONVEX_URL is not a valid URL");
  }
  if (parsed.protocol === "https:") return;
  const loopback =
    parsed.hostname === "localhost" ||
    parsed.hostname === "127.0.0.1" ||
    parsed.hostname === "::1" ||
    parsed.hostname === "[::1]";
  if (parsed.protocol === "http:" && loopback) return;
  throw new Error(
    "CONVEX_URL must use https (or loopback http): refusing to send a user bearer in cleartext",
  );
}

function makeClient(bearer: string): ConvexHttpClient {
  const url = process.env.CONVEX_URL;
  if (!url) {
    throw new Error("CONVEX_URL is not configured");
  }
  assertSafeTransport(url);
  const client = new ConvexHttpClient(url);
  client.setAuth(stripBearer(bearer));
  return client;
}

export async function convexGetEnvironmentRuntimeContext(
  bearer: string,
  projectId: string,
): Promise<EnvironmentRuntimeContext | null> {
  return await makeClient(bearer).query(FN.runtimeContext as any, {
    projectId,
  });
}

export async function convexGetEnvironmentRuntimeContextForExecution(
  bearer: string,
  executionScope: ExecutionScope,
): Promise<EnvironmentRuntimeContext | null> {
  return await makeClient(bearer).query(FN.runtimeContextExecution as any, {
    executionScope,
  });
}

/**
 * What the caller's desktop computer is doing, WITHOUT touching it.
 *
 * The read that makes a hosted inspector session re-derivable. A request may
 * land on a replica that has never seen the session; before that replica will
 * adopt the browser, it asks the control plane — with the caller's own bearer,
 * so the answer is authoritative about ownership — which computer this project
 * has and whether it is awake.
 *
 * It must stay a QUERY. Reserve wakes a hibernated machine and starts billing
 * it, and doing that from a `GET` would mean a browser tab left open overnight
 * silently resurrects a computer the owner deliberately let sleep. An asleep
 * machine is reported, never woken; waking is what the explicit start does.
 *
 * `null` ⇒ this project has no desktop computer at all.
 */
export interface DesktopComputerStatus {
  computerId: string;
  status: string;
}

export async function convexGetDesktopComputerStatus(
  bearer: string,
  projectId: string,
): Promise<DesktopComputerStatus | null> {
  const view = (await makeClient(bearer).query(FN.computerStatus as any, {
    projectId,
    runtimeKind: "desktop-browser",
  })) as { computerId?: unknown; status?: unknown } | null;
  if (!view || typeof view.computerId !== "string") return null;
  return {
    computerId: view.computerId,
    status: typeof view.status === "string" ? view.status : "unknown",
  };
}
