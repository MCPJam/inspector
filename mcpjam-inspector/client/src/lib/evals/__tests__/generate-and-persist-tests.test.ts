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
    vi.mocked(generateEvalTests).mockResolvedValue({
      success: true,
      tests: [],
    });
  });

  it("skips API when skipIfExistingCases and suite already has cases", async () => {
    mockQuery.mockResolvedValue([{ _id: "1", models: [] }]);

    const result = await generateAndPersistEvalTests({
      convex,
      getAccessToken: mockGetAccessToken,
      projectId: "ws",
      suiteId: "suite",
      serverIds: ["srv"],
      createTestCase: mockCreateTestCase,
      skipIfExistingCases: true,
    });

    expect(result.skippedBecauseExistingCases).toBe(true);
    expect(result.createdCount).toBe(0);
    expect(result.createdTestCaseIds).toEqual([]);
    expect(generateEvalTests).not.toHaveBeenCalled();
    expect(mockCreateTestCase).not.toHaveBeenCalled();
  });

  it("calls generateEvalTests when skipIfExistingCases and suite is empty", async () => {
    mockQuery.mockResolvedValue([]);
    vi.mocked(generateEvalTests).mockResolvedValue({
      success: true,
      tests: [{ title: "T", query: "q", runs: 1, expectedToolCalls: [] }],
    });
    mockCreateTestCase.mockResolvedValue("new-case-id");

    const result = await generateAndPersistEvalTests({
      convex,
      getAccessToken: mockGetAccessToken,
      projectId: "ws",
      suiteId: "suite",
      serverIds: ["srv"],
      createTestCase: mockCreateTestCase,
      skipIfExistingCases: true,
    });

    expect(result.skippedBecauseExistingCases).toBe(false);
    expect(result.createdTestCaseIds).toEqual(["new-case-id"]);
    expect(generateEvalTests).toHaveBeenCalled();
    expect(mockCreateTestCase).toHaveBeenCalledTimes(1);
  });

  it("persists steps for generated multi-turn cases", async () => {
    mockQuery.mockResolvedValue([]);
    vi.mocked(generateEvalTests).mockResolvedValue({
      success: true,
      tests: [
        {
          title: "Follow up on a result",
          query: "Find the latest incident",
          runs: 1,
          expectedToolCalls: [{ toolName: "search_incidents", arguments: {} }],
          promptTurns: [
            {
              id: "turn-1",
              prompt: "Find the latest incident",
              expectedToolCalls: [
                { toolName: "search_incidents", arguments: {} },
              ],
            },
            {
              id: "turn-2",
              prompt: "Now get the full details for that one",
              expectedToolCalls: [
                { toolName: "get_incident_details", arguments: {} },
              ],
            },
          ],
        },
      ],
    });
    mockCreateTestCase.mockResolvedValue({});

    await generateAndPersistEvalTests({
      convex,
      getAccessToken: mockGetAccessToken,
      projectId: "ws",
      suiteId: "suite",
      serverIds: ["srv"],
      createTestCase: mockCreateTestCase,
      skipIfExistingCases: true,
    });

    // The Convex mutation rejects `promptTurns`; the create path now sends the
    // unified `steps` model derived from the generated turns. Each turn's
    // prompt → a `prompt` step; its expected calls → `toolCalledWith` asserts.
    expect(mockCreateTestCase).toHaveBeenCalledWith(
      expect.objectContaining({
        query: "Find the latest incident",
        expectedToolCalls: [{ toolName: "search_incidents", arguments: {} }],
        steps: [
          expect.objectContaining({
            kind: "prompt",
            prompt: "Find the latest incident",
          }),
          expect.objectContaining({
            kind: "assert",
            assertion: expect.objectContaining({
              type: "toolCalledWith",
              toolName: "search_incidents",
            }),
          }),
          expect.objectContaining({
            kind: "prompt",
            prompt: "Now get the full details for that one",
          }),
          expect.objectContaining({
            kind: "assert",
            assertion: expect.objectContaining({
              type: "toolCalledWith",
              toolName: "get_incident_details",
            }),
          }),
        ],
      }),
    );
    expect(mockCreateTestCase).not.toHaveBeenCalledWith(
      expect.objectContaining({ promptTurns: expect.anything() }),
    );
  });

  // The guest bearer is now resolved by the caller's `getAccessToken`
  // (see resolveConvexAccessToken / useConvexAccessToken); this function just
  // forwards whatever token it returns. A direct guest still drops projectId.
  it("forwards the resolved token and nulls projectId for direct guests", async () => {
    mockQuery.mockResolvedValue([]);
    mockGetAccessToken.mockResolvedValue("guest-token");
    vi.mocked(generateEvalTests).mockResolvedValue({
      success: true,
      tests: [{ title: "T", query: "q", runs: 1, expectedToolCalls: [] }],
    });
    mockCreateTestCase.mockResolvedValue({});

    await generateAndPersistEvalTests({
      convex,
      getAccessToken: mockGetAccessToken,
      projectId: null,
      suiteId: "suite",
      serverIds: ["srv"],
      createTestCase: mockCreateTestCase,
      isDirectGuest: true,
    });

    expect(mockGetAccessToken).toHaveBeenCalledTimes(1);
    expect(generateEvalTests).toHaveBeenCalledWith({
      projectId: null,
      serverIds: ["srv"],
      convexAuthToken: "guest-token",
    });
  });
});
