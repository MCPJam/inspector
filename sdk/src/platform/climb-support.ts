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
import { PlatformApiError } from "./errors.js";
import { formatResourceList, resolutionError, resolveByIdOrName } from "./resource-selectors.js";
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

/**
 * The suite's environments a climb runs in, by the id the suite shows or by name.
 *
 * The id a suite lists for an attached environment is accepted as it is: the
 * project's environment list leaves out the unnamed environments a composed
 * run attaches, so resolving only against that list refused ids the suite had
 * just shown ("project has none"). A name or an id the suite does not list
 * still resolves against the project's named environments, and one that
 * matches neither says which ids the suite has.
 */
export async function resolveEnvironmentIds(
  client: PlatformApiClient,
  project: PlatformProject,
  suiteId: string,
  selectors: readonly string[],
  signal: AbortSignal | undefined
): Promise<string[]> {
  const [suite, page] = await Promise.all([
    client.getEvalSuite({ projectId: project.id, suiteId }, { signal }),
    client.listEnvironments({ projectId: project.id }, { signal }),
  ]);
  const attached = suite.environmentIds ?? [];
  return selectors.map((raw) => {
    const selector = raw.trim();
    if (attached.includes(selector)) return selector;
    try {
      return resolveByIdOrName(page.items, selector, "Environment", `project "${project.name}"`).id;
    } catch (error) {
      if (!(error instanceof PlatformApiError) || error.code !== "NOT_FOUND") throw error;
      const names = new Map(page.items.map((item) => [item.id, item.name]));
      const have = attached.length
        ? `The suite's attached environments are: ${formatResourceList(
            attached.map((id) => ({ id, name: names.get(id) }))
          )}.`
        : "The suite has no attached environments. Attach one, then start the climb.";
      throw resolutionError(
        `Environment "${selector}" was not found among this suite's environments or the project's named ones. ${have} Give one of those ids (get_eval_suite lists them as environmentIds) or a name.`
      );
    }
  });
}
