import { beforeEach, describe, expect, it, vi } from "vitest";
const f = vi.hoisted(() => ({ fetch: vi.fn() }));
vi.mock("@/lib/session-token", () => ({ authFetch: f.fetch }));
import { createServerSettingsApi } from "../server-settings-api";
import { settingsFixture } from "@/shared/__tests__/plugin-settings-fixture";
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
