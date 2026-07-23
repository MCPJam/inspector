import { describe, expect, it } from "vitest";
import type { ModelDefinition } from "@/shared/types";
import {
  applyGuestModelLocks,
  applyOutOfCreditsLocks,
  GUEST_LOCKED_MODEL_REASON,
  OUT_OF_CREDITS_MODEL_REASON,
} from "../available-models";

// Catalog-sourced hosted models carrying the DTO `guestAllowed` flag.
const HOSTED_GUEST_GATED: ModelDefinition = {
  id: "newvendor/premium-model",
  name: "Premium",
  provider: "newvendor",
  hosted: true,
  guestAllowed: false,
};
const HOSTED_GUEST_OK: ModelDefinition = {
  id: "newvendor/free-model",
  name: "Free",
  provider: "newvendor",
  hosted: true,
  guestAllowed: true,
};
const BYOK: ModelDefinition = {
  id: "some/byok",
  name: "BYOK",
  provider: "openrouter",
};

describe("applyGuestModelLocks", () => {
  it("no-ops for authenticated users", () => {
    const models = [HOSTED_GUEST_GATED, HOSTED_GUEST_OK, BYOK];
    expect(applyGuestModelLocks(models, true)).toEqual(models);
  });

  it("locks guest-gated hosted models but leaves guest-allowed + BYOK enabled", () => {
    const [gated, ok, byok] = applyGuestModelLocks(
      [HOSTED_GUEST_GATED, HOSTED_GUEST_OK, BYOK],
      false
    );
    expect(gated.disabled).toBe(true);
    expect(gated.disabledReason).toBe(GUEST_LOCKED_MODEL_REASON);
    expect(ok.disabled).toBeUndefined();
    expect(byok.disabled).toBeUndefined();
  });

  it("defaults a hosted model with no guestAllowed flag to guest-gated (locked)", () => {
    const unknown: ModelDefinition = {
      id: "newvendor/unknown",
      name: "Unknown",
      provider: "newvendor",
      hosted: true,
    };
    const [locked] = applyGuestModelLocks([unknown], false);
    expect(locked.disabled).toBe(true);
  });
});

describe("applyOutOfCreditsLocks", () => {
  it("locks hosted (free) models but not BYOK when out of credits", () => {
    const [hosted, byok] = applyOutOfCreditsLocks(
      [HOSTED_GUEST_OK, BYOK],
      true
    );
    expect(hosted.disabled).toBe(true);
    expect(hosted.disabledReason).toBe(OUT_OF_CREDITS_MODEL_REASON);
    expect(byok.disabled).toBeUndefined();
  });

  it("no-ops when not out of credits", () => {
    const models = [HOSTED_GUEST_OK, BYOK];
    expect(applyOutOfCreditsLocks(models, false)).toEqual(models);
  });
});
