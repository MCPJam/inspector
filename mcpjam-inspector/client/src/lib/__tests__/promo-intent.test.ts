import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  capturePromoIntent,
  clearPromoIntent,
  readPromoIntent,
  savePromoIntent,
  promoSignInState,
  promoSignInReturn,
} from "../promo-intent";

beforeEach(() => {
  vi.restoreAllMocks();
  sessionStorage.clear();
  clearPromoIntent();
});
describe("promo intent", () => {
  it("captures query and fragment credentials and removes them from the URL", () => {
    for (const suffix of ["?code=SYNTH-ETIC1", "#code=SYNTH-ETIC1"]) {
      window.history.replaceState(null, "", `/redeem${suffix}`);
      capturePromoIntent();
      expect(window.location.pathname).toBe("/redeem");
      expect(window.location.search + window.location.hash).toBe("");
      expect(readPromoIntent()).toBe("SYNTH-ETIC1");
    }
  });
  it("does not refresh the original TTL when read or restored", () => {
    savePromoIntent("SYNTH-ETIC1", 1000);
    expect(readPromoIntent(1000 + 29 * 60000)).toBe("SYNTH-ETIC1");
    expect(readPromoIntent(1000 + 30 * 60000)).toBe("");
  });
  it("still strips a credential when storage is unavailable", () => {
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new Error("blocked");
    });
    window.history.replaceState(null, "", "/redeem?code=SYNTH-ETIC1");
    capturePromoIntent();
    expect(window.location.search).toBe("");
    expect(readPromoIntent()).toBe("SYNTH-ETIC1");
  });
});

it("prefers the current capture and clear when storage still contains an older card", () => {
  savePromoIntent("AAAAA-BBBBB");
  vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
    throw new Error("quota");
  });
  savePromoIntent("CCCCC-DDDDD");
  expect(readPromoIntent()).toBe("CCCCC-DDDDD");
  vi.spyOn(Storage.prototype, "removeItem").mockImplementation(() => {
    throw new Error("blocked");
  });
  clearPromoIntent();
  expect(readPromoIntent()).toBe("");
});

it("discards stale persisted cards after a failed save and authentication redirect", async () => {
  savePromoIntent("AAAAA-BBBBB");
  vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
    throw new Error("quota");
  });
  vi.spyOn(Storage.prototype, "removeItem").mockImplementation(() => {
    throw new Error("blocked");
  });
  savePromoIntent("CCCCC-DDDDD");
  const state = promoSignInState();
  expect(state).toEqual({ promoReturn: true, promoManualEntry: true });
  expect(JSON.stringify(state)).not.toContain("CCCCC");
  window.history.replaceState(null, "", promoSignInReturn(state));
  vi.resetModules();
  const restored = await import("../promo-intent");
  restored.capturePromoIntent();
  expect(restored.readPromoIntent()).toBe("");
  expect(window.location.search).toBe("?manual=1");
  vi.resetModules();
  const reloaded = await import("../promo-intent");
  reloaded.capturePromoIntent();
  expect(reloaded.readPromoIntent()).toBe("");
  vi.restoreAllMocks();
  reloaded.capturePromoIntent();
  expect(window.location.search).toBe("");
});
