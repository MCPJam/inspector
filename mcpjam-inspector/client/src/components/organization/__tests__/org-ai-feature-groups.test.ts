import { describe, expect, it } from "vitest";
import type { AiFeatureGroupId } from "@/hooks/useOrgAiConfig";
import { AI_FEATURE_GROUPS } from "../org-ai-config-presentation";

/**
 * The feature groups the backend reports, in its order and with its labels:
 * a copy of `AI_FEATURE_GROUPS` in the backend's `convex/lib/aiOperations.ts`.
 * When the backend adds, renames or reorders a group, update this list and
 * the client's together. A group the client doesn't list still renders, but
 * last and under the backend's label, so a missing one is a bug.
 */
const BACKEND_FEATURE_GROUPS = [
  { id: "chat", label: "Chat" },
  { id: "evals", label: "Evals and grading" },
  { id: "swarms", label: "Swarms and User Testing" },
  { id: "insights", label: "Insights and findings" },
  { id: "generation", label: "Generation" },
  { id: "session_map", label: "Session map" },
  { id: "harness", label: "Harness runtimes" },
  { id: "transcription", label: "Transcription" },
  { id: "ask_mcpjam", label: "Ask MCPJam" },
] as const satisfies ReadonlyArray<{ id: AiFeatureGroupId; label: string }>;

describe("AI_FEATURE_GROUPS", () => {
  it("lists every group the backend reports, in its order and with its labels", () => {
    expect(AI_FEATURE_GROUPS.map(({ id, label }) => ({ id, label }))).toEqual(
      BACKEND_FEATURE_GROUPS,
    );
  });
});
