/**
 * What `list_eval_suite_runs` does when a caller asks about "the latest eval
 * run" without naming a suite, and when that run has no verdict yet.
 *
 * That question is the one callers bring to a run history most often, and it
 * names a project, not a suite. The listing used to require the suite, so the
 * call an agent reaches for first was refused as invalid input. And a history
 * whose newest run is still going answered it with "no result yet" while an
 * earlier run had one.
 *
 * Separate from `operations.ts`, which builds its input schemas at module load,
 * so nothing here may import that file.
 */
import { isEvalRunTerminalStatus } from "../contract/eval-lifecycle.js";
import type { PlatformApiClient } from "./client.js";
import { resolveByIdOrName, resolutionError } from "./resource-selectors.js";
import type {
  PlatformEvalRun,
  PlatformEvalSuite,
  PlatformProject,
} from "./types.js";

/**
 * How many of a suite's newest runs are searched for a finished one. The API's
 * own default page size, so an unbounded listing never costs a second request.
 */
export const LATEST_FINISHED_RUN_LOOKBACK = 25;

/**
 * The suite a run listing reads: the one the caller named, or, without a name,
 * the one holding the project's most recent run, so the listing starts with
 * the newest run in the whole project. When no suite has run yet it falls back
 * to the most recently updated suite, as the project selector does.
 */
export async function resolveSuiteForRunListing(
  client: PlatformApiClient,
  project: PlatformProject,
  selector: string | undefined,
  signal: AbortSignal | undefined
): Promise<PlatformEvalSuite> {
  const { items } = await client.listEvalSuites(
    { projectId: project.id },
    { signal }
  );
  if (selector !== undefined) {
    return resolveByIdOrName(
      items,
      selector,
      "Eval suite",
      `project "${project.name}"`
    );
  }
  const [latest] = [...items].sort(
    (a, b) =>
      (b.latestRun?.createdAt ?? -1) - (a.latestRun?.createdAt ?? -1) ||
      (b.updatedAt ?? -1) - (a.updatedAt ?? -1)
  );
  if (!latest) {
    throw resolutionError(`Project "${project.name}" has no eval suites.`);
  }
  return latest;
}

/**
 * The newest finished run, for a page of runs none of which has finished.
 *
 * `undefined` when the page needs none: it is empty, or one of its runs has
 * finished and carries the latest verdict itself. `null` when none of the
 * newest {@link LATEST_FINISHED_RUN_LOOKBACK} runs has finished. Asks for more
 * runs only when the caller's own `limit` cut the page short of that window.
 */
export async function latestFinishedRunFor(
  page: PlatformEvalRun[],
  limit: number | undefined,
  listRuns: (limit: number) => Promise<PlatformEvalRun[]>
): Promise<PlatformEvalRun | null | undefined> {
  if (
    page.length === 0 ||
    page.some((run) => isEvalRunTerminalStatus(run.status))
  ) {
    return undefined;
  }
  const pageWasCut =
    limit !== undefined &&
    limit < LATEST_FINISHED_RUN_LOOKBACK &&
    page.length >= limit;
  if (!pageWasCut) return null;
  const wider = await listRuns(LATEST_FINISHED_RUN_LOOKBACK);
  return wider.find((run) => isEvalRunTerminalStatus(run.status)) ?? null;
}
