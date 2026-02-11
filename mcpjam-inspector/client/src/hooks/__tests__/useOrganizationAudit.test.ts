import { act, renderHook, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  type AuditEvent,
  useOrganizationAudit,
} from "../useOrganizationAudit";

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

describe("useOrganizationAudit", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("loads initial events with configured page size", async () => {
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

    await waitFor(() => {
      expect(result.current.events).toHaveLength(2);
    });

    expect(mockQuery).toHaveBeenCalledWith("auditEvents:listByOrganization", {
      organizationId: "org-1",
      limit: 2,
    });
    expect(result.current.hasMore).toBe(true);
  });

  it("appends older pages and de-duplicates by event id", async () => {
    mockQuery
      .mockResolvedValueOnce([
        createAuditEvent("evt-3", 300),
        createAuditEvent("evt-2", 200),
      ])
      .mockResolvedValueOnce([
        createAuditEvent("evt-2", 200),
        createAuditEvent("evt-1", 100),
      ]);

    const { result } = renderHook(() =>
      useOrganizationAudit({
        organizationId: "org-1",
        isAuthenticated: true,
        initialLimit: 2,
      }),
    );

    await waitFor(() => {
      expect(result.current.events).toHaveLength(2);
    });

    await act(async () => {
      await result.current.loadMore();
    });

    expect(mockQuery).toHaveBeenNthCalledWith(
      2,
      "auditEvents:listByOrganization",
      {
        organizationId: "org-1",
        limit: 2,
        before: 200,
      },
    );
    expect(result.current.events.map((event) => event._id)).toEqual([
      "evt-3",
      "evt-2",
      "evt-1",
    ]);
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

    await waitFor(() => {
      expect(result.current.error?.message).toContain("requires admin");
    });
    expect(result.current.events).toHaveLength(0);

    await act(async () => {
      await result.current.refresh();
    });

    await waitFor(() => {
      expect(result.current.error).toBeNull();
    });
    expect(result.current.events).toHaveLength(1);
  });

  it("does not query when unauthenticated", async () => {
    const { result } = renderHook(() =>
      useOrganizationAudit({
        organizationId: "org-1",
        isAuthenticated: false,
      }),
    );

    await waitFor(() => {
      expect(result.current.isLoading).toBe(false);
    });

    expect(mockQuery).not.toHaveBeenCalled();
    expect(result.current.events).toEqual([]);
  });
});
