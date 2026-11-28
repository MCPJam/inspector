/**
 * A directory submission's test plan and what a run's calls showed, through
 * the SDK's client on the transport the submissions use, so `authFetch` owns
 * the bearer.
 */
import type { DirectoryTestPlan } from "@mcpjam/sdk/browser";
import {
  isPlatformApiError,
  type PlatformDirectoryTestPlanView,
  type PlatformDirectoryToolTests,
} from "@mcpjam/sdk/platform";
import { readinessPlatformClient as client } from "@/lib/apis/directory-readiness-api";
import type { SubmissionScope } from "@/lib/apis/directory-submissions-api";

export type TestPlanView = PlatformDirectoryTestPlanView;
export type ToolTests = PlatformDirectoryToolTests;

/** The saved plan, or `null` while the submission has none. */
export async function getTestPlan(
  scope: SubmissionScope,
): Promise<TestPlanView | null> {
  try {
    return await client().getDirectorySubmissionTestPlan(scope);
  } catch (error) {
    // The API's own 404, not a route this deployment lacks.
    const none =
      isPlatformApiError(error) &&
      error.status === 404 &&
      error.codeSource === "envelope";
    if (none) return null;
    throw error;
  }
}

/** A plan for every tool in the server's stored tool list. Saves nothing. */
export const draftTestPlan = (scope: SubmissionScope) =>
  client().draftDirectorySubmissionTestPlan(scope);

/** A `409` with `currentRevision` means another revision was saved since `expectedRevision`. */
export const saveTestPlan = (
  scope: SubmissionScope,
  expectedRevision: number,
  plan: DirectoryTestPlan,
) =>
  client().saveDirectorySubmissionTestPlan({
    ...scope,
    expectedRevision,
    plan,
  });

/** The newest run that named a plan revision, tool by tool. */
export const getToolTests = (scope: SubmissionScope): Promise<ToolTests> =>
  client().getDirectorySubmissionToolTests(scope);
