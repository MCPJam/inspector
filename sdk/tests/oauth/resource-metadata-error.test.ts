import { discoverOAuthProtectedResourceMetadata } from "../../src/oauth/browser-auth.js";
import {
  describeResourceMetadataRequestFailure,
  isResourceMetadataNotImplemented,
  RESOURCE_METADATA_NO_RESPONSE,
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
    `Failed to request resource metadata: ${RESOURCE_METADATA_NO_RESPONSE}`,
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

describe("discoverOAuthProtectedResourceMetadata failure messages", () => {
  const SERVER_URL = "https://mcp.example.com/mcp";

  it("throws the not-implemented sentinel for a 404", async () => {
    const fetchFn = vi.fn(async () => new Response("", { status: 404 }));

    await expect(
      discoverOAuthProtectedResourceMetadata(SERVER_URL, undefined, fetchFn)
    ).rejects.toThrow(RESOURCE_METADATA_NOT_IMPLEMENTED);
  });

  // A transport failure is not evidence the server lacks the document — the
  // debugger's requests go through our own proxy, so it may be MCPJam that is
  // down. It must not share the sentinel the inspector suppresses.
  it("throws a distinct error when every attempt fails at the transport", async () => {
    const fetchFn = vi.fn(async () => {
      throw new TypeError("Failed to fetch");
    });

    const error = await discoverOAuthProtectedResourceMetadata(
      SERVER_URL,
      undefined,
      fetchFn
    ).catch((caught: unknown) => caught);

    expect(fetchFn).toHaveBeenCalled();
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toBe(RESOURCE_METADATA_NO_RESPONSE);
    expect(
      isResourceMetadataNotImplemented(
        describeResourceMetadataRequestFailure(error)
      )
    ).toBe(false);
  });
});
