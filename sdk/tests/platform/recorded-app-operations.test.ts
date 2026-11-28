import { describe, expect, it, vi } from "vitest";
import { PlatformApiClient } from "../../src/platform/client.js";
import type { ClientActionReceipt } from "../../src/contract/client-action-receipt.js";
import {
  compileRecordedAppCaseOperation,
  summarizeRecordedAppActionsOperation,
} from "../../src/platform/recorded-app-operations.js";

const recording = {
  apps: [{ toolCallId: "open-1", toolName: "open_form", serverId: "original" }],
  actions: [
    {
      toolCallId: "open-1",
      stepIndex: 0,
      promptIndex: 0,
      elapsedMs: 10,
      ts: 100,
      action: "left_click",
      actor: "persona",
      target: { role: "button", name: "Save" },
      requiresModelFollowUp: false,
      ok: true,
    },
  ],
  summary: { attempted: 1, succeeded: 1, elapsedMs: 10 },
  truncated: false,
};

function setup(clientActions?: ClientActionReceipt[]) {
  const requests = vi.fn(async (target: unknown) => {
    const url = new URL(String(target));
    const sessionId = url.pathname.split("/").at(-2);
    if (!url.pathname.endsWith("/trace")) {
      return Response.json({
        messages: [
          {
            role: "assistant",
            content: [
              {
                type: "tool-call",
                toolCallId: "open-1",
                input: { title: "Fixture" },
              },
            ],
          },
        ],
      });
    }
    if (sessionId === "missing") {
      return Response.json({ code: "NOT_FOUND" }, { status: 404 });
    }
    return Response.json({
      sessionId,
      projectId: "project-1",
      origin: "swarm",
      traceVersion: 1,
      turns: [],
      turnCount: 0,
      ...(sessionId === "counted" ? { appRecording: recording } : {}),
      ...(sessionId === "counted" && clientActions ? { clientActions } : {}),
    });
  });
  return {
    requests,
    client: new PlatformApiClient({
      baseUrl: "https://fixture.example/api/v1",
      getAuth: () => "test",
      fetch: requests,
    }),
  };
}

describe("recorded app operations", () => {
  it("compiles from the session trace against a compatible replacement server", async () => {
    const { client, requests } = setup();
    const output = await compileRecordedAppCaseOperation.execute(
      {
        sessionId: "counted",
        toolCallId: "open-1",
        title: "Save form",
        caseId: "case-1",
        serverName: "Forms replacement",
        serverId: "replacement",
        assertions: [
          { kind: "textVisible", toolName: "open_form", text: "Saved" },
        ],
      },
      { client }
    );
    expect(output.case.steps).toMatchObject([
      {
        kind: "toolCall",
        serverId: "replacement",
        toolName: "open_form",
        arguments: { title: "Fixture" },
      },
      { kind: "interact", action: { kind: "click" } },
      { kind: "assert" },
    ]);
    const url = new URL(String(requests.mock.calls[0]?.[0]));
    expect(url.searchParams.get("includeAppRecording")).toBe("true");
    expect(url.searchParams.get("includeSpans")).toBe("false");
  });

  it("counts coverage for missing and ungraded sessions without duplicating actions", async () => {
    const { client } = setup();
    const result = await summarizeRecordedAppActionsOperation.execute(
      {
        sessionIds: ["counted", "counted", "empty", "missing"],
      },
      { client }
    );
    expect(result).toEqual({
      sessions: { requested: 3, counted: 1, ungraded: 1, unavailable: 1 },
      actions: recording.summary,
    });
  });

  it("replays ordered decisions and requires replacement values for redacted forms", async () => {
    const shared = {
      actor: "persona",
      surface: "client",
      serverId: "original",
      startedAt: 30,
      elapsedMs: 4,
    } as const;
    const questionId = "12345678-1234-4234-a234-000000000003";
    const { client } = setup([
      {
        ...shared,
        order: 0,
        id: "12345678-1234-4234-a234-000000000001",
        kind: "approval",
        outcome: "denied",
        invocationId: "discard-1",
        toolName: "discard_form",
      },
      {
        ...shared,
        order: 1,
        id: "12345678-1234-4234-a234-000000000002",
        kind: "approval",
        outcome: "approved",
        invocationId: "open-1",
        toolName: "open_form",
      },
      {
        ...shared,
        order: 2,
        id: questionId,
        kind: "question",
        outcome: "accepted",
        toolName: "open_form",
      },
    ]);
    const input = {
      sessionId: "counted",
      toolCallId: "open-1",
      title: "Save form",
      caseId: "case-1",
      serverName: "Forms replacement",
      assertions: [
        { kind: "textVisible" as const, toolName: "open_form", text: "Saved" },
      ],
    };
    await expect(
      compileRecordedAppCaseOperation.execute(input, { client })
    ).rejects.toThrow(questionId);
    const { case: testCase } = await compileRecordedAppCaseOperation.execute(
      {
        ...input,
        questionReplies: {
          [questionId]: { action: "accept", content: { size: "small" } },
        },
      },
      { client }
    );
    expect(testCase.steps.slice(0, 2)).toMatchObject([
      {
        kind: "toolCall",
        approval: "deny",
        toolName: "discard_form",
        arguments: {},
      },
      { kind: "toolCall", approval: "approve", toolName: "open_form" },
    ]);
    expect(testCase.inputAnswers).toEqual([
      {
        tool: "open_form",
        server: "Forms replacement",
        action: "accept",
        content: { size: "small" },
      },
    ]);
    await expect(
      summarizeRecordedAppActionsOperation.execute(
        { sessionIds: ["counted"] },
        { client }
      )
    ).resolves.toMatchObject({
      clientActions: {
        approval: {
          attempted: 2,
          outcomes: { approved: 1, denied: 1 },
          elapsedMs: 8,
        },
        question: { attempted: 1, outcomes: { accepted: 1 }, elapsedMs: 4 },
      },
    });
  });
});
