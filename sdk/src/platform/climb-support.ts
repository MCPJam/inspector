/**
 * What every climb operation shares: the selectors it takes, the numbers it
 * converts, and the result's project block. Operations take percents and names;
 * the routes take whole basis points and ids.
 */
import { z } from "zod";
import type { PlatformApiClient } from "./client.js";
import {
  PROJECT_SELECTOR_DESCRIPTION,
  resolveProjectOrThrow,
  resolveSavedServer,
  toSelectedProjectInfo,
} from "./operation-support.js";
import { resolveByIdOrName } from "./resource-selectors.js";
import type { PlatformOperationContext } from "./operations.js";
import type { PlatformProject } from "./types.js";
import type { SelectedProjectInfo } from "./show-servers.js";

export const text = z.string().trim().min(1);
export const projectInput = text.optional().describe(PROJECT_SELECTOR_DESCRIPTION);
export const climbInput = text.describe("The climb's ID, as `start_climb` and `list_climbs` return it.");
export const measureInput = z.enum(["pass_rate", "tokens", "cost", "tool_calls"]);

export type ClimbContext = Pick<PlatformOperationContext, "client" | "signal" | "onScopeResolved">;
export type WithProject<T> = T & { project: SelectedProjectInfo };

/** A percent as whole basis points: 1 is 1%, which is 100. */
export const percentToBps = (percent: number): number => Math.round(percent * 100);

export async function resolveClimbProject(context: ClimbContext, selector: string | undefined) {
  const { project } = await resolveProjectOrThrow(context, selector);
  return { project, info: toSelectedProjectInfo(project) };
}

export async function resolveSuiteId(
  client: PlatformApiClient,
  project: PlatformProject,
  selector: string,
  signal: AbortSignal | undefined
): Promise<string> {
  const page = await client.listEvalSuites({ projectId: project.id }, { signal });
  return resolveByIdOrName(page.items, selector, "Eval suite", `project "${project.name}"`).id;
}

export async function resolveServerId(
  client: PlatformApiClient,
  project: PlatformProject,
  selector: string,
  signal: AbortSignal | undefined
): Promise<string> {
  return (await resolveSavedServer(client, project, selector, signal)).id;
}

export async function resolveEnvironmentIds(
  client: PlatformApiClient,
  project: PlatformProject,
  selectors: readonly string[],
  signal: AbortSignal | undefined
): Promise<string[]> {
  const page = await client.listEnvironments({ projectId: project.id }, { signal });
  return selectors.map(
    (selector) => resolveByIdOrName(page.items, selector, "Environment", `project "${project.name}"`).id
  );
}
