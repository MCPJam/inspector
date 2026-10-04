import { act, renderHook } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { useLocalAutoApproveConsent } from "../useLocalAutoApproveConsent";
const mocks = vi.hoisted(() => ({ fetch: vi.fn(), acknowledge: vi.fn() }));
vi.mock("@/lib/local-harness-consent", () => ({
  fetchLocalHarnessAvailability: mocks.fetch,
  acknowledgeLocalAutoApprove: mocks.acknowledge,
}));
const args = () => ({
  enabled: true,
  ready: true,
  projectId: "project",
  harnessId: "claude-code",
  scopeKey: "scope",
  acknowledged: false,
  onCancel: vi.fn(),
  onAcknowledged: vi.fn(),
});
beforeEach(() => {
  vi.resetAllMocks();
  mocks.fetch.mockResolvedValue({
    ok: true,
    availability: { autoApproveAcknowledged: false },
  });
  mocks.acknowledge.mockResolvedValue(undefined);
});
describe("local Off consent gate", () => {
  it("waits for successful persistence and keeps errors retryable", async () => {
    const options = args();
    const { result } = renderHook(() => useLocalAutoApproveConsent(options));
    let send!: Promise<boolean>;
    await act(async () => {
      send = result.current.ensure();
    });
    expect(result.current.open).toBe(true);
    mocks.acknowledge.mockRejectedValueOnce(new Error("offline"));
    await expect(result.current.approve()).rejects.toThrow("offline");
    expect(result.current.open).toBe(true);
    await act(async () => {
      await result.current.approve();
    });
    expect(await send).toBe(true);
    expect(result.current.open).toBe(false);
  });
  it("cancels a send and restores On", async () => {
    const options = args();
    const { result } = renderHook(() => useLocalAutoApproveConsent(options));
    let send!: Promise<boolean>;
    await act(async () => {
      send = result.current.ensure();
    });
    act(() => result.current.cancel());
    expect(await send).toBe(false);
    expect(options.onCancel).toHaveBeenCalledOnce();
    expect(mocks.acknowledge).not.toHaveBeenCalled();
  });
  it("cannot resume a send into a changed project scope", async () => {
    const options = args();
    const { result, rerender } = renderHook(
      (props) => useLocalAutoApproveConsent(props),
      { initialProps: options },
    );
    let send!: Promise<boolean>;
    await act(async () => {
      send = result.current.ensure();
    });
    rerender({ ...options, scopeKey: "other", projectId: "other" });
    expect(await send).toBe(false);
  });
  it("does not open a late consent request after the toggle changes On", async () => {
    let finish!: (response: any) => void;
    mocks.fetch.mockReturnValue(
      new Promise((resolve) => {
        finish = resolve;
      }),
    );
    const options = args();
    const { result, rerender } = renderHook(
      (props) => useLocalAutoApproveConsent(props),
      { initialProps: options },
    );
    const send = result.current.ensure();
    rerender({ ...options, enabled: false });
    await act(async () => {
      finish({ ok: true, availability: { autoApproveAcknowledged: false } });
    });
    expect(await send).toBe(false);
    expect(result.current.open).toBe(false);
  });
});
