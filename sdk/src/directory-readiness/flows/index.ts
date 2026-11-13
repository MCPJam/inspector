/**
 * Directory flows: each directory's submission form as data, the portal's
 * own checks over answers, and where a readiness run's findings belong.
 *
 * Pure data and pure functions, so this whole barrel is safe from the
 * browser entry; nothing added here may change that.
 */

import { CHATGPT_PLUGIN_FLOW } from "./chatgpt-plugin.js";
import { CLAUDE_CONNECTOR_FLOW } from "./claude-connector.js";
import { DIRECTORY_FLOW_IDS } from "./types.js";
import type { DirectoryFlow, DirectoryFlowId } from "./types.js";

export const DIRECTORY_FLOWS: Readonly<Record<DirectoryFlowId, DirectoryFlow>> =
  {
    "claude-connector": CLAUDE_CONNECTOR_FLOW,
    "chatgpt-plugin": CHATGPT_PLUGIN_FLOW,
  };

/** The flow for an id from a request, or `undefined` for one that does not exist. */
export function getDirectoryFlow(id: string): DirectoryFlow | undefined {
  return (DIRECTORY_FLOW_IDS as readonly string[]).includes(id)
    ? DIRECTORY_FLOWS[id as DirectoryFlowId]
    : undefined;
}

export { CHATGPT_PLUGIN_FLOW, CLAUDE_CONNECTOR_FLOW, DIRECTORY_FLOW_IDS };
export {
  directoryFieldWordingRevision,
  directoryFlowDefaults,
  directoryFlowField,
  unconfirmedDeclarations,
  withDirectoryFlowDefaults,
} from "./fields.js";
export {
  validateDirectoryAnswerInput,
  validateDirectoryAnswers,
} from "./validate.js";
export {
  directoryFindingPlace,
  directoryPlacementOf,
  placeDirectoryResults,
} from "./place.js";
export type { PlaceDirectoryResultsInput } from "./place.js";
export { directoryVerdict } from "./verdict.js";
export type {
  DirectoryCheckGate,
  DirectoryRunPath,
  DirectoryVerdict,
} from "./verdict.js";
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
  DirectoryUnconfirmedDeclaration,
  PlacedFinding,
  PlacedStep,
} from "./types.js";
