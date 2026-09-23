import {
  describeResourceMetadataRequestFailure,
  isResourceMetadataNotImplemented,
  RESOURCE_METADATA_NOT_IMPLEMENTED,
} from "../../src/oauth/state-machines/shared/resource-metadata-error.js";

describe("describeResourceMetadataRequestFailure", () => {
  it("wraps an Error with its message", () => {
    expect(
      describeResourceMetadataRequestFailure(new Error("boom"))
    ).toBe("Failed to request resource metadata: boom");
  });

  it("stringifies whatever else was thrown", () => {
    expect(describeResourceMetadataRequestFailure("boom")).toBe(
      "Failed to request resource metadata: boom"
    );
  });
});

describe("isResourceMetadataNotImplemented", () => {
  // The bare form is what `discoverOAuthProtectedResourceMetadata` throws; the
  // wrapped form is what the era machines put into flow state, and the wrapped
  // form is the one the inspector sees.
  it("matches the bare message", () => {
    expect(isResourceMetadataNotImplemented(RESOURCE_METADATA_NOT_IMPLEMENTED)).toBe(
      true
    );
  });

  it("matches the message as the machines compose it", () => {
    expect(
      isResourceMetadataNotImplemented(
        describeResourceMetadataRequestFailure(
          new Error(RESOURCE_METADATA_NOT_IMPLEMENTED)
        )
      )
    ).toBe(true);
  });

  // Narrow on purpose: these can be MCPJam's own fault — the hosted fetch path
  // breaking surfaces through the same step — so they must stay reportable.
  it.each([
    "Failed to request resource metadata: HTTP 500 trying to load well-known OAuth protected resource metadata.",
    "Failed to request resource metadata: Failed to fetch",
    "Failed to request resource metadata: Unexpected token '<'",
  ])("does not match another reason for the same step: %s", (message) => {
    expect(isResourceMetadataNotImplemented(message)).toBe(false);
  });

  it("does not match a message that merely contains it", () => {
    // Exact match, not substring — a server echoing our text back inside a
    // larger error is not the same finding.
    expect(
      isResourceMetadataNotImplemented(
        `upstream said: ${RESOURCE_METADATA_NOT_IMPLEMENTED}`
      )
    ).toBe(false);
  });

  it("does not match an unrelated step failure", () => {
    expect(isResourceMetadataNotImplemented("token exchange failed: 401")).toBe(
      false
    );
  });
});
