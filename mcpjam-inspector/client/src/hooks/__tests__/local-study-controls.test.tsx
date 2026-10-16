import { act, renderHook, waitFor } from "@testing-library/react";
import { beforeEach, expect, it, vi } from "vitest";
const api = vi.hoisted(() => ({ admission: vi.fn(), revoke: vi.fn() }));
vi.mock("@/lib/local-study-controls", () => ({ fetchLocalStudyAdmission: api.admission, revokeLocalStudyAccess: api.revoke }));
import { useLocalStudyAdmission } from "../use-local-study-admission";
import { useLocalStudyRevocation } from "../use-local-study-revocation";
beforeEach(() => { vi.clearAllMocks(); });
it("waits for an explicit backend admission marker and clears it across identities", async () => {
  api.admission.mockResolvedValue({ harnessId: "codex", modelSourceReady: true });
  const { result, rerender } = renderHook(props => useLocalStudyAdmission(props), { initialProps: { key: "actor-a", enabled: true, scenarioId: "study", accessVersion: 1 } });
  await waitFor(() => expect(result.current?.harnessId).toBe("codex"));
  api.admission.mockReturnValue(new Promise(() => {}));
  rerender({ key: "actor-b", enabled: true, scenarioId: "study", accessVersion: 1 });
  expect(result.current).toBeNull();
});
it("does not fetch when the surface is unavailable", () => {
  renderHook(() => useLocalStudyAdmission({ key: "actor", enabled: false, scenarioId: "study", accessVersion: 1 }));
  expect(api.admission).not.toHaveBeenCalled();
});
it("clears local sending before awaiting revocation and distinguishes incomplete cleanup", async () => {
  let finish: ((value: { revoked: true; cleanupComplete: boolean }) => void) | undefined;
  api.revoke.mockReturnValue(new Promise(resolve => { finish = resolve; }));
  const clear = vi.fn();
  const { result } = renderHook(() => useLocalStudyRevocation("actor:chat", clear));
  let pending = Promise.resolve();
  act(() => { pending = result.current.revoke("reservation"); });
  expect(clear).toHaveBeenCalledOnce();
  expect(result.current.pending).toBe(true);
  await act(async () => { finish?.({ revoked: true, cleanupComplete: false }); await pending; });
  expect(result.current.revoked).toBe(true);
  expect(result.current.cleanupComplete).toBe(false);
  api.revoke.mockResolvedValue({ revoked: true, cleanupComplete: true });
  await act(() => result.current.revoke());
  expect(result.current.cleanupComplete).toBe(true);
  expect(api.revoke).toHaveBeenLastCalledWith("reservation");
});
it("does not transfer a pending revoke result to another account or chat", async () => {
  let finish: ((value: { revoked: true; cleanupComplete: boolean }) => void) | undefined;
  api.revoke.mockReturnValue(new Promise(resolve => { finish = resolve; }));
  const { result, rerender } = renderHook(({ scope }) => useLocalStudyRevocation(scope, vi.fn()), { initialProps: { scope: "actor-a:chat-a" } });
  let pending = Promise.resolve();
  act(() => { pending = result.current.revoke("reservation"); });
  rerender({ scope: "actor-b:chat-b" });
  await act(async () => { finish?.({ revoked: true, cleanupComplete: true }); await pending; });
  expect(result.current.revoked).toBe(false);
  expect(result.current.reservationId).toBeUndefined();
});
it("keeps revocation failures visible and retryable", async () => {
  api.revoke.mockRejectedValue(new Error("Backend offline"));
  const { result } = renderHook(() => useLocalStudyRevocation("actor:chat", vi.fn()));
  await act(() => result.current.revoke("reservation"));
  expect(result.current.error).toBe("Backend offline");
  expect(result.current.reservationId).toBe("reservation");
  expect(result.current.revoked).toBe(false);
});
