/**
 * `draft_climb_change`: the backend's drafting action, called as the person. It
 * reads the tool's stored listing and the failed steering iterations, asks a
 * model for a rewrite and answers with the draft and the merge patch that
 * applies it. It saves nothing and starts no run; the caller edits the draft,
 * saves it as a mock version and submits that version as a round.
 */
import type { PlatformClimbDraft } from "@mcpjam/sdk/platform";
import { climbFns } from "./backend.js";
import type { ClimbDeps } from "./deps.js";

export type DraftRequest = { toolName: string; failedCaseKeys?: string[]; includeTitle?: boolean };

export async function draftClimbChange(
  deps: Pick<ClimbDeps, "convex">,
  climb: { climbId: string; suiteId: string },
  request: DraftRequest,
): Promise<PlatformClimbDraft> {
  const draft: Omit<PlatformClimbDraft, "climbId" | "suiteId"> = await deps.convex.action(climbFns.draft, {
    climbId: climb.climbId,
    toolName: request.toolName,
    ...(request.failedCaseKeys ? { failedCaseKeys: request.failedCaseKeys } : {}),
    ...(request.includeTitle ? { includeTitle: true } : {}),
  });
  return { climbId: climb.climbId, suiteId: climb.suiteId, ...draft };
}
