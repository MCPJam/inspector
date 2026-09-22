import { describe, it, expect, afterEach } from "vitest";
import { renderHook } from "@testing-library/react";
import { useApiContext } from "../use-hosted-api-context";
import { setApiContext, buildServerRequest } from "@/lib/apis/web/context";

/**
 * The two `mcpProfile.toolListChanged` switches are carried, never derived:
 * App.tsx resolves them, this hook publishes them onto the global API
 * context, and every hosted request body spreads them. Each hop is a plain
 * hand-off, and the failure mode of dropping one is SILENT — the host asks
 * for a client that never listens, and the hosted connection listens anyway.
 *
 * So this asserts the hop end to end (hook → context → wire body) rather than
 * that the hook stored a field: only the body proves the switch left the
 * browser.
 */
const baseOptions = {
  projectId: "project-1",
  serverIdsByName: { asana: "server-1" },
  getAccessToken: async () => "token",
} as const;

describe("useApiContext — toolListChanged conformance knobs", () => {
  afterEach(() => {
    setApiContext(null);
  });

  it("puts both switches on the hosted request body", () => {
    renderHook(() =>
      useApiContext({
        ...baseOptions,
        suppressListenChannel: true,
        dropToolListChanged: true,
      }),
    );

    expect(buildServerRequest("asana")).toMatchObject({
      suppressListenChannel: true,
      dropToolListChanged: true,
    });
  });

  it("carries one switch without the other", () => {
    // A host that opens the listen channel but ignores the notification is a
    // real configuration; the two leaves are independent.
    renderHook(() =>
      useApiContext({ ...baseOptions, dropToolListChanged: true }),
    );

    const body = buildServerRequest("asana");
    expect(body).toMatchObject({ dropToolListChanged: true });
    expect(body).not.toHaveProperty("suppressListenChannel");
  });

  it("emits neither field for a conforming host", () => {
    // Absence is the conforming default the SDK reads, so a host with no
    // `toolListChanged` opinion must add nothing to the body.
    renderHook(() => useApiContext(baseOptions));

    const body = buildServerRequest("asana");
    expect(body).not.toHaveProperty("suppressListenChannel");
    expect(body).not.toHaveProperty("dropToolListChanged");
  });
});
