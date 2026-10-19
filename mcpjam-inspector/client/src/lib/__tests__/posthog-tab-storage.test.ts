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
  const blocked: Storage = {
    length: 0,
    clear() {},
    getItem: () => null,
    key: () => null,
    removeItem() {},
    setItem() {
      throw new DOMException("Storage blocked", "SecurityError");
    },
  };
  vi.spyOn(window, "sessionStorage", "get").mockReturnValue(blocked);
  expect(getPostHogTabStorageOptions().persistence).toBe("memory");
});
