/**
 * The Phase 0 release gate, as a test.
 *
 * "A permalink survives WorkOS sign-in" was the one precondition for emitting
 * permalinks at all, and before this it was FALSE: `/callback` renders
 * Connect, so a signed-out recipient of
 * `/servers/<id>?project=<demo>` authenticated and landed on whichever project
 * their picker defaulted to — the exact wrong-project landing the permalink
 * work exists to end, reintroduced at the last step.
 */
import { beforeEach, describe, expect, it } from "vitest";
import {
  PERMALINK_SIGN_IN_STATE_KEY,
  permalinkSignInOptions,
  rememberPermalinkSignInReturn,
  takePermalinkSignInReturn,
} from "../permalink-signin-return";

const ORIGIN = "https://app.mcpjam.com";
const PROJECT = "v977phvmg9dttdemo";

beforeEach(() => {
  sessionStorage.clear();
});

describe("a permalink survives the sign-in round trip", () => {
  it("returns the full path AND the project scope", () => {
    const target = `/servers/p170b5c?project=${PROJECT}`;
    const nonce = rememberPermalinkSignInReturn(target, ORIGIN);
    expect(nonce).toBeTruthy();
    expect(takePermalinkSignInReturn(nonce, ORIGIN)).toBe(target);
  });

  it("survives for every exact permalink route the SDK mints", () => {
    for (const target of [
      `/servers?project=${PROJECT}`,
      `/servers/p170b5c?project=${PROJECT}`,
      `/servers/plugins/plg_1?project=${PROJECT}`,
      `/environments/env_1?project=${PROJECT}`,
      `/evals/suite/s_1/runs/run_1?project=${PROJECT}`,
      `/evals/suite/s_1?view=runs&project=${PROJECT}`,
      `/sessions?session=qh7&project=${PROJECT}`,
      `/conformance?readinessRun=rr_1&project=${PROJECT}`,
      `/swarms/sw_1?project=${PROJECT}`,
      `/user-testing/sc_1?project=${PROJECT}`,
      // Above project scope, and the one route with no `?project=` at all.
      "/organizations/org_1",
    ]) {
      const nonce = rememberPermalinkSignInReturn(target, ORIGIN);
      expect(takePermalinkSignInReturn(nonce, ORIGIN), target).toBe(target);
    }
  });

  it("survives a permalink that crosses organizations", () => {
    // Nothing here knows about orgs — and that IS the point: the org switch is
    // driven by `?project=`, which is carried verbatim, so a cross-org link
    // restores exactly like a same-org one.
    const target = `/evals/suite/s_9?project=otherorgprojectid1`;
    const nonce = rememberPermalinkSignInReturn(target, ORIGIN);
    expect(takePermalinkSignInReturn(nonce, ORIGIN)).toBe(target);
  });
});

describe("what it refuses", () => {
  it("refuses an absolute URL to another origin", () => {
    expect(
      rememberPermalinkSignInReturn("https://evil.example/x", ORIGIN),
    ).toBeNull();
    expect(rememberPermalinkSignInReturn("//evil.example/x", ORIGIN)).toBeNull();
  });

  it("refuses an absent or empty path rather than storing a marker", () => {
    // The caller is `captureCurrentReturnPath()`, which answers `null` at the
    // app root — a nonce stored for nothing would capture the NEXT sign-in in
    // this tab and redirect it somewhere the user never asked to go.
    expect(rememberPermalinkSignInReturn(null, ORIGIN)).toBeNull();
    expect(rememberPermalinkSignInReturn(undefined, ORIGIN)).toBeNull();
    expect(rememberPermalinkSignInReturn("", ORIGIN)).toBeNull();
    expect(rememberPermalinkSignInReturn("   ", ORIGIN)).toBeNull();
  });

  it("refuses the root and the callback itself", () => {
    expect(rememberPermalinkSignInReturn("/", ORIGIN)).toBeNull();
    expect(rememberPermalinkSignInReturn("/callback", ORIGIN)).toBeNull();
  });

  it("refuses an unknown first segment rather than inventing a route", () => {
    expect(
      rememberPermalinkSignInReturn("/not-a-surface/x", ORIGIN),
    ).toBeNull();
  });

  it("refuses a mismatched nonce, and clears the marker anyway", () => {
    const nonce = rememberPermalinkSignInReturn("/servers/s1", ORIGIN);
    expect(takePermalinkSignInReturn("someone-elses-nonce", ORIGIN)).toBeNull();
    // Cleared: a stale marker would capture the NEXT sign-in in this tab.
    expect(takePermalinkSignInReturn(nonce, ORIGIN)).toBeNull();
  });

  it("refuses an expired marker", () => {
    const nonce = rememberPermalinkSignInReturn("/servers/s1", ORIGIN, 1_000);
    expect(
      takePermalinkSignInReturn(nonce, ORIGIN, 1_000 + 31 * 60 * 1000),
    ).toBeNull();
  });

  it("returns nothing when nothing was stored", () => {
    expect(takePermalinkSignInReturn("nonce", ORIGIN)).toBeNull();
    expect(takePermalinkSignInReturn(undefined, ORIGIN)).toBeNull();
  });
});

describe("permalinkSignInOptions", () => {
  it("carries a nonce under the state key for a real page", () => {
    window.history.replaceState({}, "", `/servers/s1?project=${PROJECT}`);
    const options = permalinkSignInOptions();
    const nonce = options.state?.[PERMALINK_SIGN_IN_STATE_KEY];
    expect(nonce).toBeTruthy();
    expect(takePermalinkSignInReturn(nonce, window.location.origin)).toBe(
      `/servers/s1?project=${PROJECT}`,
    );
  });

  it("is an empty object at the root, so a call site never has to branch", () => {
    window.history.replaceState({}, "", "/");
    expect(permalinkSignInOptions()).toEqual({});
  });
});
