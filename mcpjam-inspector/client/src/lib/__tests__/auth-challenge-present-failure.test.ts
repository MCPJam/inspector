import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AuthChallengeSignal } from "@mcpjam/sdk/browser";
import type { ServerWithName } from "@/state/app-types";

const { applyToolCallAuthChallengeMock, reportCaughtMock } = vi.hoisted(
  () => ({
    applyToolCallAuthChallengeMock: vi.fn(),
    reportCaughtMock: vi.fn(),
  }),
);
vi.mock("@/state/oauth-orchestrator", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/state/oauth-orchestrator")>()),
  applyToolCallAuthChallenge: applyToolCallAuthChallengeMock,
}));
vi.mock("@/lib/error-reporting", () => ({ reportCaught: reportCaughtMock }));
vi.mock("@/lib/analytics", () => ({ track: vi.fn() }));

import {
  AUTH_CHALLENGE_PRESENT_FAILED_MESSAGE,
  presentAuthChallenge,
  useAuthChallengeCardStore,
} from "../auth-challenge-lifecycle";

const server = {
  name: "orders",
  config: { type: "http", url: "https://orders.example/mcp" },
  lastConnectionTime: new Date(),
  connectionStatus: "connected",
  retryCount: 0,
  enabled: true,
} as unknown as ServerWithName;

const signal: AuthChallengeSignal = {
  source: "http_401",
  requiredScope: "orders:read",
  resourceMetadataUrl:
    "https://orders.example/.well-known/oauth-protected-resource/mcp",
  effectiveAuth: "discover",
  facets: {
    challengeHeader: "bearer",
    hasResourceMetadata: true,
    hasScope: true,
    hasErrorParams: false,
  },
};

describe("presentAuthChallenge when presenting fails", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    useAuthChallengeCardStore.setState({ cards: {} });
  });

  it("resolves to a notice and reports the error instead of rejecting", async () => {
    const failure = new Error("storage unavailable");
    applyToolCallAuthChallengeMock.mockRejectedValue(failure);

    const presentation = await presentAuthChallenge({
      server,
      signal,
      surface: "tools",
      operation: { method: "tools/call", operation: "list_orders" },
      readOnly: true,
    });

    expect(presentation).toEqual({
      kind: "notice",
      reason: "failed",
      message: AUTH_CHALLENGE_PRESENT_FAILED_MESSAGE,
    });
    expect(reportCaughtMock).toHaveBeenCalledWith(failure, {
      source: "auth_challenge_present",
    });
    expect(useAuthChallengeCardStore.getState().cards).toEqual({});
  });
});
