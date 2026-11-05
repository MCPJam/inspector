import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
const f = vi.hoisted(() => ({ fetch: vi.fn() }));
vi.mock("@/lib/session-token", () => ({ authFetch: f.fetch }));
import { createServerSettingsApi } from "../server-settings-api";
import { settingsFixture } from "@/shared/__tests__/plugin-settings-fixture";
import { PLUGIN_APP_REPLY_MAX_BYTES, PLUGIN_APP_UI_MAX_BYTES } from "@/shared/plugin-app-ui-limits";
const scope = {
  projectId: "project",
  hostId: "host",
  threadId: "thread",
  pluginWorkspace: { version: 1 as const, workspaceId: "workspace" },
};
const response = (value: unknown, status = 200) =>
  new Response(JSON.stringify(value), { status });
const completed = (structuredContent: unknown) =>
  response({ status: "completed", result: { content: [], structuredContent } });
let calls: { path: string; body: any }[];
beforeEach(() => {
  calls = [];
  f.fetch.mockReset();
  f.fetch.mockImplementation(async (path: string, init: RequestInit) => {
    const body = JSON.parse(init.body as string);
    calls.push({ path, body });
    if (path.endsWith("/open") && !path.includes("/app/"))
      return response({ instanceToken: "original" });
    if (path.endsWith("/read")) return completed(settingsFixture());
    if (path.endsWith("/actions"))
      return response({ actions: [{ name: "reset", kind: "app" }] });
    if (path.endsWith("/app/open"))
      return response({
        childToken: crypto.randomUUID(),
        resourceUri: "ui://settings",
        widgetContent: { html: "<p>settings</p>" },
        appToolsEnabled: true,
      });
    if (path.endsWith("/action")) return completed({ ok: true });
    return response({ ok: true });
  });
});
describe("settings transport ownership", () => {
  it("preserves the server-resolved action title", async () => {
    const original = f.fetch.getMockImplementation()!;
    f.fetch.mockImplementation(async (path, init) =>
      path.endsWith("/actions")
        ? response({
            actions: [{ name: "reset", title: "Reset library", kind: "app" }],
          })
        : original(path, init),
    );
    const session = await createServerSettingsApi(
      scope,
      "server",
      vi.fn(),
    ).open(new AbortController().signal);
    expect(session.actions).toEqual([
      { name: "reset", title: "Reset library", kind: "app" },
    ]);
    await session.close();
  });

  it("reads once and retries a lost response with the exact original operation", async () => {
    const original = f.fetch.getMockImplementation()!;
    let lost = true;
    f.fetch.mockImplementation(async (path, init) => {
      if (path.endsWith("/read") && lost) {
        lost = false;
        calls.push({ path, body: JSON.parse(init.body) });
        throw new Error("lost");
      }
      return original(path, init);
    });
    const session = await createServerSettingsApi(
      scope,
      "server",
      vi.fn(),
    ).open(new AbortController().signal);
    const reads = calls.filter((call) => call.path.endsWith("/read"));
    expect(reads).toHaveLength(2);
    expect(reads[0].body).toEqual(reads[1].body);
    expect(session.controller.getSnapshot().draft.enabled).toBe(false);
    await session.close();
  });
  it("passes actual typed save arguments into the approval and keeps the same operation", async () => {
    const approve = vi.fn(async () => true);
    const original = f.fetch.getMockImplementation()!;
    f.fetch.mockImplementation(async (path, init) => {
      if (path.endsWith("/update")) {
        const body = JSON.parse(init.body);
        calls.push({ path, body });
        return body.approval
          ? completed({ values: { ...settingsFixture().values, count: 0 } })
          : response(
              {
                status: "approval_required",
                approval: {
                  id: "proof",
                  name: "save",
                  params: { name: "save", arguments: { set: body.set } },
                },
              },
              409,
            );
      }
      return original(path, init);
    });
    const session = await createServerSettingsApi(
      scope,
      "server",
      approve,
    ).open(new AbortController().signal);
    session.controller.edit("count", 0);
    await session.controller.save();
    expect(approve.mock.calls[0]?.[0]).toMatchObject({
      params: { arguments: { set: { count: 0 } } },
    });
    const updates = calls.filter((call) => call.path.endsWith("/update"));
    expect(updates[0].body.operationId).toBe(updates[1].body.operationId);
    expect(session.controller.getSnapshot().dirty).toBe(false);
    await session.close();
  });
  it("reopening an inline App keeps its original effect operation but uses a new child", async () => {
    const session = await createServerSettingsApi(
      scope,
      "server",
      vi.fn(),
    ).open(new AbortController().signal);
    const first = await session.openApp("reset", new AbortController().signal);
    await first.close();
    const second = await session.openApp("reset", new AbortController().signal);
    expect(first.childToken).not.toBe(second.childToken);
    const actions = calls.filter((call) => call.path.endsWith("/action"));
    expect(actions[0].body.operationId).toBe(actions[1].body.operationId);
    await second.close();
    await session.close();
  });
});


afterEach(() => vi.useRealTimers());
it.each(["read", "update", "action"] as const)(
  "keeps one declared Settings %s operation pending through human input",
  async (method) => {
    const original = f.fetch.getMockImplementation()!;
    let finish!: () => void;
    let dispatched = 0;
    let active: AbortSignal | undefined;
    let hold = method === "read";
    f.fetch.mockImplementation(async (path, init) => {
      if (hold && path.endsWith(`/${method}`)) {
        dispatched++;
        const body = JSON.parse(init.body);
        calls.push({ path, body });
        active = init.signal;
        await new Promise<void>((resolve) => {
          finish = resolve;
        });
        return completed(
          method === "read"
            ? settingsFixture()
            : method === "update"
              ? { values: { ...settingsFixture().values, count: 0 } }
              : { ok: true },
        );
      }
      return original(path, init);
    });
    const opening = createServerSettingsApi(scope, "server", vi.fn()).open(
      new AbortController().signal,
    );
    let session: Awaited<typeof opening> | undefined;
    let result: Promise<unknown> = opening;
    if (method !== "read") {
      session = await opening;
      hold = true;
      if (method === "update") {
        session.controller.edit("count", 0);
        result = session.controller.save();
      } else result = session.action("reset", new AbortController().signal);
    }
    await vi.waitFor(() => expect(finish).toBeDefined());
    vi.useFakeTimers();
    await vi.advanceTimersByTimeAsync(65000);
    expect(active?.aborted).toBe(false);
    expect(dispatched).toBe(1);
    finish();
    await result;
    if (!session) session = await opening;
    expect(dispatched).toBe(1);
    const preparation = calls.find(
      (call) =>
        call.path.endsWith("/renew") &&
        call.body.operation?.params.name === method,
    );
    expect(preparation?.body.operation.params.arguments).toEqual(
      method === "read"
        ? {}
        : method === "update"
          ? { set: { count: 0 } }
          : { toolName: "reset" },
    );
    await session.close();
  },
);


describe("Settings App reply bounds", () => {
  it("accepts server-sized HTML whose escaped JSON exceeds the Settings document cap", async () => {
    const original = f.fetch.getMockImplementation()!;
    const html = "<script>" + '\u0000"\\é'.repeat(230000) + "</script>";
    expect(new TextEncoder().encode(html).byteLength).toBeGreaterThan(
      1024 * 1024,
    );
    expect(new TextEncoder().encode(html).byteLength).toBeLessThan(
      PLUGIN_APP_UI_MAX_BYTES,
    );
    const body = {
      childToken: "child",
      resourceUri: "ui://settings",
      widgetContent: { html },
      appToolsEnabled: true,
    };
    const bytes = new TextEncoder().encode(JSON.stringify(body)).byteLength;
    expect(bytes).toBeGreaterThan(1024 * 1024);
    expect(bytes).toBeLessThan(PLUGIN_APP_REPLY_MAX_BYTES);
    f.fetch.mockImplementation((path, init) =>
      path.endsWith("/app/open") ? response(body) : original(path, init),
    );
    const session = await createServerSettingsApi(
      scope,
      "server",
      vi.fn(),
    ).open(new AbortController().signal);
    const app = await session.openApp("reset", new AbortController().signal);
    expect(app.widgetContent.html).toBe(html);
    expect(calls.filter((call) => call.path.endsWith("/action"))).toHaveLength(
      1,
    );
    await app.close();
    await session.close();
  });

  it("accepts a large result from a Settings App call", async () => {
    const original = f.fetch.getMockImplementation()!;
    const value = { text: "é".repeat(600000) };
    expect(
      new TextEncoder().encode(JSON.stringify(value)).byteLength,
    ).toBeGreaterThan(1024 * 1024);
    f.fetch.mockImplementation((path, init) =>
      path.endsWith("/app/call") ? completed(value) : original(path, init),
    );
    const session = await createServerSettingsApi(
      scope,
      "server",
      vi.fn(),
    ).open(new AbortController().signal);
    const app = await session.openApp("reset", new AbortController().signal);
    const result = await app.call("inspect", {}, new AbortController().signal);
    expect(result.structuredContent).toEqual(value);
    await app.close();
    await session.close();
  });

  it.each(["app-limit", "app-error", "call-error", "ordinary"] as const)(
    "refuses over-budget %s replies",
    async (kind) => {
      const original = f.fetch.getMockImplementation()!;
      const path =
        kind === "ordinary"
          ? "/read"
          : kind === "call-error"
            ? "/app/call"
            : "/app/open";
      const limit =
        kind === "app-limit" ? PLUGIN_APP_REPLY_MAX_BYTES : 1024 * 1024;
      f.fetch.mockImplementation((url, init) =>
        url.endsWith(path)
          ? new Response(JSON.stringify({ padding: "x".repeat(limit + 1) }), {
              status: kind.endsWith("error") ? 500 : 200,
            })
          : original(url, init),
      );
      const opening = createServerSettingsApi(scope, "server", vi.fn()).open(
        new AbortController().signal,
      );
      if (kind === "ordinary")
        await expect(opening).rejects.toThrow("SETTINGS_RESPONSE_LIMIT");
      else {
        const session = await opening;
        if (kind === "call-error") {
          const app = await session.openApp(
            "reset",
            new AbortController().signal,
          );
          await expect(
            app.call("inspect", {}, new AbortController().signal),
          ).rejects.toThrow("SETTINGS_RESPONSE_LIMIT");
          await app.close();
        } else {
          await expect(
            session.openApp("reset", new AbortController().signal),
          ).rejects.toThrow("SETTINGS_RESPONSE_LIMIT");
          expect(calls.some((call) => call.path.endsWith("/action"))).toBe(
            false,
          );
        }
        await session.close();
      }
    },
  );
});
