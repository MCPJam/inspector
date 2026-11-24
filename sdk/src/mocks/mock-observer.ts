/**
 * What a mock tells its host about the calls it answered itself, outside the
 * messages a client receives. The route turns these into the trace mark and
 * the record of calls no saved answer matched; a result the model reads never
 * carries them.
 */

export type MockAnswerSource = "saved" | "model";

export type MockObservedEvent =
  /** The mock answered without calling a real tool (or answered a refusal itself). */
  | {
      type: "answered";
      tool: string;
      source: MockAnswerSource;
      /** Which saved case answered; absent for an answer the mock made up from the call alone. */
      caseIndex?: number;
      outcome:
        | "case"
        | "invalid_input"
        | "no_match"
        | "stored"
        | "generated"
        | "refused";
    }
  /** A tool with saved answers got input none of them matched. */
  | { type: "unmatched"; tool: string; arguments: Record<string, unknown> };

export interface MockObserver {
  (event: MockObservedEvent): void;
}
