import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { consumeCallbackProjectReturn } from "../callback-project-return";
import {
  projectTransitionRecovery as recovery,
  PROJECT_TRANSITION_TTL_MS,
} from "../auth/project-transition-recovery";
import { writeAppSignInReturnPath } from "../app-signin-return-path";
import { writeCliSignInReturnPath } from "../cli-signin-return-path";
vi.mock("../project-route-telemetry", () => ({
  trackSignInReturnRestored: vi.fn(),
  trackStaleProjectReturnRecovered: vi.fn(),
}));
const path = "/p/k5700000000000000000000000a/servers";
beforeEach(() => {
  sessionStorage.clear();
  recovery.clear();
  recovery.observeActor("guest:reset", "/");
});
afterEach(() => {
  recovery.clear();
  vi.useRealTimers();
});
function arm() {
  recovery.remember(path, "guest:old");
  writeAppSignInReturnPath(path);
}
it("uses Home recovery only for a valid marker matching the selected generic return", () => {
  arm();
  expect(consumeCallbackProjectReturn()).toMatchObject({
    restoredPath: path,
    projectReturnIntent: { path, fallback: "home" },
  });
  expect(recovery.store.getState().marker).not.toBeNull();
});
it("keeps special returns ahead of generic recovery even when paths match", () => {
  arm();
  writeCliSignInReturnPath(path);
  expect(consumeCallbackProjectReturn().projectReturnIntent?.fallback).toBe(
    "preserve",
  );
  expect(recovery.store.getState().marker).toBeNull();
});
it("does not recover a different selected path", () => {
  arm();
  writeAppSignInReturnPath(path + "?other=1");
  expect(consumeCallbackProjectReturn().projectReturnIntent?.fallback).toBe(
    "none",
  );
  expect(recovery.store.getState().marker).toBeNull();
});
it("does not recover an expired marker", () => {
  vi.useFakeTimers();
  arm();
  vi.advanceTimersByTime(PROJECT_TRANSITION_TTL_MS);
  // A fresh explicit return cannot renew an old route's transition provenance.
  writeAppSignInReturnPath(path);
  expect(consumeCallbackProjectReturn().projectReturnIntent?.fallback).toBe(
    "none",
  );
  expect(recovery.store.getState().marker).toBeNull();
});
it("keeps a deliberate link without a marker unchanged and consumes it once", () => {
  writeAppSignInReturnPath(path);
  expect(consumeCallbackProjectReturn()).toMatchObject({
    restoredPath: path,
    projectReturnIntent: { fallback: "none" },
  });
  expect(consumeCallbackProjectReturn()).toEqual({
    restoredPath: "/",
    projectReturnIntent: null,
  });
});
