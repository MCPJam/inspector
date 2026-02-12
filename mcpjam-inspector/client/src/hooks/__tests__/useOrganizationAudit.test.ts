import { act, renderHook, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { type AuditEvent, useOrganizationAudit } from "../useOrganizationAudit";

const mockQuery = vi.fn();

vi.mock("convex/react", () => ({
  useConvex: () => ({
    watchQuery: (...args: unknown[]) => mockQuery(...args),
    query(this: any, ...args: unknown[]) {
      return this.watchQuery(...args);
    },
  }),
}));

function createAuditEvent(
  id: string,
  timestamp: number,
  overrides: Partial<AuditEvent> = {},
): AuditEvent {
  return {
    _id: id,
    actorType: "user",
    actorId: "user-1",
    actorEmail: "owner@example.com",
    action: "organization.updated",
    organizationId: "org-1",
    targetType: "organization",
    targetId: "org-1",
    timestamp,
    ...overrides,
  };
}

function createDeferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

describe("useOrganizationAudit", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("does not auto-fetch on mount — starts idle", async () => {
    const { result } = renderHook(() =>
      useOrganizationAudit({
        organizationId: "org-1",
        isAuthenticated: true,
        initialLimit: 2,
      }),
    );

    // Give it a tick to ensure nothing fires
    await waitFor(() => {
      expect(result.current.isLoading).toBe(false);
    });

    expect(mockQuery).not.toHaveBeenCalled();
    expect(result.current.events).toEqual([]);
  });

  it("loads events when refresh is called explicitly", async () => {
    mockQuery.mockResolvedValueOnce([
      createAuditEvent("evt-3", 300),
      createAuditEvent("evt-2", 200),
    ]);

    const { result } = renderHook(() =>
      useOrganizationAudit({
        organizationId: "org-1",
        isAuthenticated: true,
        initialLimit: 2,
      }),
    );

    await act(async () => {
      await result.current.refresh();
    });

    expect(result.current.events).toHaveLength(2);
    expect(mockQuery).toHaveBeenCalledWith("auditEvents:listByOrganization", {
      organizationId: "org-1",
      limit: 2,
    });
  });

  it("exposes query errors and recovers after refresh", async () => {
    mockQuery
      .mockRejectedValueOnce(
        new Error("Insufficient organization permissions: requires admin"),
      )
      .mockResolvedValueOnce([createAuditEvent("evt-1", 100)]);

    const { result } = renderHook(() =>
      useOrganizationAudit({
        organizationId: "org-1",
        isAuthenticated: true,
      }),
    );

    await act(async () => {
      await result.current.refresh();
    });

    expect(result.current.error?.message).toContain("requires admin");
    expect(result.current.events).toHaveLength(0);

    await act(async () => {
      await result.current.refresh();
    });

    expect(result.current.error).toBeNull();
    expect(result.current.events).toHaveLength(1);
  });

  it("does not query when unauthenticated", async () => {
    const { result } = renderHook(() =>
      useOrganizationAudit({
        organizationId: "org-1",
        isAuthenticated: false,
      }),
    );

    await act(async () => {
      await result.current.refresh();
    });

    expect(mockQuery).not.toHaveBeenCalled();
    expect(result.current.events).toEqual([]);
  });

  it("clears stale state and cancels in-flight request when organization changes", async () => {
    const deferred = createDeferred<AuditEvent[]>();
    mockQuery
      .mockReturnValueOnce(deferred.promise)
      .mockResolvedValueOnce([
        createAuditEvent("evt-new", 200, { organizationId: "org-2" }),
      ]);

    const { result, rerender } = renderHook(
      ({ organizationId, isAuthenticated }) =>
        useOrganizationAudit({
          organizationId,
          isAuthenticated,
          initialLimit: 2,
        }),
      {
        initialProps: {
          organizationId: "org-1" as string | null,
          isAuthenticated: true,
        },
      },
    );

    act(() => {
      void result.current.refresh();
    });

    await waitFor(() => {
      expect(result.current.isLoading).toBe(true);
    });

    rerender({ organizationId: "org-2", isAuthenticated: true });

    expect(result.current.isLoading).toBe(false);
    expect(result.current.error).toBeNull();
    expect(result.current.events).toEqual([]);

    deferred.resolve([
      createAuditEvent("evt-old", 100, { organizationId: "org-1" }),
    ]);

    await waitFor(() => {
      expect(result.current.events).toEqual([]);
    });

    await act(async () => {
      await result.current.refresh();
    });

    expect(mockQuery).toHaveBeenLastCalledWith(
      "auditEvents:listByOrganization",
      {
        organizationId: "org-2",
        limit: 2,
      },
    );
    expect(result.current.events.map((event) => event._id)).toEqual([
      "evt-new",
    ]);
  });
});
