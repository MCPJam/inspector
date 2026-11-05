import { afterEach, expect, it, vi } from "vitest";
import { startForwardingApprovalPresentation } from "../approval";
import { createExecutionControl } from "../execution-control";
import { readForwardingApprovalId } from "@/shared/forwarding-approval";
afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});
it("flushes final authorization without creating a second model tool call", async () => {
  vi.stubEnv("INSPECTOR_SERVICE_TOKEN", "approval-presentation-test-secret");
  const owner = {
    kind: "chat" as const,
    userId: "user",
    serverId: "server",
    harnessSessionId: "lane",
  };
  const row = {
    _id: "execution",
    method: "tools/call",
    turnId: "turn",
    authority: {
      userId: "user",
      projectId: "project",
      sessionId: "lane",
      serverId: "server",
      accountId: "account",
    },
    params: {
      json: JSON.stringify({
        present: true,
        value: { name: "write", arguments: { value: 1 } },
      }),
      url: null,
      bytes: 64,
      truncated: false,
    },
    result: null,
    complete: false,
    state: "prepared",
    approval: {
      nonceHash: "nonce",
      approvalId: "signed",
      state: "pending",
      expiresAt: Date.now() + 60000,
    },
  };
  const control = createExecutionControl({
    owner,
    baseUrl: "https://backend.example",
    fetch: async () => Response.json([row]),
  });
  const write = vi.fn();
  const stop = startForwardingApprovalPresentation({
    control,
    owner,
    turnId: "turn",
    promptIndex: 3,
    writer: { write },
  });
  await vi.waitFor(() =>
    expect(
      write.mock.calls.some(([part]) => part.type === "tool-approval-request"),
    ).toBe(true),
  );
  const request = write.mock.calls.find(
    ([part]) => part.type === "tool-approval-request",
  )![0];
  expect(readForwardingApprovalId(request.approvalId)).toEqual({
    executionId: "execution",
    owner,
    approvalId: "signed",
  });
  vi.spyOn(Date, "now").mockReturnValue(Date.now() + 20_000);
  await vi.waitFor(() =>
    expect(write).toHaveBeenCalledWith({
      type: "data-trace-event",
      data: { type: "heartbeat", turnId: "turn", promptIndex: 3 },
      transient: true,
    }),
  );
  Object.assign(row, { state: "settled", outcome: "success" });
  await stop();
  expect(
    write.mock.calls.filter(([part]) => part.type === "tool-input-available"),
  ).toHaveLength(1);
  expect(
    write.mock.calls.find(
      ([part]) => part.type === "tool-output-available",
    )![0],
  ).toMatchObject({
    toolCallId: "mcpjam-forwarding:execution",
    output: { authorization: "success" },
  });
  expect(
    write.mock.calls.filter(([part]) => part.type === "data-trace-event"),
  ).toHaveLength(1);
});
