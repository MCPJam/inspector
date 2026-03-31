/**
 * use-eval-handlers.ts Tests
 *
 * Tests for the eval handlers hook, specifically verifying:
 * - All API calls use authFetch for session authentication
 * - handleRerun uses authFetch for /api/mcp/evals/run
 * - handleGenerateTests uses authFetch for /api/mcp/evals/generate-tests
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { renderHook, act, waitFor } from "@testing-library/react";
import { useEvalHandlers } from "../use-eval-handlers";
import { API_ENDPOINTS } from "../constants";
import { createFetchResponse, createDeferred } from "@/test";
import { setHostedApiContext } from "@/lib/apis/web/context";

vi.mock("@/lib/config", () => ({
  HOSTED_MODE: true,
}));

// Mock authFetch
const mockAuthFetch = vi.fn();
vi.mock("@/lib/session-token", () => ({
  authFetch: (...args: unknown[]) => mockAuthFetch(...args),
}));

// Mock useAuth
const mockGetAccessToken = vi.fn();
vi.mock("@workos-inc/authkit-react", () => ({
  useAuth: () => ({
    getAccessToken: mockGetAccessToken,
  }),
}));

// Mock useConvex
const mockConvexQuery = vi.fn();
vi.mock("convex/react", () => ({
  useConvex: () => ({
    query: mockConvexQuery,
  }),
}));

// Mock useAiProviderKeys
vi.mock("@/hooks/use-ai-provider-keys", () => ({
  useAiProviderKeys: () => ({
    getToken: vi.fn().mockReturnValue("mock-api-key"),
    hasToken: vi.fn().mockReturnValue(true),
  }),
}));

// Mock posthog
vi.mock("posthog-js", () => ({
  default: {
    capture: vi.fn(),
  },
}));

// Mock PosthogUtils
vi.mock("@/lib/PosthogUtils", () => ({
  detectEnvironment: vi.fn().mockReturnValue("test"),
  detectPlatform: vi.fn().mockReturnValue("web"),
}));

// Mock toast
vi.mock("sonner", () => ({
  toast: {
    loading: vi.fn().mockReturnValue("toast-id"),
    success: vi.fn(),
    error: vi.fn(),
    info: vi.fn(),
  },
}));

// Mock evals-router
vi.mock("@/lib/evals-router", () => ({
  navigateToEvalsRoute: vi.fn(),
}));

const mockNavigateToCiEvalsRoute = vi.fn();
vi.mock("@/lib/ci-evals-router", () => ({
  navigateToCiEvalsRoute: (...args: unknown[]) =>
    mockNavigateToCiEvalsRoute(...args),
}));

const mockIsHostedMode = vi.fn(() => false);
vi.mock("@/lib/apis/mode-client", () => ({
  isHostedMode: () => mockIsHostedMode(),
  ensureLocalMode: vi.fn(),
  runByMode: (handlers: { local: () => unknown; hosted: () => unknown }) =>
    mockIsHostedMode() ? handlers.hosted() : handlers.local(),
}));

// Mock isMCPJamProvidedModel
vi.mock("@/shared/types", () => ({
  isMCPJamProvidedModel: vi.fn().mockReturnValue(false),
}));

describe("useEvalHandlers", () => {
  const mockMutations = {
    deleteSuiteMutation: vi.fn(),
    duplicateSuiteMutation: vi.fn(),
    cancelRunMutation: vi.fn(),
    deleteRunMutation: vi.fn(),
    createTestCaseMutation: vi.fn(),
    deleteTestCaseMutation: vi.fn(),
    duplicateTestCaseMutation: vi.fn(),
  };

  const defaultProps = {
    mutations: mockMutations as any,
    selectedSuiteEntry: null,
    selectedSuiteId: null,
    selectedTestId: null,
    workspaceId: "workspace-1",
    connectedServerNames: new Set(["server-1"]),
  };

  beforeEach(() => {
    vi.clearAllMocks();
    mockIsHostedMode.mockReturnValue(false);

    // Default mock implementations
    mockGetAccessToken.mockResolvedValue("mock-access-token");

    // Mock convex query to return test cases with models
    mockConvexQuery.mockResolvedValue([
      {
        _id: "test-case-1",
        title: "Test Case 1",
        query: "Test query",
        runs: 1,
        models: [{ model: "gpt-4", provider: "openai" }],
        expectedToolCalls: [],
      },
    ]);

    // Default authFetch mock - return successful response
    mockAuthFetch.mockResolvedValue(createFetchResponse({ success: true }));
  });

  afterEach(() => {
    vi.restoreAllMocks();
    setHostedApiContext(null);
  });

  describe("handleRerun", () => {
    it("uses authFetch for /api/mcp/evals/run endpoint", async () => {
      const { result } = renderHook(() => useEvalHandlers(defaultProps));

      const mockSuite = {
        _id: "suite-123",
        name: "Test Suite",
        description: "A test suite",
        environment: { servers: ["server-1"] },
      };

      await act(async () => {
        await result.current.handleRerun(mockSuite as any);
      });

      // Verify authFetch was called with the correct endpoint
      expect(mockAuthFetch).toHaveBeenCalledWith(
        "/api/mcp/evals/run",
        expect.objectContaining({
          method: "POST",
          headers: { "Content-Type": "application/json" },
        }),
      );
    });

    it("passes correct request body to authFetch", async () => {
      const { result } = renderHook(() => useEvalHandlers(defaultProps));

      const mockSuite = {
        _id: "suite-456",
        name: "My Suite",
        description: "Suite description",
        environment: { servers: ["server-1"] },
        defaultPassCriteria: { minimumPassRate: 80 },
      };

      await act(async () => {
        await result.current.handleRerun(mockSuite as any);
      });

      // Verify the request body
      const callArgs = mockAuthFetch.mock.calls[0];
      const requestBody = JSON.parse(callArgs[1].body);

      expect(requestBody).toMatchObject({
        suiteId: "suite-456",
        suiteName: "My Suite",
        suiteDescription: "Suite description",
        serverIds: ["server-1"],
      });
    });

    it("does not use regular fetch for /api/mcp/evals/run", async () => {
      const originalFetch = global.fetch;
      const fetchSpy = vi.fn();
      global.fetch = fetchSpy;

      const { result } = renderHook(() => useEvalHandlers(defaultProps));

      const mockSuite = {
        _id: "suite-123",
        name: "Test Suite",
        description: "A test suite",
        environment: { servers: ["server-1"] },
      };

      await act(async () => {
        await result.current.handleRerun(mockSuite as any);
      });

      // Verify regular fetch was NOT called with the evals/run endpoint
      const fetchCalls = fetchSpy.mock.calls.filter(
        (call) =>
          typeof call[0] === "string" && call[0].includes("/api/mcp/evals/run"),
      );
      expect(fetchCalls).toHaveLength(0);

      global.fetch = originalFetch;
    });

    it("replays the latest run when live servers are missing and replay is available", async () => {
      mockIsHostedMode.mockReturnValue(true);

      mockAuthFetch.mockResolvedValue(
        createFetchResponse({
          success: true,
          suiteId: "suite-123",
          runId: "run-replay",
        }),
      );

      const { result } = renderHook(() =>
        useEvalHandlers({
          ...defaultProps,
          connectedServerNames: new Set(),
          latestRunBySuiteId: new Map([
            [
              "suite-123",
              {
                _id: "run-source",
                hasServerReplayConfig: true,
                passCriteria: { minimumPassRate: 92 },
              },
            ],
          ]),
        }),
      );

      const mockSuite = {
        _id: "suite-123",
        name: "CI Suite",
        description: "A CI-backed suite",
        source: "ui",
        environment: { servers: ["server-1"] },
      };

      await act(async () => {
        await result.current.handleRerun(mockSuite as any);
      });

      expect(mockAuthFetch).toHaveBeenCalledWith(
        "/api/web/evals/replay-run",
        expect.objectContaining({
          method: "POST",
          headers: { "Content-Type": "application/json" },
        }),
      );

      const callArgs = mockAuthFetch.mock.calls[0];
      const requestBody = JSON.parse(callArgs[1].body);
      expect(requestBody).toMatchObject({
        runId: "run-source",
        passCriteria: { minimumPassRate: 92 },
      });
      expect(requestBody.convexAuthToken).toBeUndefined();

      expect(mockNavigateToCiEvalsRoute).toHaveBeenCalledWith({
        type: "run-detail",
        suiteId: "suite-123",
        runId: "run-replay",
        insightsFocus: true,
      });
    });

    it("replays the latest run when suite server metadata is empty but replay is available", async () => {
      mockIsHostedMode.mockReturnValue(true);

      mockAuthFetch.mockResolvedValue(
        createFetchResponse({
          success: true,
          suiteId: "suite-123",
          runId: "run-replay",
        }),
      );

      const { result } = renderHook(() =>
        useEvalHandlers({
          ...defaultProps,
          connectedServerNames: new Set(),
          latestRunBySuiteId: new Map([
            [
              "suite-123",
              {
                _id: "run-source",
                hasServerReplayConfig: true,
                passCriteria: { minimumPassRate: 92 },
              },
            ],
          ]),
        }),
      );

      const mockSuite = {
        _id: "suite-123",
        name: "SDK Suite",
        description: "A replayable suite without stored server names",
        source: "sdk",
        environment: { servers: [] },
      };

      await act(async () => {
        await result.current.handleRerun(mockSuite as any);
      });

      expect(mockAuthFetch).toHaveBeenCalledWith(
        "/api/web/evals/replay-run",
        expect.objectContaining({
          method: "POST",
          headers: { "Content-Type": "application/json" },
        }),
      );

      const callArgs = mockAuthFetch.mock.calls[0];
      const requestBody = JSON.parse(callArgs[1].body);
      expect(requestBody).toMatchObject({
        runId: "run-source",
        passCriteria: { minimumPassRate: 92 },
      });

      expect(mockNavigateToCiEvalsRoute).toHaveBeenCalledWith({
        type: "run-detail",
        suiteId: "suite-123",
        runId: "run-replay",
        insightsFocus: true,
      });
    });

    it("uses the normal rerun path when live servers are connected", async () => {
      mockIsHostedMode.mockReturnValue(true);
      setHostedApiContext({
        workspaceId: "ws-123",
        isAuthenticated: true,
        serverIdsByName: { "server-1": "srv-1" },
      });

      mockAuthFetch.mockResolvedValue(
        createFetchResponse({
          success: true,
          suiteId: "suite-123",
          runId: "run-rerun",
        }),
      );

      const { result } = renderHook(() =>
        useEvalHandlers({
          ...defaultProps,
          selectedSuiteId: "suite-123",
          connectedServerNames: new Set(["server-1"]),
          latestRunBySuiteId: new Map([
            [
              "suite-123",
              {
                _id: "run-source",
                hasServerReplayConfig: true,
                passCriteria: { minimumPassRate: 92 },
              },
            ],
          ]),
        }),
      );

      const mockSuite = {
        _id: "suite-123",
        name: "Hosted SDK Suite",
        description: "A replay-eligible suite with live connectivity",
        source: "ui",
        environment: { servers: ["server-1"] },
      };

      await act(async () => {
        await result.current.handleRerun(mockSuite as any);
      });

      expect(mockAuthFetch).toHaveBeenCalledWith(
        "/api/web/evals/run",
        expect.objectContaining({
          method: "POST",
          headers: { "Content-Type": "application/json" },
        }),
      );
    });

    it("uses the clicked suite latest run instead of the selected suite entry", async () => {
      mockIsHostedMode.mockReturnValue(true);

      mockAuthFetch.mockResolvedValue(
        createFetchResponse({
          success: true,
          suiteId: "suite-clicked",
          runId: "run-replay",
        }),
      );

      const { result } = renderHook(() =>
        useEvalHandlers({
          ...defaultProps,
          connectedServerNames: new Set(),
          selectedSuiteEntry: {
            suite: { _id: "suite-selected" },
            latestRun: {
              _id: "run-selected",
              hasServerReplayConfig: false,
            },
            recentRuns: [],
          } as any,
          latestRunBySuiteId: new Map([
            [
              "suite-clicked",
              {
                _id: "run-clicked",
                hasServerReplayConfig: true,
              },
            ],
          ]),
        }),
      );

      await act(async () => {
        await result.current.handleRerun({
          _id: "suite-clicked",
          name: "Clicked Suite",
          description: "Uses clicked latest run",
          environment: { servers: ["server-1"] },
        } as any);
      });

      const callArgs = mockAuthFetch.mock.calls[0];
      const requestBody = JSON.parse(callArgs[1].body);
      expect(requestBody.runId).toBe("run-clicked");
    });
  });

  describe("handleReplayRun", () => {
    it("does not send modelApiKeys for MCPJam-provided replay models", async () => {
      const { isMCPJamProvidedModel } = await import("@/shared/types");
      vi.mocked(isMCPJamProvidedModel).mockImplementation(
        (modelId: string) => modelId === "openai/gpt-4o-mini",
      );

      mockIsHostedMode.mockReturnValue(false);
      mockConvexQuery.mockResolvedValue([
        {
          _id: "test-case-1",
          title: "Replay Test",
          query: "Get my Asana user profile",
          runs: 1,
          models: [{ model: "openai/gpt-4o-mini", provider: "openrouter" }],
          expectedToolCalls: [],
        },
      ]);
      mockAuthFetch.mockResolvedValue(
        createFetchResponse({
          success: true,
          suiteId: "suite-local",
          runId: "run-local-replay",
        }),
      );

      const { result } = renderHook(() =>
        useEvalHandlers({
          ...defaultProps,
          selectedSuiteEntry: {
            latestRun: {
              _id: "run-source-local",
              hasServerReplayConfig: true,
            },
            recentRuns: [],
          } as any,
        }),
      );

      await act(async () => {
        await result.current.handleReplayRun(
          {
            _id: "suite-local",
            name: "Local Replay Suite",
            description: "A locally replayed suite",
            source: "sdk",
            environment: { servers: ["server-1"] },
          } as any,
          {
            _id: "run-source-local",
            hasServerReplayConfig: true,
          } as any,
        );
      });

      const callArgs = mockAuthFetch.mock.calls[0];
      const requestBody = JSON.parse(callArgs[1].body);

      expect(requestBody.modelApiKeys).toBeUndefined();
    });

    it("posts to the local replay endpoint outside hosted mode", async () => {
      mockIsHostedMode.mockReturnValue(false);

      const selectedSuiteEntry = {
        latestRun: {
          _id: "run-latest",
          hasServerReplayConfig: true,
        },
        recentRuns: [],
      };

      mockAuthFetch.mockResolvedValue(
        createFetchResponse({
          success: true,
          suiteId: "suite-local",
          runId: "run-local-replay",
        }),
      );

      const { result } = renderHook(() =>
        useEvalHandlers({
          ...defaultProps,
          selectedSuiteEntry: selectedSuiteEntry as any,
        }),
      );

      const mockSuite = {
        _id: "suite-local",
        name: "Local Replay Suite",
        description: "A locally replayed suite",
        source: "sdk",
        environment: { servers: ["server-1"] },
      };

      await act(async () => {
        await result.current.handleReplayRun(
          mockSuite as any,
          {
            _id: "run-source-local",
            hasServerReplayConfig: true,
          } as any,
        );
      });

      expect(mockAuthFetch).toHaveBeenCalledWith(
        "/api/mcp/evals/replay-run",
        expect.objectContaining({
          method: "POST",
          headers: { "Content-Type": "application/json" },
        }),
      );
    });

    it("posts to the hosted replay endpoint for a specific run", async () => {
      mockIsHostedMode.mockReturnValue(true);

      const selectedSuiteEntry = {
        latestRun: {
          _id: "run-latest",
          hasServerReplayConfig: true,
        },
        recentRuns: [
          {
            _id: "run-replayable",
            hasServerReplayConfig: true,
            passCriteria: { minimumPassRate: 88 },
          },
        ],
      };

      mockAuthFetch.mockResolvedValue(
        createFetchResponse({
          success: true,
          suiteId: "suite-456",
          runId: "run-new",
        }),
      );

      const { result } = renderHook(() =>
        useEvalHandlers({
          ...defaultProps,
          selectedSuiteEntry: selectedSuiteEntry as any,
        }),
      );

      const mockSuite = {
        _id: "suite-456",
        name: "Replay Suite",
        description: "A replayable CI suite",
        source: "sdk",
        environment: { servers: ["server-1"] },
        defaultPassCriteria: { minimumPassRate: 75 },
      };

      await act(async () => {
        await result.current.handleReplayRun(
          mockSuite as any,
          {
            _id: "run-replayable",
            hasServerReplayConfig: true,
            passCriteria: { minimumPassRate: 88 },
          } as any,
        );
      });

      expect(mockAuthFetch).toHaveBeenCalledWith(
        "/api/web/evals/replay-run",
        expect.objectContaining({
          method: "POST",
          headers: { "Content-Type": "application/json" },
        }),
      );

      const callArgs = mockAuthFetch.mock.calls[0];
      const requestBody = JSON.parse(callArgs[1].body);
      expect(requestBody).toMatchObject({
        runId: "run-replayable",
        passCriteria: { minimumPassRate: 88 },
      });
      expect(requestBody.convexAuthToken).toBeUndefined();

      expect(mockNavigateToCiEvalsRoute).toHaveBeenCalledWith({
        type: "run-detail",
        suiteId: "suite-456",
        runId: "run-new",
        insightsFocus: true,
      });
    });
  });

  describe("handleGenerateTests", () => {
    it("uses authFetch for /api/mcp/evals/generate-tests endpoint", async () => {
      mockAuthFetch.mockResolvedValue(
        createFetchResponse({
          tests: [
            {
              title: "Generated Test",
              query: "Test query",
              expectedToolCalls: [],
            },
          ],
        }),
      );

      const { result } = renderHook(() => useEvalHandlers(defaultProps));

      await act(async () => {
        await result.current.handleGenerateTests("suite-123", ["server-1"]);
      });

      // Verify authFetch was called with the correct endpoint
      expect(mockAuthFetch).toHaveBeenCalledWith(
        API_ENDPOINTS.EVALS_GENERATE_TESTS,
        expect.objectContaining({
          method: "POST",
          headers: { "Content-Type": "application/json" },
        }),
      );
    });

    it("passes serverIds and convexAuthToken in request body", async () => {
      mockAuthFetch.mockResolvedValue(createFetchResponse({ tests: [] }));

      const { result } = renderHook(() => useEvalHandlers(defaultProps));

      await act(async () => {
        await result.current.handleGenerateTests("suite-123", [
          "server-1",
          "server-2",
        ]);
      });

      const callArgs = mockAuthFetch.mock.calls[0];
      const requestBody = JSON.parse(callArgs[1].body);

      expect(requestBody).toMatchObject({
        serverIds: ["server-1", "server-2"],
        convexAuthToken: "mock-access-token",
      });
    });

    it("does not use regular fetch for /api/mcp/evals/generate-tests", async () => {
      const originalFetch = global.fetch;
      const fetchSpy = vi
        .fn()
        .mockResolvedValue(createFetchResponse({ tests: [] }));
      global.fetch = fetchSpy;

      // Re-mock authFetch to ensure it's the one being called
      mockAuthFetch.mockResolvedValue(createFetchResponse({ tests: [] }));

      const { result } = renderHook(() => useEvalHandlers(defaultProps));

      await act(async () => {
        await result.current.handleGenerateTests("suite-123", ["server-1"]);
      });

      // Verify regular fetch was NOT called with the generate-tests endpoint
      const fetchCalls = fetchSpy.mock.calls.filter(
        (call) =>
          typeof call[0] === "string" &&
          call[0].includes("/api/mcp/evals/generate-tests"),
      );
      expect(fetchCalls).toHaveLength(0);

      // Verify authFetch WAS called
      expect(mockAuthFetch).toHaveBeenCalled();

      global.fetch = originalFetch;
    });

    it("creates test cases from generated tests", async () => {
      mockAuthFetch.mockResolvedValue(
        createFetchResponse({
          tests: [
            {
              title: "Generated Test 1",
              query: "Query 1",
              expectedToolCalls: ["tool1"],
            },
            {
              title: "Generated Test 2",
              query: "Query 2",
              expectedToolCalls: ["tool2"],
            },
          ],
        }),
      );

      mockMutations.createTestCaseMutation.mockResolvedValue(
        "new-test-case-id",
      );

      const { result } = renderHook(() => useEvalHandlers(defaultProps));

      await act(async () => {
        await result.current.handleGenerateTests("suite-123", ["server-1"]);
      });

      // Verify test cases were created
      expect(mockMutations.createTestCaseMutation).toHaveBeenCalledTimes(2);
    });

    it("handles API errors gracefully", async () => {
      mockAuthFetch.mockResolvedValue(
        createFetchResponse({ error: "API Error" }, 500),
      );

      const { result } = renderHook(() => useEvalHandlers(defaultProps));

      // Should not throw
      await act(async () => {
        await result.current.handleGenerateTests("suite-123", ["server-1"]);
      });

      // Verify no test cases were created on error
      expect(mockMutations.createTestCaseMutation).not.toHaveBeenCalled();
    });
  });

  describe("auth token inclusion", () => {
    it("includes convexAuthToken in local handleRerun request", async () => {
      mockGetAccessToken.mockResolvedValue("specific-access-token");

      const { result } = renderHook(() => useEvalHandlers(defaultProps));

      const mockSuite = {
        _id: "suite-123",
        name: "Test Suite",
        description: "A test suite",
        environment: { servers: ["server-1"] },
      };

      await act(async () => {
        await result.current.handleRerun(mockSuite as any);
      });

      const callArgs = mockAuthFetch.mock.calls[0];
      const requestBody = JSON.parse(callArgs[1].body);

      expect(requestBody.convexAuthToken).toBe("specific-access-token");
    });

    it("includes convexAuthToken in local handleGenerateTests request", async () => {
      mockGetAccessToken.mockResolvedValue("another-access-token");
      mockAuthFetch.mockResolvedValue(createFetchResponse({ tests: [] }));

      const { result } = renderHook(() => useEvalHandlers(defaultProps));

      await act(async () => {
        await result.current.handleGenerateTests("suite-123", ["server-1"]);
      });

      const callArgs = mockAuthFetch.mock.calls[0];
      const requestBody = JSON.parse(callArgs[1].body);

      expect(requestBody.convexAuthToken).toBe("another-access-token");
    });

    it("omits convexAuthToken in hosted handleReplayRun requests", async () => {
      mockIsHostedMode.mockReturnValue(true);
      mockGetAccessToken.mockResolvedValue("hosted-access-token");

      mockAuthFetch.mockResolvedValue(
        createFetchResponse({
          success: true,
          suiteId: "suite-456",
          runId: "run-new",
        }),
      );

      const { result } = renderHook(() =>
        useEvalHandlers({
          ...defaultProps,
          selectedSuiteEntry: {
            latestRun: {
              _id: "run-replayable",
              hasServerReplayConfig: true,
            },
            recentRuns: [],
          } as any,
        }),
      );

      await act(async () => {
        await result.current.handleReplayRun(
          {
            _id: "suite-456",
            name: "Replay Suite",
            description: "A replayable CI suite",
            source: "sdk",
            environment: { servers: ["server-1"] },
          } as any,
          {
            _id: "run-replayable",
            hasServerReplayConfig: true,
          } as any,
        );
      });

      const callArgs = mockAuthFetch.mock.calls[0];
      const requestBody = JSON.parse(callArgs[1].body);
      expect(requestBody.convexAuthToken).toBeUndefined();
    });
  });

  describe("state management", () => {
    it("sets isGeneratingTests to true during generation", async () => {
      const deferred = createDeferred<Response>();
      mockAuthFetch.mockReturnValue(deferred.promise);

      const { result } = renderHook(() => useEvalHandlers(defaultProps));

      expect(result.current.isGeneratingTests).toBe(false);

      act(() => {
        result.current.handleGenerateTests("suite-123", ["server-1"]);
      });

      await waitFor(() => {
        expect(result.current.isGeneratingTests).toBe(true);
      });

      // Resolve the promise
      await act(async () => {
        deferred.resolve(createFetchResponse({ tests: [] }));
      });

      await waitFor(() => {
        expect(result.current.isGeneratingTests).toBe(false);
      });
    });

    it("sets rerunningSuiteId during rerun", async () => {
      const deferred = createDeferred<Response>();
      mockAuthFetch.mockReturnValue(deferred.promise);

      const { result } = renderHook(() => useEvalHandlers(defaultProps));

      const mockSuite = {
        _id: "suite-789",
        name: "Test Suite",
        description: "A test suite",
        environment: { servers: ["server-1"] },
      };

      expect(result.current.rerunningSuiteId).toBe(null);

      act(() => {
        result.current.handleRerun(mockSuite as any);
      });

      await waitFor(() => {
        expect(result.current.rerunningSuiteId).toBe("suite-789");
      });

      // Resolve the promise
      await act(async () => {
        deferred.resolve(createFetchResponse({ success: true }));
      });

      await waitFor(() => {
        expect(result.current.rerunningSuiteId).toBe(null);
      });
    });
  });
});
