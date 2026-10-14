import { beforeEach, afterEach, expect, it, vi } from "vitest";
import {
  createProjectTransitionRecovery,
  PROJECT_TRANSITION_TTL_MS,
} from "../project-transition-recovery";
import { createGuestTabRecovery } from "../guest-tab-recovery";
const path = "/p/k5700000000000000000000000a/evals/suite/old?tab=runs#case";
beforeEach(() => {
  sessionStorage.clear();
  vi.useFakeTimers();
});
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});
it("only marks a route this tab had successfully opened, not a new direct link", () => {
  const recovery = createProjectTransitionRecovery();
  recovery.arm(path);
  expect(recovery.store.getState().marker).toBeNull();
  recovery.remember(path, "guest:one");
  recovery.arm(path + "2");
  expect(recovery.store.getState().marker).toBeNull();
  recovery.arm(path, "attempt-one");
  expect(recovery.store.getState().marker).toMatchObject({
    path,
    attempt: "attempt-one",
    sourceActor: "guest:one",
  });
});
it("survives a guest reload and is consumed once per tab", () => {
  const recovery = createProjectTransitionRecovery();
  recovery.remember(path, "guest:one");
  recovery.arm(path, "attempt");
  const reloaded = createProjectTransitionRecovery();
  expect(reloaded.store.getState().marker?.path).toBe(path);
  reloaded.clear("stale-attempt");
  expect(reloaded.store.getState().marker).not.toBeNull();
  reloaded.clear("attempt");
  expect(createProjectTransitionRecovery().store.getState().marker).toBeNull();
});
it("expires after thirty minutes and rejects malformed stored paths", () => {
  const recovery = createProjectTransitionRecovery();
  recovery.remember(path, "guest:one");
  recovery.arm(path);
  vi.advanceTimersByTime(PROJECT_TRANSITION_TTL_MS);
  expect(createProjectTransitionRecovery().store.getState().marker).toBeNull();
  recovery.remember(path, "guest:one");
  recovery.arm(path);
  const marker = recovery.store.getState().marker!;
  expect(recovery.isValid({ ...marker, path: "//evil.test" })).toBe(false);
  expect(recovery.isValid({ ...marker, requestedProjectId: "bad" })).toBe(
    false,
  );
});
it("captures account replacement but not logout or a normal token refresh", () => {
  const recovery = createProjectTransitionRecovery();
  recovery.remember(path, "guest:one");
  recovery.observeActor("guest:one", path);
  expect(recovery.store.getState().marker).toBeNull();
  recovery.observeActor("workos:one", path);
  expect(recovery.store.getState().marker?.path).toBe(path);
  recovery.clear();
  recovery.remember(path, "workos:one");
  recovery.observeActor("workos:two", path);
  expect(recovery.store.getState().marker?.sourceActor).toBe("workos:one");
  recovery.clear();
  recovery.remember(path, "workos:two");
  recovery.observeActor("guest:two", path);
  expect(recovery.store.getState().marker).toBeNull();
});
it("keeps same-page recovery safe when storage is blocked", () => {
  const recovery = createProjectTransitionRecovery(() => {
    throw Error("blocked");
  });
  recovery.remember(path, "guest:one");
  expect(() => recovery.arm(path)).not.toThrow();
  expect(recovery.store.getState().marker?.path).toBe(path);
  expect(() => recovery.clear()).not.toThrow();
});
it.each([false, true])(
  "records sibling intent before unmount/reload (missed start: %s)",
  (missed) => {
    const recovery = createProjectTransitionRecovery();
    recovery.remember(path, "guest:one");
    const reload = vi.fn(() =>
      expect(
        createProjectTransitionRecovery().store.getState().marker?.path,
      ).toBe(path),
    );
    const receiver = createGuestTabRecovery({
      publish: vi.fn(),
      allowAutomaticReload: () => true,
      reload,
      beforeTransition: (message) => recovery.arm(path, message.attempt),
    });
    receiver.setGuest("one");
    receiver.store.subscribe(() =>
      expect(recovery.store.getState().marker?.path).toBe(path),
    );
    const sender = createGuestTabRecovery({
      publish: (m) => {
        if (!missed || m.phase !== "started") receiver.receive(m);
      },
      reload: vi.fn(),
      allowAutomaticReload: () => true,
    });
    const finish = sender.begin("one");
    finish(true);
    expect(reload).toHaveBeenCalledOnce();
    receiver.dispose();
    sender.dispose();
  },
);
