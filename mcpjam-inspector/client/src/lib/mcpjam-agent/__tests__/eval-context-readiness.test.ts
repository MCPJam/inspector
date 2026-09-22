import { expect, it, vi } from "vitest";
import {
  readEvalContext,
  isEvalContextReady,
  registerEvalDraft,
} from "../eval-workspace";
import type { EvalAgentScope } from "@/shared/eval-agent-scope";
const scope: EvalAgentScope = {
  kind: "evals",
  version: 1,
  id: "readiness",
  projectId: "context-p",
  suiteId: "s",
  suiteName: "Suite",
  caseId: "c",
};
it("returns the readable draft even when the suite bridge has not mounted", () => {
  const cleanup = registerEvalDraft(scope, {
    read: () => ({
      draft: { title: "Case", steps: [] },
      revision: "r",
      tools: [{ name: "search" }],
    }),
    edit: vi.fn(),
    undo: vi.fn(),
  });
  expect(readEvalContext(scope)).toMatchObject({
    suiteStatus: "loading",
    case: { draft: { title: "Case" } },
  });
  expect(isEvalContextReady(scope)).toBe(true);
  cleanup();
});
it("distinguishes loading, empty and partial tool catalogues", () => {
  let status: "loading" | "empty" | "ready" = "loading";
  const cleanup = registerEvalDraft(scope, {
    read: () => ({
      draft: { title: "Case", steps: [] },
      revision: "r",
      tools: [],
      metadata: {
        environmentKey: "env",
        tools: [],
        servers: [
          { serverId: "a", status, tools: [], updatedAt: 0 },
          {
            serverId: "b",
            status: "error",
            tools: [],
            updatedAt: 0,
            action: "retry",
          },
        ],
      },
    }),
    edit: vi.fn(),
    undo: vi.fn(),
  });
  expect(readEvalContext(scope).status).toBe("loading");
  expect(isEvalContextReady(scope)).toBe(false);
  status = "ready";
  expect(readEvalContext(scope).status).toBe("partial");
  status = "empty";
  expect(readEvalContext(scope).status).toBe("error");
  cleanup();
});
