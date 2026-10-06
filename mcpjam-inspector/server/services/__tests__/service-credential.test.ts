import { afterEach, describe, expect, it, vi } from "vitest";
import {
  HostedServiceCredentialError,
  INSPECTOR_SERVICE_TOKEN_HEADER,
  MIN_SERVICE_TOKEN_LENGTH,
  SERVICE_CREDENTIAL_CAPABILITIES,
  ServiceCredentialUnavailableError,
  assessHostedServiceCredential,
  describeServiceCredentialCapabilities,
  enforceHostedServiceCredential,
  formatServiceCredentialReport,
  getServiceCredential,
  hasServiceCredential,
  presentedServiceCredentialMatches,
  requireServiceCredential,
  serviceCredentialHeaders,
} from "../service-credential.js";

const TOKEN = "a".repeat(MIN_SERVICE_TOKEN_LENGTH + 8);

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("getServiceCredential", () => {
  it("is null when unset", () => {
    vi.stubEnv("INSPECTOR_SERVICE_TOKEN", undefined as unknown as string);
    expect(getServiceCredential()).toBeNull();
    expect(hasServiceCredential()).toBe(false);
  });

  it("treats empty and whitespace-only as unset", () => {
    expect(getServiceCredential({ INSPECTOR_SERVICE_TOKEN: "" })).toBeNull();
    expect(getServiceCredential({ INSPECTOR_SERVICE_TOKEN: " \n\t" })).toBeNull();
  });

  it("trims a pasted trailing newline", () => {
    expect(getServiceCredential({ INSPECTOR_SERVICE_TOKEN: ` ${TOKEN}\n` })).toBe(
      TOKEN,
    );
  });

  it("reads process.env at call time, so vi.stubEnv works per test", () => {
    vi.stubEnv("INSPECTOR_SERVICE_TOKEN", "first");
    expect(getServiceCredential()).toBe("first");
    vi.stubEnv("INSPECTOR_SERVICE_TOKEN", "second");
    expect(getServiceCredential()).toBe("second");
  });

  it("returns a short value as-is (length policy belongs to the crypto users)", () => {
    expect(getServiceCredential({ INSPECTOR_SERVICE_TOKEN: "short" })).toBe(
      "short",
    );
  });
});

describe("requireServiceCredential", () => {
  it("returns the credential when present", () => {
    expect(
      requireServiceCredential("Thing", { INSPECTOR_SERVICE_TOKEN: TOKEN }),
    ).toBe(TOKEN);
  });

  it("throws a typed error naming the feature when absent", () => {
    let caught: unknown;
    try {
      requireServiceCredential("Saving browser profiles", {});
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(ServiceCredentialUnavailableError);
    expect((caught as ServiceCredentialUnavailableError).feature).toBe(
      "Saving browser profiles",
    );
    expect((caught as ServiceCredentialUnavailableError).code).toBe(
      "FEATURE_REQUIRES_HOSTED",
    );
    // Never echoes a value or the variable name to the user.
    expect((caught as Error).message).not.toMatch(/INSPECTOR_SERVICE_TOKEN/);
  });
});

describe("serviceCredentialHeaders", () => {
  it("omits the header entirely when unset — never sends an empty one", () => {
    expect(serviceCredentialHeaders({})).toEqual({});
    expect(serviceCredentialHeaders({ INSPECTOR_SERVICE_TOKEN: "   " })).toEqual(
      {},
    );
  });

  it("sends the trimmed credential when set", () => {
    expect(
      serviceCredentialHeaders({ INSPECTOR_SERVICE_TOKEN: `${TOKEN}\n` }),
    ).toEqual({ [INSPECTOR_SERVICE_TOKEN_HEADER]: TOKEN });
  });
});

describe("presentedServiceCredentialMatches", () => {
  const env = { INSPECTOR_SERVICE_TOKEN: TOKEN };
  it("accepts the configured credential, trimmed on both sides", () => {
    expect(presentedServiceCredentialMatches(` ${TOKEN} `, env)).toBe(true);
  });
  it("rejects a mismatch, including a prefix of different length", () => {
    expect(presentedServiceCredentialMatches("nope", env)).toBe(false);
    expect(presentedServiceCredentialMatches(TOKEN.slice(1), env)).toBe(false);
  });
  it("fails closed when either side is missing", () => {
    expect(presentedServiceCredentialMatches(undefined, env)).toBe(false);
    expect(presentedServiceCredentialMatches("", env)).toBe(false);
    expect(presentedServiceCredentialMatches("", {})).toBe(false);
    expect(presentedServiceCredentialMatches(TOKEN, {})).toBe(false);
  });
});

describe("capability report", () => {
  it("puts everything ON with a credential and the extra secrets", () => {
    const report = describeServiceCredentialCapabilities({
      INSPECTOR_SERVICE_TOKEN: TOKEN,
      WORKOS_API_KEY: "sk_test",
    });
    expect(report.credential).toBe("present");
    expect(report.on).toHaveLength(SERVICE_CREDENTIAL_CAPABILITIES.length);
    expect(report.off).toEqual([]);
    expect(report.degraded).toEqual([]);
  });

  it("splits a tokenless build into bearer/relay fallbacks and hosted-only", () => {
    const report = describeServiceCredentialCapabilities({});
    expect(report.credential).toBe("absent");
    expect(report.on).toEqual([]);
    expect(report.degraded).toEqual(
      expect.arrayContaining([
        { id: "org-model-config", via: "bearer" },
        { id: "eval-authoring", via: "bearer" },
        { id: "api-keys", via: "relay" },
      ]),
    );
    expect(report.off).toEqual(
      expect.arrayContaining(["browser-profiles", "tool-approvals"]),
    );
  });

  it("needs WORKOS_API_KEY as well for the key features", () => {
    const report = describeServiceCredentialCapabilities({
      INSPECTOR_SERVICE_TOKEN: TOKEN,
    });
    expect(report.on).not.toContain("api-keys");
    expect(report.degraded).toContainEqual({ id: "api-keys", via: "relay" });
    expect(report.off).toContain("workos-api-keys");
  });

  it("formats names only — never the value", () => {
    const line = formatServiceCredentialReport(
      describeServiceCredentialCapabilities({ INSPECTOR_SERVICE_TOKEN: TOKEN }),
    );
    expect(line).toMatch(/^\[service-credential\] credential=present/);
    expect(line).not.toContain(TOKEN);
  });
});

describe("hosted credential enforcement", () => {
  it("assesses missing and too-short credentials", () => {
    expect(assessHostedServiceCredential({})).toBe("missing");
    expect(
      assessHostedServiceCredential({ INSPECTOR_SERVICE_TOKEN: "short" }),
    ).toBe("too-short");
    expect(
      assessHostedServiceCredential({ INSPECTOR_SERVICE_TOKEN: TOKEN }),
    ).toBeNull();
  });

  it("does nothing outside hosted mode", () => {
    const onProblem = vi.fn();
    expect(
      enforceHostedServiceCredential({ hosted: false, env: {}, onProblem }),
    ).toBeNull();
    expect(onProblem).not.toHaveBeenCalled();
  });

  it("logs loudly (and keeps booting) by default in hosted mode", () => {
    const onProblem = vi.fn();
    expect(
      enforceHostedServiceCredential({ hosted: true, env: {}, onProblem }),
    ).toBe("missing");
    expect(onProblem).toHaveBeenCalledTimes(1);
    expect(onProblem.mock.calls[0]![0]).toMatch(
      /requires INSPECTOR_SERVICE_TOKEN.*MCPJAM_REQUIRE_SERVICE_CREDENTIAL=true/,
    );
  });

  it("fails startup under MCPJAM_REQUIRE_SERVICE_CREDENTIAL=true", () => {
    expect(() =>
      enforceHostedServiceCredential({
        hosted: true,
        env: {
          INSPECTOR_SERVICE_TOKEN: "short",
          MCPJAM_REQUIRE_SERVICE_CREDENTIAL: "true",
        },
        onProblem: vi.fn(),
      }),
    ).toThrow(HostedServiceCredentialError);
  });

  it("passes a healthy hosted deployment silently", () => {
    const onProblem = vi.fn();
    expect(
      enforceHostedServiceCredential({
        hosted: true,
        env: {
          INSPECTOR_SERVICE_TOKEN: TOKEN,
          MCPJAM_REQUIRE_SERVICE_CREDENTIAL: "true",
        },
        onProblem,
      }),
    ).toBeNull();
    expect(onProblem).not.toHaveBeenCalled();
  });
});
