/**
 * The stage analyzer's authored-case input, built from what a case declares.
 *
 * Moved to the SDK contract (`@mcpjam/sdk/contract`, `stage-authored-case.ts`)
 * so this runner and the SDK's local suite-file runner derive stage rows from
 * one function; re-exported here so existing imports keep resolving.
 */
export {
  buildStageAuthoredCase,
  type StageCaseSource,
  type StageTurnSource,
} from "@mcpjam/sdk/contract";
