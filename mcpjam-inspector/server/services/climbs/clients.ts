/**
 * The clients a climb's environments run: MCPJam's own loop, or a harness client.
 * It is what the table of what each client reads is judged against.
 */
import type { ConvexHttpClient } from "convex/browser";
import type { ClimbClient } from "@mcpjam/sdk/climbs";
import type { PlatformClimb } from "@mcpjam/sdk/platform";
import { loadSuiteHostConfig } from "../evals/compat-runtime.js";
import { harnessOfHostConfig } from "../evals/harness-admission.js";
import { EVAL_LAUNCH_SERVER_SOURCE, resolveEnvironmentForLaunch } from "../environments/resolve.js";

function harnessClient(value: string | undefined): ClimbClient | undefined {
  switch (value) {
    case "claude-code":
    case "codex":
    case "cursor":
    case "copilot-cli":
    case "opencode":
      return value;
    default:
      return undefined;
  }
}

export async function clientsOfClimb(
  convex: ConvexHttpClient,
  climb: Pick<PlatformClimb, "projectId" | "suiteId" | "environmentIds">,
): Promise<ClimbClient[]> {
  const clients = new Set<ClimbClient>();
  for (const environmentId of climb.environmentIds) {
    const environment = await resolveEnvironmentForLaunch(convex, {
      serverSource: EVAL_LAUNCH_SERVER_SOURCE,
      projectId: climb.projectId,
      environmentId,
    });
    const harness = harnessOfHostConfig(await loadSuiteHostConfig(convex, climb.suiteId, environment.hostId));
    clients.add(harnessClient(harness) ?? "mcpjam");
  }
  return [...clients];
}
