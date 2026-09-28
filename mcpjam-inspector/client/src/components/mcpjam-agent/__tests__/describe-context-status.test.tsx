import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { expect, it, vi } from "vitest";
import { DescribeContextStatus } from "../DescribeContextStatus";
import { registerEvalDraft } from "@/lib/mcpjam-agent/eval-workspace";
import type { EvalAgentScope } from "@/shared/eval-agent-scope";
const scope: EvalAgentScope = {
  kind: "evals",
  version: 1,
  id: "s",
  projectId: "p",
  suiteId: "s",
  suiteName: "Suite",
  caseId: "draft:describe",
};
it("keeps partial metadata usable and offers recovery for the failed server", async () => {
  const retry = vi.fn().mockRejectedValue(new Error("Sign in required"));
  const unregister = registerEvalDraft(scope, {
    read: () => ({
      draft: { title: "", steps: [] },
      revision: "1",
      tools: [],
      metadata: {
        environmentKey: "v1",
        tools: [{ name: "search" }],
        servers: [
          {
            serverId: "fast",
            status: "ready",
            tools: [{ name: "search" }],
            updatedAt: 1,
          },
          {
            serverId: "slow",
            status: "error",
            action: "reconnect",
            tools: [],
            updatedAt: 1,
          },
        ],
      },
    }),
    edit: vi.fn(),
    undo: vi.fn(),
    retryTools: retry,
  });
  render(<DescribeContextStatus scope={scope} />);
  expect(screen.getByText(/1 of 2 servers ready/)).toBeInTheDocument();
  fireEvent.click(screen.getByRole("button", { name: "Reconnect slow" }));
  await waitFor(() => expect(retry).toHaveBeenCalledWith("slow"));
  expect(await screen.findByRole("alert")).toHaveTextContent(
    /Could not reconnect/,
  );
  unregister();
});
