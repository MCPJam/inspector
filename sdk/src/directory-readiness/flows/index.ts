/**
 * Directory flows: each directory's submission form as data.
 *
 * Pure data and pure functions, so this whole barrel is safe from the
 * browser entry; nothing added here may change that.
 */

import { CLAUDE_CONNECTOR_FLOW } from "./claude-connector.js";
import { DIRECTORY_FLOW_IDS } from "./types.js";
import type { DirectoryFlow, DirectoryFlowId } from "./types.js";

export const DIRECTORY_FLOWS: Readonly<Record<DirectoryFlowId, DirectoryFlow>> =
  { "claude-connector": CLAUDE_CONNECTOR_FLOW };

/** The flow for an id from a request, or `undefined` for one that does not exist. */
export function getDirectoryFlow(id: string): DirectoryFlow | undefined {
  return (DIRECTORY_FLOW_IDS as readonly string[]).includes(id)
    ? DIRECTORY_FLOWS[id as DirectoryFlowId]
    : undefined;
}

export { CLAUDE_CONNECTOR_FLOW, DIRECTORY_FLOW_IDS };
export {
  directoryFieldWordingRevision,
  directoryFlowDefaults,
  directoryFlowField,
  withDirectoryFlowDefaults,
} from "./fields.js";
export type {
  DirectoryAnswer,
  DirectoryAnswerOrigin,
  DirectoryAnswerValue,
  DirectoryCheckNeed,
  DirectoryCheckPlacement,
  DirectoryEvidenceStatus,
  DirectoryFieldControl,
  DirectoryFieldFormat,
  DirectoryFieldIssue,
  DirectoryFieldIssueCode,
  DirectoryFlow,
  DirectoryFlowField,
  DirectoryFlowId,
  DirectoryFlowOption,
  DirectoryFlowStep,
  DirectoryLayoutBlock,
  DirectoryPortalErrorCode,
  DirectoryReviewSection,
  DirectoryStepLayout,
  PlacedFinding,
  PlacedStep,
} from "./types.js";
