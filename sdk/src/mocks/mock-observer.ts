/**
 * What a mock tells its host about each tool call, outside the messages a
 * client receives. The host turns these into the trace mark and its
 * operational events; a result the model reads never carries them, and an
 * event never carries arguments or results.
 */

/**
 * Where the answer came from: a saved case (`saved`), a record operation (`state`), the real tool
 * (`forwarded`), a refusal to call the real server (`blocked`), or a call no
 * saved case answers on a mock that has no real tool to fall back to
 * (`unmatched`).
 */
export type MockCallSource =
  "saved" | "state" | "forwarded" | "blocked" | "unmatched";

/** Why a mock refused a call itself, when the call was refused. */
export type MockRefusal =
  | "invalid_input"
  | "invalid_output"
  /** A saved case asks a question and the caller's revision cannot be asked one. */
  | "input_unavailable"
  /** A record operation the store refused: a missing or existing key, a stale epoch, a conflicting operation key. */
  | "record_refused"
  | MockForwardBlockReason;

/** Why a forward was not made; the real-server interface says it. */
export type MockForwardBlockReason =
  "blocked_by_policy" | "policy_unavailable" | "no_access" | "no_base";

export interface MockCallEvent {
  /** The name the client called. */
  tool: string;
  source: MockCallSource;
  /** The real tool of a forward, or of a forward that was blocked. */
  realTool?: string;
  /** Which saved case answered, counted from 0; present for `saved` when a case answered. */
  caseIndex?: number;
  /**
   * The answering case has no `when`, so it matches any input. A run that
   * passes on a catch-all can hide a call nobody planned for; the host shows it.
   */
  catchAll?: boolean;
  refusal?: MockRefusal;
  /** The failure behind a `policy_unavailable` refusal, for the host's log. */
  cause?: unknown;
}

export interface MockObserver {
  (event: MockCallEvent): void;
}
