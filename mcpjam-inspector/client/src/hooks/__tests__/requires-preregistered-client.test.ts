import { describe, it, expect } from "vitest";
import {
  requiresPreregisteredClient,
  type DirectoryOAuthProbe,
} from "@/hooks/useServerDirectory";

const URL_A = "https://mcp.example.com/mcp";
const URL_B = "https://mcp.example.com/v2/mcp";

function resolvedProbe(
  overrides: Partial<DirectoryOAuthProbe> = {}
): DirectoryOAuthProbe {
  return {
    probedAt: 1755640800000,
    endpointUrl: URL_A,
    outcome: "resolved",
    supportsDcr: false,
    supportsCimd: false,
    ...overrides,
  };
}

describe("requiresPreregisteredClient", () => {
  it("badges a resolved verdict offering neither DCR nor CIMD", () => {
    expect(
      requiresPreregisteredClient({
        endpointKind: "fixed",
        remoteUrl: URL_A,
        oauthProbe: resolvedProbe(),
      })
    ).toBe(true);
  });

  it("treats absent supportsDcr/supportsCimd on a resolved verdict as unsupported", () => {
    // The schema only sets the flags when outcome is resolved; a resolved
    // verdict with both absent means the metadata answered and offered
    // neither registration path.
    expect(
      requiresPreregisteredClient({
        endpointKind: "fixed",
        remoteUrl: URL_A,
        oauthProbe: resolvedProbe({
          supportsDcr: undefined,
          supportsCimd: undefined,
        }),
      })
    ).toBe(true);
  });

  it("never badges when a registration path exists", () => {
    for (const overrides of [
      { supportsDcr: true },
      { supportsCimd: true },
    ] as const) {
      expect(
        requiresPreregisteredClient({
          endpointKind: "fixed",
          remoteUrl: URL_A,
          oauthProbe: resolvedProbe(overrides),
        })
      ).toBe(false);
    }
  });

  it("never badges no_metadata or unreachable — indistinguishable from no OAuth at all", () => {
    for (const outcome of ["no_metadata", "unreachable"] as const) {
      expect(
        requiresPreregisteredClient({
          endpointKind: "fixed",
          remoteUrl: URL_A,
          oauthProbe: resolvedProbe({ outcome }),
        })
      ).toBe(false);
    }
  });

  it("never badges a row with no verdict", () => {
    expect(
      requiresPreregisteredClient({
        endpointKind: "fixed",
        remoteUrl: URL_A,
        oauthProbe: undefined,
      })
    ).toBe(false);
  });

  it("ignores a verdict about an endpoint the row no longer points at", () => {
    // The ETL never touches oauthProbe, so between an endpoint move and the
    // next sweep a row can hold a verdict about its OLD URL.
    expect(
      requiresPreregisteredClient({
        endpointKind: "fixed",
        remoteUrl: URL_B,
        oauthProbe: resolvedProbe({ endpointUrl: URL_A }),
      })
    ).toBe(false);
  });

  it("matches options rows against their first published endpoint, like the sweep", () => {
    const base = {
      endpointKind: "options" as const,
      remoteUrl: undefined,
      remoteUrlOptions: [URL_A, URL_B],
    };
    expect(
      requiresPreregisteredClient({ ...base, oauthProbe: resolvedProbe() })
    ).toBe(true);
    expect(
      requiresPreregisteredClient({
        ...base,
        oauthProbe: resolvedProbe({ endpointUrl: URL_B }),
      })
    ).toBe(false);
  });

  it("never badges tenant rows — they have no probe target", () => {
    expect(
      requiresPreregisteredClient({
        endpointKind: "tenant",
        remoteUrl: undefined,
        remoteUrlOptions: undefined,
        oauthProbe: resolvedProbe(),
      })
    ).toBe(false);
  });
});
