/**
 * One Claude directory-readiness run, as a hook.
 *
 * Deliberately NOT built on `use-conformance-run`, and the reason is the whole
 * product's premise: readiness produces no score, contributes nothing to the
 * pooled number, and grades against Anthropic's listing policy rather than the
 * MCP spec. Sharing that hook would mean sharing its suite/score vocabulary,
 * and the first person to add a `scoreFrom…` call would be right to, because
 * the type would let them.
 *
 * Rendering stays with the panel; this owns run state and nothing visual.
 */

import { useCallback, useRef, useState } from "react";
import type { ClaudeReadinessResult } from "@mcpjam/sdk";
import type { ServerWithName } from "@/hooks/use-app-state";
import { runClaudeReadinessGrade } from "@/lib/apis/mcp-conformance-api";

export type ReadinessRunState =
  | { phase: "idle" }
  | { phase: "running" }
  | { phase: "done"; result: ClaudeReadinessResult }
  | { phase: "error"; message: string };

/** What a profile file has to be before it is worth sending. */
export type ProfileParse =
  | { ok: true; value: unknown }
  | { ok: false; message: string };

/**
 * Parse a pasted or uploaded submission profile.
 *
 * Only the JSON-ness is checked here. The SCHEMA is checked by the engine, so
 * that a profile with a bad field comes back as findings naming the fields —
 * which is the answer the user wants — rather than as a client-side error
 * message that stops the run before the transport is graded at all.
 */
export function parseSubmissionProfile(text: string): ProfileParse {
  const trimmed = text.trim();
  if (trimmed.length === 0) return { ok: true, value: undefined };
  try {
    return { ok: true, value: JSON.parse(trimmed) };
  } catch {
    return {
      ok: false,
      message: "That is not valid JSON. Paste the listing metadata itself.",
    };
  }
}

export function useClaudeReadinessRun(server: ServerWithName | null) {
  const [state, setState] = useState<ReadinessRunState>({ phase: "idle" });
  // Guards against a stale response landing after the user switched servers or
  // started a second run: only the newest run may write state.
  const runToken = useRef(0);

  const run = useCallback(
    async (options?: { submissionProfile?: unknown }) => {
      if (!server) return;
      const token = ++runToken.current;
      setState({ phase: "running" });
      try {
        const response = await runClaudeReadinessGrade(
          server.name,
          options?.submissionProfile !== undefined
            ? { submissionProfile: options.submissionProfile }
            : undefined,
        );
        if (token !== runToken.current) return;
        if (!response.success || !response.result) {
          setState({
            phase: "error",
            message: "The grade did not complete. Try again.",
          });
          return;
        }
        setState({ phase: "done", result: response.result });
      } catch (error) {
        if (token !== runToken.current) return;
        setState({
          phase: "error",
          message:
            error instanceof Error
              ? error.message
              : "The grade did not complete. Try again.",
        });
      }
    },
    [server],
  );

  /**
   * Drop the current result.
   *
   * Bumps the token as well as clearing state, so a run still in flight when
   * the user changes server cannot land its result onto the new selection —
   * which would render one server's grade under another's name.
   */
  const reset = useCallback(() => {
    runToken.current += 1;
    setState({ phase: "idle" });
  }, []);

  return { state, run, reset };
}
