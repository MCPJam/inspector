/**
 * What the climb screens read. The SDK's `PlatformClimb` is the contract the
 * operations return today; the picker (MCPJam picks each change) adds fields
 * the backend already sends (`backend-stage3.md`) and the SDK types do not name
 * yet. They are named here, optional, so a backend or an SDK that predates them
 * still reads.
 */
import type {
  PlatformClimb,
  PlatformClimbRound,
  PlatformClimbRoundSummary,
} from "@mcpjam/sdk/platform";

export type ClimbPicker = "person" | "agent" | "mcpjam";

/** Why MCPJam stopped picking: the backend writes `reason` as a sentence a person can read. */
export type ClimbPaused = { at: number; code: string; reason: string };

/** MCPJam's one picker turn, as it waits or runs. Absent when nothing is wanted. */
export type ClimbStep = {
  status: "due" | "claimed";
  dueAt: number;
  attempts: number;
  emptyTurns: number;
  leaseExpiresAt?: number;
};

export type ClimbRoundSummary = PlatformClimbRoundSummary & {
  /** Set when MCPJam picked the change. */
  pickedBy?: "mcpjam";
  /** The chat session that holds MCPJam's transcript for the round. */
  pickerChatSessionId?: string;
};

export type ClimbRoundDetail = PlatformClimbRound & {
  pickedBy?: "mcpjam";
  pickerChatSessionId?: string;
};

export type Climb = Omit<PlatformClimb, "picker" | "rounds"> & {
  picker: ClimbPicker;
  pickerModel?: string;
  stepRunner?: "hosted" | "local";
  step?: ClimbStep;
  paused?: ClimbPaused;
  pickerSpend?: { credits: number; usd: number; tokens: number; turns: number };
  rounds: ClimbRoundSummary[];
};
