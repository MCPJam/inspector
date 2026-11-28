import { describe, expect, it, vi } from "vitest";
import { PlatformApiClient } from "../../src/platform/client.js";
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

function setup() {
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
});
