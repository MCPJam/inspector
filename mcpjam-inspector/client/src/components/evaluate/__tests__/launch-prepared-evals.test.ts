import { describe, expect, it, vi } from "vitest";
import { savePreparedEvalSuites } from "../launch-prepared-evals";

describe("prepared suite authoring", () => {
  const input = {
    projectId: "project",
    server: { id: "server", name: "Example" },
    reviewKey: "review:1",
    clients: [{ id: "host", name: "Client" }],
    iterationsPerCase: 1,
    suites: [
      {
        id: "suite",
        title: "Search",
        description: "Search available data",
        cases: [
          {
            id: "case",
            title: "Search",
            prompt: "Search available records",
            expectedOutput: "Records or empty",
            steps: [
              {
                id: "prompt-1",
                kind: "prompt" as const,
                prompt: "Search available records",
              },
            ],
          },
        ],
      },
    ],
  };
  it("uses stable idempotency keys and preserves authored steps on retries", async () => {
    const mutate = vi.fn(async (name: string) =>
      name.endsWith("createTestSuite") ? { _id: "saved-suite" } : "saved-case",
    );
    await savePreparedEvalSuites({ ...input, mutate });
    await savePreparedEvalSuites({ ...input, mutate });
    expect(mutate.mock.calls[0]).toEqual(mutate.mock.calls[2]);
    expect(mutate.mock.calls[1]).toEqual(mutate.mock.calls[3]);
    expect(mutate).toHaveBeenCalledWith(
      "testSuites:createTestCase",
      expect.objectContaining({
        steps: input.suites[0].cases[0].steps,
        idempotencyKey: "prepared:review:1:case",
      }),
    );
  });
  it("rejects an empty selection before writing", async () => {
    const mutate = vi.fn();
    await expect(
      savePreparedEvalSuites({ ...input, suites: [], mutate }),
    ).rejects.toThrow("Select at least one case");
    expect(mutate).not.toHaveBeenCalled();
  });
});
