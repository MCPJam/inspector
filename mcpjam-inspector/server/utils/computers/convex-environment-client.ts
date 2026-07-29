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
  runtimeContext: "computerEnvironments:getEnvironmentRuntimeContext",
  // Execution-scoped variant (reachable by guests / swarm grants). Keyed on an
  // opaque executionScope the backend re-resolves — never a raw projectId.
  runtimeContextExecution:
    "computerEnvironments:getEnvironmentRuntimeContextForExecution",
} as const;

function stripBearer(token: string): string {
  return token.replace(/^Bearer\s+/i, "").trim();
}

function makeClient(bearer: string): ConvexHttpClient {
  const url = process.env.CONVEX_URL;
  if (!url) {
    throw new Error("CONVEX_URL is not configured");
  }
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
