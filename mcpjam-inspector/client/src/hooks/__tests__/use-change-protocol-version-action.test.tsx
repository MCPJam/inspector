import { describe, expect, it, vi, beforeEach } from "vitest";
import { renderHook, act } from "@testing-library/react";

const navigate = vi.fn();
vi.mock("@/lib/app-navigation", async () => {
  const actual = await vi.importActual<
    typeof import("@/lib/app-navigation")
  >("@/lib/app-navigation");
  return { ...actual, useAppNavigate: () => navigate };
});
vi.mock("@/lib/analytics", () => ({ track: vi.fn() }));

import { useChangeProtocolVersionAction } from "../use-change-protocol-version-action";
import { PROTOCOL_VERSION_PIN_CODE } from "@/components/chat-v2/shared/chat-helpers";

const PIN_MESSAGE =
  'MCP server "champions" doesn\'t support MCP protocol version 2026-07-28, which this client is pinned to.';

/**
 * The seam both compare cards and the single chat surface share.
 *
 * Tested here rather than through a rendered compare column on purpose: the
 * cards need a live `useChatSession` (network, transports, streaming) to
 * mount, so a card-level test would assert almost nothing about this decision
 * while costing a page of mocks. What can actually go wrong is the decision —
 * does this error get an action, and does it point at the right client — and
 * that lives entirely in this hook.
 */
describe("useChangeProtocolVersionAction", () => {
  beforeEach(() => {
    navigate.mockClear();
  });

  it("offers the action for a pin failure recognized by code", () => {
    const { result } = renderHook(() =>
      useChangeProtocolVersionAction({
        error: { code: PROTOCOL_VERSION_PIN_CODE, message: PIN_MESSAGE },
        hostId: "host_1",
        location: "test",
      }),
    );

    expect(result.current).toBeTypeOf("function");
  });

  it("offers it when only the message survives", () => {
    // The chat path receives a bare string: the AI SDK collapses a failed
    // response into `new Error(await response.text())`, so no code reaches it.
    const { result } = renderHook(() =>
      useChangeProtocolVersionAction({
        error: { message: PIN_MESSAGE },
        hostId: "host_1",
        location: "test",
      }),
    );

    expect(result.current).toBeTypeOf("function");
  });

  it("stays absent for every other error", () => {
    const { result } = renderHook(() =>
      useChangeProtocolVersionAction({
        error: { code: "SERVER_UNREACHABLE", message: "fetch failed" },
        hostId: "host_1",
        location: "test",
      }),
    );

    expect(result.current).toBeUndefined();
  });

  it("opens the protocol tab of the client it was given", () => {
    // The point of threading `hostId`: in host-compare mode each column is a
    // different client, so the column's own client is the one holding the pin
    // that failed there.
    const { result } = renderHook(() =>
      useChangeProtocolVersionAction({
        error: { code: PROTOCOL_VERSION_PIN_CODE },
        hostId: "host_abc",
        location: "test",
      }),
    );

    act(() => result.current?.());

    expect(navigate).toHaveBeenCalledWith("/hosts/host_abc?hostTab=protocol");
  });

  it("falls back to the clients list rather than guessing a client", () => {
    // Chatbox and environment surfaces have no host id. `/hosts/undefined`
    // would be rejected by the route, so the link degrades instead.
    const { result } = renderHook(() =>
      useChangeProtocolVersionAction({
        error: { code: PROTOCOL_VERSION_PIN_CODE },
        hostId: null,
        location: "test",
      }),
    );

    act(() => result.current?.());

    expect(navigate).toHaveBeenCalledWith("/hosts");
  });
});
