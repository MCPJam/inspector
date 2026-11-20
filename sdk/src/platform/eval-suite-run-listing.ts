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
 * How many other suites a project-wide search reads at most, newest run
 * first. The search usually stops at the first one.
 */
export const LATEST_FINISHED_RUN_SUITES = 10;

/**
 * The project's newest finished run outside the suite already searched, for a
 * listing that named no suite and found no finished run in the one it read.
 * That suite is often new: the newest run in the project is its first, still
 * going, while other suites hold the last verdict.
 *
 * Suites are read newest run first. A suite's runs are all no newer than its
 * latest, so the search stops once no remaining suite can hold a newer finished
 * run than the best found. `null` when no other suite has a finished run.
 */
export async function latestFinishedRunInProject(
  client: PlatformApiClient,
  project: PlatformProject,
  searchedSuiteId: string,
  signal: AbortSignal | undefined
): Promise<{ run: PlatformEvalRun; suite: PlatformEvalSuite } | null> {
  const { items } = await client.listEvalSuites(
    { projectId: project.id },
    { signal }
  );
  const others = items
    .filter((suite) => suite.id !== searchedSuiteId && suite.latestRun)
    .sort(
      (a, b) => (b.latestRun?.createdAt ?? -1) - (a.latestRun?.createdAt ?? -1)
    )
    .slice(0, LATEST_FINISHED_RUN_SUITES);
  let best: { run: PlatformEvalRun; suite: PlatformEvalSuite } | null = null;
  for (const suite of others) {
    if (best && (suite.latestRun?.createdAt ?? -1) <= best.run.createdAt) {
      break;
    }
    const { items: runs } = await client.listEvalSuiteRuns(
      {
        projectId: project.id,
        suiteId: suite.id,
        limit: LATEST_FINISHED_RUN_LOOKBACK,
      },
      { signal }
    );
    const finished = runs.find((run) => isEvalRunTerminalStatus(run.status));
    if (finished && (!best || finished.createdAt > best.run.createdAt)) {
      best = { run: finished, suite };
    }
  }
  return best;
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
