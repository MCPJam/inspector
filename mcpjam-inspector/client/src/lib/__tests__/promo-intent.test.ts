import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  capturePromoIntent,
  clearPromoIntent,
  readPromoCampaign,
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
  const state = promoSignInState("agntcon-2026");
  expect(state).toEqual({
    promoReturn: true,
    promoManualEntry: true,
    promoCampaign: "agntcon-2026",
  });
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

describe("campaign key", () => {
  it("keeps a public campaign key in the URL while stripping the code", () => {
    window.history.replaceState(
      null,
      "",
      "/redeem?campaign=maven-evals-0a1b2c3d4e&code=SYNTH-ETIC1",
    );
    capturePromoIntent();
    expect(window.location.search).toBe("?campaign=maven-evals-0a1b2c3d4e");
    expect(readPromoIntent()).toBe("SYNTH-ETIC1");
    expect(readPromoCampaign()).toBe("maven-evals-0a1b2c3d4e");
  });

  it("falls back to the AGNTCon campaign for old links and invalid keys", () => {
    expect(readPromoCampaign("")).toBe("agntcon-2026");
    expect(readPromoCampaign("?campaign=Not%20A%20Key")).toBe("agntcon-2026");
  });

  it("returns a new account to its campaign when the stored intent is gone", () => {
    const state = promoSignInState("maven-evals-0a1b2c3d4e");
    expect(state.promoManualEntry).toBe(true);
    const path = promoSignInReturn(state);
    expect(path).toBe("/redeem?manual=1&campaign=maven-evals-0a1b2c3d4e");
    window.history.replaceState(null, "", path);
    capturePromoIntent();
    expect(window.location.search).toBe("?campaign=maven-evals-0a1b2c3d4e");
    expect(readPromoCampaign()).toBe("maven-evals-0a1b2c3d4e");
  });

  it("ignores a forged campaign value in the sign-in state", () => {
    expect(
      promoSignInReturn({
        promoReturn: true,
        promoManualEntry: false,
        promoCampaign: "https://evil.example/x",
      }),
    ).toBe("/redeem");
  });
});
