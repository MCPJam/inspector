import { describe, it } from "vitest";

// Slice 4: `loadAppState` and `saveAppState` are no-ops; Convex is the source
// of truth. The previous tests asserted localStorage persistence semantics
// that no longer apply. The OAuth-trace clearing behavior moved into
// `clearPersistedOAuthTraces` itself and is exercised by oauth-trace tests.
describe.skip("storage (deprecated)", () => {
  it("legacy persistence tests removed in Slice 4", () => {});
});
