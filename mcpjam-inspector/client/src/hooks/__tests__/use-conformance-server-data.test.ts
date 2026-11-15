import { act, renderHook } from "@testing-library/react";
import { getFunctionName } from "convex/server";
import { convexToJson } from "convex/values";
import { beforeEach, describe, expect, it, vi } from "vitest";
const { client, save, queries } = vi.hoisted(() => ({
  client: { query: vi.fn() },
  save: vi.fn(),
  queries: vi.fn(),
}));
vi.mock("convex/react", () => ({
  useConvex: () => client,
  useMutation: () => save,
  useQueries: (args: unknown) => queries(args),
}));
import { useConformanceServerData } from "../use-conformance-server-data";
const props = {
  projectId: "proj_1",
  serversById: new Map([["srv_1", "alpha"]]),
  serversByName: new Map([["alpha", "srv_1"]]),
};
const inputs = { tasksProbe: { toolName: "task", arguments: { id: 3 } } };
const row = {
  serverId: "srv_1",
  defaultChecks: { oauth: false },
  defaultInputs: { tasksProbe: { toolName: "task", arguments: '{"id":3}' } },
  defaultAdvice: { tasksAdvice: [] },
};
describe("useConformanceServerData", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    queries.mockReturnValue({});
    client.query.mockResolvedValue(row);
    save.mockResolvedValue("settings_1");
  });
  it("loads just the target server and returns its checks, advice and inputs", async () => {
    const { result } = renderHook(() => useConformanceServerData(props));
    expect(client.query).not.toHaveBeenCalled();
    await act(async () => {
      expect(await result.current.loadDefaults("alpha")).toEqual({
        selection: { oauth: false, tasksAdvice: [] },
        inputs,
      });
    });
    expect(getFunctionName(client.query.mock.calls[0][0])).toBe(
      "conformanceSettings:getServerSettings",
    );
    expect(client.query.mock.calls[0][1]).toEqual({
      projectId: "proj_1",
      serverId: "srv_1",
    });
    expect(result.current.inputsByServer.alpha).toEqual(inputs);
    expect(result.current.defaultsByServer.alpha).toEqual({
      oauth: false,
      tasksAdvice: [],
    });
  });
  it("reacts to another browser and follows server renames by ID", async () => {
    const hook = renderHook((args) => useConformanceServerData(args), {
      initialProps: props,
    });
    await act(async () => {
      await hook.result.current.loadDefaults("alpha");
    });
    queries.mockReturnValue({ "proj_1:srv_1": { ...row, defaultInputs: {} } });
    hook.rerender({
      ...props,
      serversById: new Map([["srv_1", "renamed"]]),
      serversByName: new Map([["renamed", "srv_1"]]),
    });
    expect(hook.result.current.inputsByServer.renamed).toEqual({});
    expect(hook.result.current.inputsByServer.alpha).toBeUndefined();
  });
  it("does not leak defaults between projects with identical server names", async () => {
    const hook = renderHook((args) => useConformanceServerData(args), {
      initialProps: props,
    });
    await act(async () => {
      await hook.result.current.loadDefaults("alpha");
    });
    hook.rerender({ ...props, projectId: "proj_2" });
    expect(hook.result.current.inputsByServer).toEqual({});
    expect(hook.result.current.defaultsByServer).toEqual({});
  });
  it("saves checks, advice and cleared inputs atomically", async () => {
    const { result } = renderHook(() => useConformanceServerData(props));
    await act(async () => {
      await result.current.saveDefaults!(
        "alpha",
        { protocol: ["ping"], oauth: false, tasksAdvice: [] },
        {},
      );
    });
    expect(save).toHaveBeenCalledWith({
      projectId: "proj_1",
      serverId: "srv_1",
      defaultChecks: { protocol: ["ping"], oauth: false },
      defaultAdvice: { tasksAdvice: [] },
      defaultInputs: {},
    });
  });
  it("round-trips special JSON keys for every probe through the Convex boundary", async () => {
    const json = { filter: { $gt: 5 }, año: 2026, nested: { 確認: true } };
    const probes = {
      logProbe: { toolName: "log", level: "info" as const, arguments: json },
      inputRequiredProbe: { toolName: "ask", arguments: json },
      toolCallProbe: { toolName: "output", arguments: {} },
      tasksProbe: { toolName: "task", arguments: json, inputResponses: json },
    };
    const stored = {
      logProbe: { ...probes.logProbe, arguments: JSON.stringify(json) },
      inputRequiredProbe: {
        ...probes.inputRequiredProbe,
        arguments: JSON.stringify(json),
      },
      toolCallProbe: { ...probes.toolCallProbe, arguments: "{}" },
      tasksProbe: {
        ...probes.tasksProbe,
        arguments: JSON.stringify(json),
        inputResponses: JSON.stringify(json),
      },
    };
    save.mockImplementationOnce(async (args) => {
      expect(() => convexToJson(args)).not.toThrow();
      expect(args.defaultInputs).toEqual(stored);
    });
    const firstBrowser = renderHook(() => useConformanceServerData(props));
    await act(async () => {
      await firstBrowser.result.current.saveDefaults!("alpha", {}, probes);
    });
    firstBrowser.unmount();
    client.query.mockResolvedValue({ ...row, defaultInputs: stored });
    const secondBrowser = renderHook(() => useConformanceServerData(props));
    await act(async () => {
      expect(
        (await secondBrowser.result.current.loadDefaults("alpha")).inputs,
      ).toEqual(probes);
    });
    expect(secondBrowser.result.current.inputsByServer.alpha).toEqual(probes);
    queries.mockReturnValue({
      "proj_1:srv_1": {
        ...row,
        defaultInputs: {
          tasksProbe: {
            toolName: "task",
            arguments: "{}",
            inputResponses: "{}",
          },
        },
      },
    });
    secondBrowser.rerender();
    expect(secondBrowser.result.current.inputsByServer.alpha).toEqual({
      tasksProbe: {
        toolName: "task",
        arguments: {},
        inputResponses: {},
      },
    });
  });
  it("distinguishes a missing row from a failed read", async () => {
    const { result } = renderHook(() => useConformanceServerData(props));
    client.query.mockResolvedValueOnce(null);
    await act(async () => {
      expect(await result.current.loadDefaults("alpha")).toEqual({
        selection: {},
        inputs: {},
      });
    });
    client.query.mockRejectedValueOnce(new Error("offline"));
    await act(async () => {
      await expect(result.current.loadDefaults("alpha")).rejects.toThrow(
        "offline",
      );
    });
  });
  it.each(["arguments", "inputResponses"] as const)(
    "rejects unreadable saved %s and lets Retry recover without a render crash",
    async (field) => {
      for (const value of ["{broken", "null", "[]", "false", "1", '\"text\"']) {
        const invalid = {
          ...row,
          defaultInputs: {
            logProbe: { toolName: "log", arguments: "{}" },
            tasksProbe: { toolName: "task", [field]: value },
          },
        };
        client.query.mockResolvedValue(invalid);
        queries.mockReturnValue({ "proj_1:srv_1": invalid });
        const hook = renderHook(() => useConformanceServerData(props));
        await act(async () => {
          await expect(
            hook.result.current.loadDefaults("alpha"),
          ).rejects.toThrow("Could not load your saved inputs. Try again.");
        });
        expect(hook.result.current.defaultsByServer).toEqual({});
        expect(hook.result.current.inputsByServer).toEqual({});
        queries.mockReturnValue({ "proj_1:srv_1": row });
        client.query.mockResolvedValue(row);
        await act(async () => {
          expect(
            (await hook.result.current.loadDefaults("alpha")).inputs,
          ).toEqual(inputs);
        });
        expect(hook.result.current.inputsByServer.alpha).toEqual(inputs);
        hook.unmount();
      }
    },
  );
  it("does not expose a broken subscription as empty or partial inputs", async () => {
    const hook = renderHook(() => useConformanceServerData(props));
    await act(async () => {
      await hook.result.current.loadDefaults("alpha");
    });
    queries.mockReturnValue({
      "proj_1:srv_1": {
        ...row,
        defaultInputs: {
          tasksProbe: { toolName: "task", arguments: "{broken" },
        },
      },
    });
    hook.rerender();
    expect(hook.result.current.inputsByServer.alpha).toEqual(inputs);
    expect(hook.result.current.defaultsByServer.alpha).toEqual({
      oauth: false,
      tasksAdvice: [],
    });
  });
  it.each([undefined, {}])(
    "accepts missing saved inputs without an error (%s)",
    async (defaultInputs) => {
      client.query.mockResolvedValue({ ...row, defaultInputs });
      const hook = renderHook(() => useConformanceServerData(props));
      await act(async () => {
        expect(await hook.result.current.loadDefaults("alpha")).toEqual({
          selection: { oauth: false, tasksAdvice: [] },
          inputs: {},
        });
      });
      expect(hook.result.current.inputsByServer.alpha).toEqual({});
    },
  );
  it("does not guess defaults while the server catalog is loading", async () => {
    const { result, rerender } = renderHook(
      (args) => useConformanceServerData(args),
      { initialProps: { ...props, serversLoading: true } },
    );
    await expect(result.current.loadDefaults("alpha")).rejects.toThrow(
      /still loading/,
    );
    expect(client.query).not.toHaveBeenCalled();
    rerender({ ...props, serversLoading: false });
    await act(async () => {
      await result.current.loadDefaults("alpha");
    });
    expect(client.query).toHaveBeenCalledTimes(1);
  });
  it("keeps a server named constructor as an own entry", async () => {
    const { result } = renderHook(() =>
      useConformanceServerData({
        ...props,
        serversById: new Map([["srv_1", "constructor"]]),
        serversByName: new Map([["constructor", "srv_1"]]),
      }),
    );
    await act(async () => {
      await result.current.loadDefaults("constructor");
    });
    expect(Object.hasOwn(result.current.inputsByServer, "constructor")).toBe(
      true,
    );
    expect(result.current.inputsByServer.constructor).toEqual(inputs);
  });
  it("reads and saves timeout separately from check selection", async () => {
    client.query.mockResolvedValue({ ...row, runTimeoutSeconds: 300 });
    const { result } = renderHook(() => useConformanceServerData(props));
    await act(async () => { await result.current.loadDefaults("alpha"); });
    expect(result.current.timeoutsByServer).toEqual({ alpha: 300 });
    await result.current.saveTimeout?.("alpha", 1);
    expect(save).toHaveBeenLastCalledWith({ projectId: "proj_1", serverId: "srv_1", runTimeoutSeconds: 1 });
    await result.current.saveTimeout?.("alpha", null);
    expect(save).toHaveBeenLastCalledWith({ projectId: "proj_1", serverId: "srv_1", runTimeoutSeconds: null });
  });
});