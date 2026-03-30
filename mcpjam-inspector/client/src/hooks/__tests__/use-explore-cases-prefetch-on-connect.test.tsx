import { describe, it, expect, vi, beforeEach } from "vitest";
import { renderHook, waitFor } from "@testing-library/react";
import { createServer, createHttpServerConfig } from "@/test/factories";
import type { ServerWithName } from "@/hooks/use-app-state";

const { generateAndPersistEvalTestsMock } = vi.hoisted(() => ({
  generateAndPersistEvalTestsMock: vi.fn().mockResolvedValue({
    skippedBecauseExistingCases: false,
    createdCount: 1,
    apiReturnedTests: 1,
  }),
}));

const convexQueryMock = vi.hoisted(() =>
  vi.fn().mockResolvedValue([] as unknown[]),
);

const createTestSuiteMutationMock = vi.hoisted(() =>
  vi.fn().mockResolvedValue({ _id: "suite_new" }),
);
const updateTestSuiteMutationMock = vi.hoisted(() =>
  vi.fn().mockResolvedValue(undefined),
);
const createTestCaseMutationMock = vi.hoisted(() =>
  vi.fn().mockResolvedValue(undefined),
);

vi.mock("@/lib/config", () => ({
  HOSTED_MODE: true,
}));

vi.mock("@/lib/evals/generate-and-persist-tests", () => ({
  generateAndPersistEvalTests: generateAndPersistEvalTestsMock,
}));

vi.mock("posthog-js", () => ({
  default: {
    capture: vi.fn(),
  },
}));

vi.mock("sonner", () => ({
  toast: {
    error: vi.fn(),
  },
}));

vi.mock("@workos-inc/authkit-react", () => ({
  useAuth: () => ({
    user: { id: "user_1" },
    getAccessToken: vi.fn().mockResolvedValue("workos-token"),
  }),
}));

vi.mock("convex/react", () => ({
  useConvex: () => ({ query: convexQueryMock }),
  useConvexAuth: () => ({ isAuthenticated: true }),
  useQuery: () => [] as unknown[],
  useMutation: (name: string) => {
    if (name === "testSuites:createTestSuite") {
      return createTestSuiteMutationMock;
    }
    if (name === "testSuites:updateTestSuite") {
      return updateTestSuiteMutationMock;
    }
    if (name === "testSuites:createTestCase") {
      return createTestCaseMutationMock;
    }
    return vi.fn();
  },
}));

import { useExploreCasesPrefetchOnConnect } from "../use-explore-cases-prefetch-on-connect";

describe("useExploreCasesPrefetchOnConnect", () => {
  const workspaceId = "ws_test";

  beforeEach(() => {
    vi.clearAllMocks();
    convexQueryMock.mockResolvedValue([]);
    generateAndPersistEvalTestsMock.mockResolvedValue({
      skippedBecauseExistingCases: false,
      createdCount: 1,
      apiReturnedTests: 1,
    });
  });

  function oauthConnectedServer(
    options: { token?: string; name?: string } = {},
  ): ServerWithName {
    const name = options.name ?? "oauth-server";
    return createServer({
      name,
      connectionStatus: "connected",
      useOAuth: true,
      config: createHttpServerConfig(`https://${name}.example/mcp`),
      ...(options.token
        ? {
            oauthTokens: {
              access_token: options.token,
              token_type: "Bearer",
              expires_in: 3600,
            },
          }
        : {}),
    });
  }

  it("does not generate while hosted OAuth prerequisites are missing", async () => {
    const { rerender } = renderHook(
      ({
        server,
        hostedServerId,
      }: {
        server: ServerWithName;
        hostedServerId?: string | null;
      }) =>
        useExploreCasesPrefetchOnConnect(workspaceId, server, hostedServerId),
      {
        initialProps: {
          server: createServer({ connectionStatus: "disconnected" }),
          hostedServerId: undefined as string | undefined,
        },
      },
    );

    rerender({
      server: oauthConnectedServer(),
      hostedServerId: undefined,
    });

    await waitFor(() => {
      expect(createTestSuiteMutationMock).not.toHaveBeenCalled();
      expect(generateAndPersistEvalTestsMock).not.toHaveBeenCalled();
    });
  });

  it("runs generation once hosted OAuth token and Convex server id are present", async () => {
    const { rerender } = renderHook(
      ({
        server,
        hostedServerId,
      }: {
        server: ServerWithName;
        hostedServerId?: string | null;
      }) =>
        useExploreCasesPrefetchOnConnect(workspaceId, server, hostedServerId),
      {
        initialProps: {
          server: createServer({ connectionStatus: "disconnected" }),
          hostedServerId: undefined as string | undefined,
        },
      },
    );

    rerender({
      server: oauthConnectedServer(),
      hostedServerId: undefined,
    });

    await waitFor(() => {
      expect(generateAndPersistEvalTestsMock).not.toHaveBeenCalled();
    });

    rerender({
      server: oauthConnectedServer({ token: "oauth-access" }),
      hostedServerId: "convex_srv_1",
    });

    await waitFor(() => {
      expect(generateAndPersistEvalTestsMock).toHaveBeenCalledTimes(1);
    });

    expect(generateAndPersistEvalTestsMock).toHaveBeenCalledWith(
      expect.objectContaining({
        workspaceId,
        suiteId: "suite_new",
        serverIds: ["oauth-server"],
        skipIfExistingCases: true,
      }),
    );
  });
});
