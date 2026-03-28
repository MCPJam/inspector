import { describe, it, expect, vi, beforeEach } from "vitest";
import { generateAndPersistEvalTests } from "../generate-and-persist-tests";

vi.mock("@/lib/apis/evals-api", () => ({
  generateEvalTests: vi.fn(),
}));

import { generateEvalTests } from "@/lib/apis/evals-api";

describe("generateAndPersistEvalTests", () => {
  const mockQuery = vi.fn();
  const mockCreateTestCase = vi.fn();
  const mockGetAccessToken = vi.fn();

  const convex = { query: mockQuery } as any;

  beforeEach(() => {
    vi.clearAllMocks();
    mockGetAccessToken.mockResolvedValue("token");
    vi.mocked(generateEvalTests).mockResolvedValue({ tests: [] } as Awaited<
      ReturnType<typeof generateEvalTests>
    >);
  });

  it("skips API when skipIfExistingCases and suite already has cases", async () => {
    mockQuery.mockResolvedValue([{ _id: "1", models: [] }]);

    const result = await generateAndPersistEvalTests({
      convex,
      getAccessToken: mockGetAccessToken,
      workspaceId: "ws",
      suiteId: "suite",
      serverIds: ["srv"],
      createTestCase: mockCreateTestCase,
      skipIfExistingCases: true,
    });

    expect(result.skippedBecauseExistingCases).toBe(true);
    expect(result.createdCount).toBe(0);
    expect(generateEvalTests).not.toHaveBeenCalled();
    expect(mockCreateTestCase).not.toHaveBeenCalled();
  });

  it("calls generateEvalTests when skipIfExistingCases and suite is empty", async () => {
    mockQuery.mockResolvedValue([]);
    vi.mocked(generateEvalTests).mockResolvedValue({
      tests: [{ title: "T", query: "q", expectedToolCalls: [] }],
    } as Awaited<ReturnType<typeof generateEvalTests>>);
    mockCreateTestCase.mockResolvedValue({});

    const result = await generateAndPersistEvalTests({
      convex,
      getAccessToken: mockGetAccessToken,
      workspaceId: "ws",
      suiteId: "suite",
      serverIds: ["srv"],
      createTestCase: mockCreateTestCase,
      skipIfExistingCases: true,
    });

    expect(result.skippedBecauseExistingCases).toBe(false);
    expect(generateEvalTests).toHaveBeenCalled();
    expect(mockCreateTestCase).toHaveBeenCalledTimes(1);
  });
});
