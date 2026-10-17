import { afterEach, expect, it, vi } from "vitest";
import { getPostHogTabStorageOptions } from "../posthog-tab-storage";
import { getBootstrapDistinctId } from "../server-feature-flags";

afterEach(() => {
  vi.restoreAllMocks();
  window.localStorage.clear();
  window.sessionStorage.clear();
});

it("uses per-tab storage and never imports shared actor identity", () => {
  localStorage.setItem("ph_test_posthog", JSON.stringify({ distinct_id: "owner" }));
  expect(getPostHogTabStorageOptions().persistence).toBe("sessionStorage");
  expect(getBootstrapDistinctId()).toBeNull();
});

it("uses memory if sessionStorage is unavailable, avoiding SDK shared-storage fallback", () => {
  vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
    throw new DOMException("Storage blocked", "SecurityError");
  });
  expect(getPostHogTabStorageOptions().persistence).toBe("memory");
});
