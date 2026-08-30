/**
 * L3 — computing a tab's observation state token.
 *
 * Every capture the driver returns carries one of these (see `protocol.ts`); a
 * later `act` may pin itself to the token it was decided from, and the daemon
 * refuses the act if the token no longer matches — the production failure mode
 * is not duplicate delivery (the command queue handles that) but STALE
 * targeting: a click computed from a screenshot that a late-loading banner has
 * shifted. The token must therefore change whenever the page navigates OR
 * mutates structurally, and be stable otherwise.
 *
 * This module is the pure computation only: the driver supplies the raw facts
 * (the tab's nav counter, its URL, and a structural signal of the DOM) and this
 * turns them into a token. Keeping it pure makes both the hashing and the
 * change-detection semantics unit-testable without a browser.
 */
import { createHash } from "node:crypto";
import type { ObservationStateToken } from "../protocol";

/** A short, stable digest. Change-detection only — not a security boundary. */
export function shortHash(value: string): string {
  return createHash("sha1").update(value, "utf8").digest("hex").slice(0, 16);
}

export interface StateTokenInputs {
  tabId: string;
  /** Bumps on every navigation commit, so back/forward to the same URL differ. */
  navCounter: number;
  url: string;
  /**
   * A structural signal of the current DOM — e.g. a serialization of the tag
   * skeleton or the a11y tree. The driver decides its exact shape; this module
   * only needs it to change when the structure the model targeted changes.
   */
  domSignal: string;
}

export function computeStateToken(inputs: StateTokenInputs): ObservationStateToken {
  return {
    tabId: inputs.tabId,
    navCounter: inputs.navCounter,
    urlHash: shortHash(inputs.url),
    domHash: shortHash(inputs.domSignal),
  };
}
