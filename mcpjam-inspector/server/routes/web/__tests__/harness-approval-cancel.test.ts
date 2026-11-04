import { beforeEach, expect, it, vi } from "vitest";
import { harnessForwardingApprovals } from "../harness-forwarding";
import { forwardingApprovalId } from "@/shared/forwarding-approval";

const state = vi.hoisted(() => ({
  userId: "user",
  decision: vi.fn(),
}));
const owner = {
  kind: "chat" as const,
  userId: "user",
  serverId: "server",
  harnessSessionId: "lane",
};
vi.mock("../../v1/convex-client", () => ({
  createConvexClient: () => ({ query: async () => ({ _id: state.userId }) }),
}));
vi.mock(
  "../../../utils/harness/forwarding/execution-control",
  async (original) => ({
    ...(await original<
      typeof import("../../../utils/harness/forwarding/execution-control")
    >()),
    createExecutionControl: () => ({
      approvalContext: async () => ({
        authority: { projectId: "project" },
        params: {},
        approval: { approvalId: "signed", nonceHash: "nonce" },
      }),
      answerApproval: state.decision,
    }),
  }),
);
vi.mock("../../../utils/harness/forwarding/approval", () => ({
  readExecutionInput: async () => ({ value: { name: "write" } }),
}));
vi.mock("../../../utils/tool-approval-token", () => ({
  toolApprovalClaimKey: () => "nonce",
  verifyToolApprovalId: () => ({ ok: true }),
}));
beforeEach(() => {
  state.userId = "user";
  state.decision.mockReset().mockResolvedValue({ state: "cancelled" });
});
const request = (extra: object = {}) =>
  harnessForwardingApprovals.request("/approval", {
    method: "POST",
    headers: {
      authorization: "Bearer test",
      "content-type": "application/json",
    },
    body: JSON.stringify({
      id: forwardingApprovalId("execution", owner, "signed"),
      approved: false,
      cancelled: true,
      ...extra,
    }),
  });
it("cancels only the signed-in owner's existing pending approval", async () => {
  expect((await request()).status).toBe(200);
  expect(state.decision).toHaveBeenCalledExactlyOnceWith(
    "execution",
    "nonce",
    "cancelled",
  );
});
it("rejects cancellation by a different user", async () => {
  state.userId = "other";
  expect((await request()).status).toBe(403);
  expect(state.decision).not.toHaveBeenCalled();
});
it("rejects conflicting approve and cancel decisions", async () => {
  expect((await request({ approved: true })).status).toBe(409);
  expect(state.decision).not.toHaveBeenCalled();
});
it("cannot rewrite a decision which already won the race", async () => {
  state.decision.mockResolvedValue({ state: "approved" });
  expect((await request()).status).toBe(409);
});
