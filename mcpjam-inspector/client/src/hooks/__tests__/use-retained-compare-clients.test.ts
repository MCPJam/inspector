import { renderHook } from "@testing-library/react";
import { expect, it } from "vitest";
import { useRetainedCompareClients } from "../use-retained-compare-clients";
import { resolvePlaygroundClientColumn } from "@/lib/playground-client-columns";
import type { HostDetail } from "../useClients";

const host: HostDetail = {
  hostId: "a",
  name: "A",
  config: {
    schemaVersion: 2,
    hostStyle: "chatgpt",
    modelId: "openai/gpt-5",
    systemPrompt: "",
    temperature: 0,
    requireToolApproval: false,
    serverIds: [],
    optionalServerIds: [],
    clientCapabilities: {},
    hostContext: {},
    connectionDefaults: { headers: {}, requestTimeout: 30000 },
  },
};
function input(
  client: HostDetail | null = host,
  enabled = true,
  loading = false,
  hostId = "a",
) {
  return {
    scope: "actor:project:0" as string | null,
    slots: [{ host: client, isLoading: loading }],
    paused: false,
    canConfirmMissing: true,
    running: new Set<string>(),
    resolutions: [
      resolvePlaygroundClientColumn({
        paneId: "a",
        hostId,
        slot: { host: client, isLoading: loading },
        hosts: [],
        models: [
          {
            id: "openai/gpt-5",
            provider: "openai",
            name: "GPT",
            hosted: true,
            disabled: !enabled,
          },
        ],
      }),
    ],
  };
}
it("holds a loading owner and restores its exact key", () => {
  const view = renderHook(({ value }) => useRetainedCompareClients(value), {
    initialProps: { value: input() },
  });
  const before = view.result.current[0];
  view.rerender({ value: input(null, true, true) });
  expect(view.result.current[0]).toMatchObject({
    ...before,
    pausedReason: expect.any(String),
  });
  view.rerender({ value: input() });
  expect(view.result.current[0]).toEqual(before);
});
it("keeps only running owners when a model becomes unavailable", () => {
  const view = renderHook(({ value }) => useRetainedCompareClients(value), {
    initialProps: { value: input() },
  });
  const blocked = input(host, false);
  blocked.running.add("a");
  view.rerender({ value: blocked });
  expect(view.result.current[0]).toMatchObject({
    status: "ready",
    pausedReason: expect.any(String),
  });
  blocked.running = new Set();
  view.rerender({ value: { ...blocked } });
  expect(view.result.current[0].status).toBe("unavailable");
});
it("ends confirmed missing, invalid, changed config and foreign-scope owners", () => {
  for (const next of [
    input(null),
    { ...input(), scope: "other:project:0" },
    { ...input(), scope: null },
  ]) {
    const view = renderHook(({ value }) => useRetainedCompareClients(value), {
      initialProps: { value: input() },
    });
    const before = view.result.current[0];
    view.rerender({ value: next });
    expect(view.result.current[0]).not.toEqual(before);
    view.unmount();
  }
  const view = renderHook(({ value }) => useRetainedCompareClients(value), {
    initialProps: { value: input() },
  });
  const before = view.result.current[0];
  view.rerender({
    value: input({
      ...host,
      config: { ...host.config, systemPrompt: "changed" },
    }),
  });
  expect(view.result.current[0]).not.toMatchObject(before);
  const invalid = input();
  invalid.resolutions = [
    {
      status: "invalid",
      compareId: "a",
      hostId: "a",
      compareLabel: "A",
      reason: "Invalid model choice",
    },
  ];
  view.rerender({ value: invalid });
  expect(view.result.current[0]).toEqual(invalid.resolutions[0]);
});
it("does not throw or retain a malformed saved configuration", () => {
  const view = renderHook(({ value }) => useRetainedCompareClients(value), {
    initialProps: { value: input() },
  });
  const malformed = JSON.parse(JSON.stringify(host));
  malformed.config.modelSelection = { source: "broken" };
  expect(() => view.rerender({ value: input(malformed) })).not.toThrow();
  expect(view.result.current[0].status).toBe("invalid");
});

it("compares every saved field while ignoring JSON object key order", () => {
  const view = renderHook(({ value }) => useRetainedCompareClients(value), {
    initialProps: { value: input() },
  });
  const before = view.result.current[0];
  view.rerender({ value: input({ ...host, config: { ...host.config, localBrowserEnabled: true } }) });
  expect(view.result.current[0]).not.toEqual(before);
  const changed = view.result.current[0];
  const reordered = Object.fromEntries(Object.entries(host.config).reverse());
  view.rerender({ value: input({ ...host, config: { ...host.config, ...reordered, localBrowserEnabled: true } }) });
  expect(view.result.current[0]).toEqual(changed);
});

it("never shows a pane's old client while the client it now runs loads", () => {
  const view = renderHook(({ value }) => useRetainedCompareClients(value), {
    initialProps: { value: input() },
  });
  const before = view.result.current[0];
  // The same pane, now on client "b", whose query has not answered yet.
  view.rerender({ value: input(null, true, true, "b") });
  expect(view.result.current[0]).toMatchObject({
    status: "loading",
    compareId: "a",
    hostId: "b",
  });
  view.rerender({ value: input({ ...host, hostId: "b" }, true, false, "b") });
  const after = view.result.current[0];
  expect(after.status).toBe("ready");
  if (before.status === "ready" && after.status === "ready") {
    expect(after.ownerKey).not.toBe(before.ownerKey);
  }
});
