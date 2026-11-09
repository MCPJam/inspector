import { describe, expect, expectTypeOf, it } from "vitest";
import {
  PlatformApiClient,
  type PlatformWidgetSessionCreated,
  type PlatformWidgetSessionStepResult,
} from "../../src/platform/index.js";

function setup(results: Array<{ status?: number; body: unknown }>) {
  const requests: Array<{
    url: string;
    method: string;
    body: unknown;
    headers: Headers;
  }> = [];
  let credential = 0;
  const fetchImpl: typeof fetch = async (input, init) => {
    requests.push({
      url: String(input),
      method: init?.method ?? "GET",
      body: typeof init?.body === "string" ? JSON.parse(init.body) : undefined,
      headers: new Headers(init?.headers),
    });
    const next = results.shift();
    if (!next) throw new Error("Unexpected extra request");
    return Response.json(next.body, { status: next.status ?? 200 });
  };
  const client = new PlatformApiClient({
    baseUrl: "http://localhost:6274/api/v1",
    getAuth: () => `credential-${++credential}`,
    fetch: fetchImpl,
  });
  return { client, requests };
}

describe("retained widget session client", () => {
  it("keeps all five operations on the encoded owner target and refreshes credentials", async () => {
    const created = {
      status: "rendered",
      elapsedMs: 12,
      sessionId: "view/1",
      expiresAt: 500,
      idleTimeoutMs: 300,
    };
    const snapshot = {
      snapshot: {
        mode: "a11y",
        tree: "button Save",
        elements: [{ role: { role: "button", name: "Save" } }],
        capturedAt: 10,
      },
      expiresAt: 600,
    };
    const action = {
      action: { action: "left_click", coordinate: [20, 30] },
      widgetToolCalls: [],
      elapsedMs: 5,
      expiresAt: 700,
    };
    const stepResult = {
      step: { kind: "click", target: { testId: "save" } },
      ok: true,
      widgetToolCalls: [],
      followUps: ["Saved"],
      elapsedMs: 8,
      expiresAt: 800,
    };
    const { client, requests } = setup(
      [created, snapshot, action, stepResult, { closed: false }].map(
        (body) => ({ body })
      )
    );
    const scope = { projectId: "project/one", serverId: "server?#" };
    const target = { ...scope, sessionId: "view/1" };
    const body = {
      toolName: "show",
      parameters: { part: "bolt" },
      viewport: { width: 800, height: 600 },
      clientCapabilities: { forms: true },
    };
    const opened = await client.createServerWidgetSession({ ...scope, body });
    expectTypeOf(opened).toEqualTypeOf<PlatformWidgetSessionCreated>();
    expect(opened).toEqual(created);
    expect(await client.getServerWidgetSessionSnapshot(target)).toEqual(
      snapshot
    );
    expect(
      await client.executeServerWidgetSessionAction({
        ...target,
        body: { action: { action: "left_click", coordinate: [20, 30] } },
      })
    ).toEqual(action);
    const stepBody = {
      step: { kind: "click" as const, target: { testId: "save" } },
      priorWidgetToolCalls: [
        { name: "read", args: {}, ok: true, elapsedMs: 2 },
      ],
    };
    const stepped = await client.executeServerWidgetSessionStep({
      ...target,
      body: stepBody,
    });
    expectTypeOf(stepped).toEqualTypeOf<PlatformWidgetSessionStepResult>();
    expect(stepped).toEqual(stepResult);
    expect(await client.closeServerWidgetSession(target)).toEqual({
      closed: false,
    });
    const base =
      "http://localhost:6274/api/v1/projects/project%2Fone/servers/server%3F%23/widget-sessions";
    expect(requests.map(({ url, method }) => [method, url])).toEqual([
      ["POST", base],
      ["GET", `${base}/view%2F1/snapshot`],
      ["POST", `${base}/view%2F1/action`],
      ["POST", `${base}/view%2F1/scripted-step`],
      ["DELETE", `${base}/view%2F1`],
    ]);
    expect(
      requests.map((request) => request.headers.get("authorization"))
    ).toEqual(
      [
        "credential-1",
        "credential-2",
        "credential-3",
        "credential-4",
        "credential-5",
      ].map((token) => `Bearer ${token}`)
    );
    expect(requests.map((request) => request.body)).toEqual([
      body,
      undefined,
      { action: action.action },
      stepBody,
      undefined,
    ]);
  });

  it("returns a failed render without inventing a session or retrying execution", async () => {
    const { client, requests } = setup([
      { body: { status: "render_error", elapsedMs: 5 } },
    ]);
    const result = await client.createServerWidgetSession({
      projectId: "p",
      serverId: "s",
      body: { toolName: "show" },
    });
    expect(result.sessionId).toBeUndefined();
    expect(result.status).toBe("render_error");
    expect(requests).toHaveLength(1);
  });

  it("preserves the hosted/local refusal instead of retrying against another endpoint", async () => {
    const { client, requests } = setup([
      {
        status: 404,
        body: {
          code: "NOT_FOUND",
          message: "Retained widget sessions require a local Inspector.",
        },
      },
    ]);
    await expect(
      client.getServerWidgetSessionSnapshot({
        projectId: "p",
        serverId: "s",
        sessionId: "v",
      })
    ).rejects.toMatchObject({ code: "NOT_FOUND", status: 404 });
    expect(requests).toHaveLength(1);
  });

  it.each(["create", "action", "step"] as const)(
    "does not replay a failed %s mutation",
    async (operation) => {
      const { client, requests } = setup([
        {
          status: 503,
          body: {
            code: "FEATURE_NOT_SUPPORTED",
            message: "Session unavailable",
          },
        },
      ]);
      const target = { projectId: "p", serverId: "s", sessionId: "v" };
      const request =
        operation === "create"
          ? client.createServerWidgetSession({
              ...target,
              body: { toolName: "show" },
            })
          : operation === "action"
            ? client.executeServerWidgetSessionAction({
                ...target,
                body: { action: { action: "left_click", coordinate: [1, 2] } },
              })
            : client.executeServerWidgetSessionStep({
                ...target,
                body: { step: { kind: "click", target: { testId: "save" } } },
              });
      await expect(request).rejects.toMatchObject({ status: 503 });
      expect(requests).toHaveLength(1);
    }
  );
});
