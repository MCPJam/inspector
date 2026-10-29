import { beforeEach, describe, expect, it, vi } from "vitest";
import { act, renderHook, waitFor } from "@testing-library/react";

const mockFetchKeys = vi.hoisted(() => vi.fn());
const mockFetchSecrets = vi.hoisted(() => vi.fn());
vi.mock("@/lib/apis/server-secrets-api", () => ({
  fetchServerSecretKeys: mockFetchKeys,
  fetchServerSecrets: mockFetchSecrets,
}));

import { WebApiError } from "@/lib/apis/web/base";
import { useServerAuthReveal } from "../hooks/use-server-auth-reveal";
import type { ServerAuth } from "../server-auth";

const bearerSynced: ServerAuth = {
  method: "bearer",
  bearer: { kind: "stored" },
  headers: { kind: "stored" },
};

type Props = Parameters<typeof useServerAuthReveal>[0];

function renderReveal(initial: Partial<Props> = {}) {
  return renderHook((props: Props) => useServerAuthReveal(props), {
    initialProps: {
      projectId: "project-1",
      serverId: "server-1",
      auth: bearerSynced,
      isOpen: true,
      wantsNames: true,
      ...initial,
    },
  });
}

describe("useServerAuthReveal", () => {
  beforeEach(() => {
    mockFetchKeys.mockReset().mockResolvedValue({
      envKeys: [],
      headerKeys: ["Authorization", "X-Tenant"],
    });
    mockFetchSecrets.mockReset().mockResolvedValue({
      env: null,
      headers: { Authorization: "Bearer abc", "X-Tenant": "acme" },
    });
  });

  it("looks up names once per modal open, without the bearer's header", async () => {
    const { result, rerender } = renderReveal();
    await waitFor(() =>
      expect(result.current.headerNames).toEqual(["X-Tenant"]),
    );

    const props = {
      projectId: "project-1",
      serverId: "server-1",
      auth: bearerSynced,
      isOpen: true,
    };
    // Leaving the Auth tab and coming back doesn't ask again.
    rerender({ ...props, wantsNames: false });
    rerender({ ...props, wantsNames: true });
    expect(mockFetchKeys).toHaveBeenCalledTimes(1);

    // Closing the modal drops everything; the next open asks again.
    rerender({ ...props, isOpen: false, wantsNames: false });
    expect(result.current.headerNames).toBeNull();
    rerender({ ...props, wantsNames: true });
    await waitFor(() => expect(mockFetchKeys).toHaveBeenCalledTimes(2));
  });

  it("doesn't look up names until the Auth tab shows", () => {
    renderReveal({ wantsNames: false });
    expect(mockFetchKeys).not.toHaveBeenCalled();
  });

  it("reveals the token and headers in one fetch, then clears them on close", async () => {
    const { result, rerender } = renderReveal();
    await act(async () => {
      expect(await result.current.reveal()).toBe(true);
    });
    expect(mockFetchSecrets).toHaveBeenCalledTimes(1);
    expect(result.current.revealed).toEqual({
      bearerToken: "abc",
      entries: [["X-Tenant", "acme"]],
    });

    rerender({
      projectId: "project-1",
      serverId: "server-1",
      auth: bearerSynced,
      isOpen: false,
      wantsNames: false,
    });
    expect(result.current.revealed).toBeNull();
  });

  it("marks a refused reveal as not worth retrying", async () => {
    mockFetchSecrets.mockRejectedValue(
      new WebApiError(
        403,
        "FORBIDDEN",
        "Only someone who can manage this credential can reveal it.",
      ),
    );
    const { result } = renderReveal();
    await act(async () => {
      expect(await result.current.reveal()).toBe(false);
    });
    expect(result.current.error).toEqual({
      message: "Only someone who can manage this credential can reveal it.",
      retryable: false,
    });
  });

  it("offers a retry when the reveal fails for any other reason", async () => {
    mockFetchSecrets.mockRejectedValue(new Error("network down"));
    const { result } = renderReveal();
    await act(async () => {
      await result.current.reveal();
    });
    expect(result.current.error).toEqual({
      message: "Could not load the saved value. Try again.",
      retryable: true,
    });
  });

  it("can't reveal a server that isn't saved to a project", () => {
    const { result } = renderReveal({ projectId: null });
    expect(result.current.canReveal).toBe(false);
    expect(mockFetchKeys).not.toHaveBeenCalled();
  });
});
