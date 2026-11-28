/**
 * The decision scan, from the runner's side: candidates from what the run
 * read, at most the broker's per-run cap of them, one broker call, and the
 * answers handed to the SDK grade as `decisionScan`. The SDK picks the
 * candidates and grades the answers; the backend holds the prompts and pays.
 *
 * NO CONFIDENCE THRESHOLD is set here. MCPJam sets one from measured
 * accuracy; until then the SDK reports every decision check not evaluated,
 * with that reason, whatever a model answered.
 */

import {
  DIRECTORY_DECISION_LIMITS,
  OPENAI_SUBMISSION_MODE_SHAPES,
  findDecisionCandidates,
  packageSelfDescription,
  selectDecisionItems,
  type ClaudeReadinessInput,
  type DirectoryDecisionAnswer,
  type DirectoryDecisionDirectory,
  type DirectoryDecisionEvidence,
  type DirectoryDecisionItem,
  type DirectoryDecisionScan,
  type OpenAIReadinessEvidence,
} from "@mcpjam/sdk";

/** What the broker's decision pass came back with. */
export type DecisionBrokerAnswer =
  | { status: "answered"; answers: DirectoryDecisionAnswer[] }
  /** The scan is off for this run, so the grade gets no scan. */
  | { status: "off"; detail: string }
  /** Refused, timed out, already running for this run, or unreadable. */
  | { status: "unanswered"; detail: string };

/**
 * How a run asks the broker. Absent, the run asks nothing and cannot spend,
 * as for observations.
 */
export type DecisionRequester = (input: {
  items: DirectoryDecisionItem[];
  /** The run's own signal: a cancelled run must not wait out the pass. */
  signal?: AbortSignal;
}) => Promise<DecisionBrokerAnswer>;

/** What a run read that a decision question reads too. */
export interface DecisionScanInput {
  directory: DirectoryDecisionDirectory;
  evidence: DirectoryDecisionEvidence;
  /**
   * False when the server's tool listing is missing or partial. The grade
   * then reports that gap whatever a model says, so nothing is asked.
   */
  listingComplete: boolean;
}

function listed(evidence: {
  tools?: readonly unknown[];
  toolListingComplete?: boolean;
}): boolean {
  return evidence.tools !== undefined && evidence.toolListingComplete !== false;
}

/** Claude's questions read the tools alone. */
export function claudeDecisionInput(
  evidence: ClaudeReadinessInput,
): DecisionScanInput {
  return {
    directory: "claude",
    evidence: { tools: evidence.tools },
    listingComplete: listed(evidence),
  };
}

/** ChatGPT's also read the server's instructions and the package's own text. */
export function openaiDecisionInput(
  evidence: OpenAIReadinessEvidence,
): DecisionScanInput {
  const { hasMcpServer } = OPENAI_SUBMISSION_MODE_SHAPES[evidence.mode];
  return {
    directory: "openai",
    evidence: {
      tools: evidence.tools,
      instructions: evidence.instructions,
      listing: packageSelfDescription(evidence.package),
    },
    // A skills-only package has no server: its listing text is all there is.
    listingComplete: !hasMcpServer || listed(evidence),
  };
}

/**
 * The scan the run's grade reads, or `undefined` when the scan is off for the
 * run. `ask` is called at most once, and only with something to ask.
 */
export async function decisionScanFor(
  input: DecisionScanInput,
  ask: (items: DirectoryDecisionItem[]) => Promise<DecisionBrokerAnswer>,
): Promise<DirectoryDecisionScan | undefined> {
  const { items, unasked } = selectDecisionItems(
    input.directory,
    findDecisionCandidates(input.directory, input.evidence),
    { maxQuestions: DIRECTORY_DECISION_LIMITS.maxQuestionsPerRun },
  );
  // Every candidate unjudged, which the grade never reads as a pass.
  const unanswered: DirectoryDecisionScan = { items, unasked, answers: [] };
  if (items.length === 0 || !input.listingComplete) return unanswered;
  const answer = await ask(items);
  if (answer.status === "off") return undefined;
  return answer.status === "answered"
    ? { ...unanswered, answers: answer.answers }
    : unanswered;
}
