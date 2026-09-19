import { act, renderHook } from "@testing-library/react";
import { ConvexProvider, type ConvexReactClient } from "convex/react";
import type { ReactNode } from "react";
import { expect, it, vi } from "vitest";
import { useCreditTopupPricing } from "../useCreditTopupPricing";

vi.mock("@/hooks/use-is-member-actor", () => ({
  useIsMemberActor: () => true,
}));
vi.mock("@/contexts/db-user-ready-context", () => ({
  useDbUserReady: () => true,
}));

it("survives rerenders, query changes, errors, and recovery with the real Convex subscription", () => {
  const quote = {
    currency: "usd",
    topUpEligible: true,
    canPurchase: true,
    presets: [],
  };
  let value: typeof quote | Error | undefined;
  const listeners = new Set<() => void>();
  const client = {
    watchQuery: vi.fn(() => ({
      localQueryResult: () => {
        if (value instanceof Error) throw value;
        return value;
      },
      journal: () => undefined,
      onUpdate: (callback: () => void) => {
        listeners.add(callback);
        return () => listeners.delete(callback);
      },
    })),
  } as unknown as ConvexReactClient;
  const wrapper = ({ children }: { children: ReactNode }) => (
    <ConvexProvider client={client}>{children}</ConvexProvider>
  );
  const { result, rerender, unmount } = renderHook(
    ({ enabled, organizationId }) =>
      useCreditTopupPricing(organizationId, enabled),
    { wrapper, initialProps: { enabled: false, organizationId: "org-a" } },
  );
  rerender({ enabled: false, organizationId: "org-a" });
  expect(result.current.canPurchase).toBe(false);
  expect(result.current.isLoading).toBe(false);
  rerender({ enabled: true, organizationId: "org-a" });
  expect(result.current.isLoading).toBe(true);
  act(() => {
    value = quote;
    listeners.forEach((callback) => callback());
  });
  expect(result.current.canPurchase).toBe(true);
  expect(result.current.isLoading).toBe(false);
  rerender({ enabled: true, organizationId: "org-b" });
  act(() => {
    value = new Error("Billing unavailable");
    listeners.forEach((callback) => callback());
  });
  expect(result.current.error?.message).toBe("Billing unavailable");
  expect(result.current.canPurchase).toBe(false);
  act(() => {
    value = quote;
    listeners.forEach((callback) => callback());
  });
  expect(result.current.error).toBeNull();
  expect(result.current.canPurchase).toBe(true);
  rerender({ enabled: false, organizationId: "org-b" });
  expect(result.current.canPurchase).toBe(false);
  unmount();
  expect(listeners.size).toBe(0);
});
