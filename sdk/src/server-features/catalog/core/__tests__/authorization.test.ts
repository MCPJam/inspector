import { describe, expect, it } from "vitest";
import { makeProbe, makeSurface } from "../../../__tests__/fixtures.js";
import type { ProbeSummary, ProbeSurface } from "../../../types.js";
import { CORE_FEATURES } from "../index.js";
import {
  declared,
  fromOAuthFlow,
  isGap,
  kindOf,
  makeOAuthSummary,
  probed,
} from "./helpers.js";

const auth = CORE_FEATURES.filter(
  (entry) => entry.family === "core-authorization"
);

function authorization(
  values: ProbeSummary<"authorization">["values"],
  overrides: Partial<
    Omit<ProbeSummary<"authorization">, "probeId" | "values">
  > = {}
): ProbeSurface {
  return { authorization: makeProbe("authorization", values, overrides) };
}

const required = { oauthRequired: true, oauthOptional: false } as const;

describe("authorization applicability", () => {
  it("is not applicable on stdio", () => {
    const stdio = makeSurface({ transport: "stdio" });
    for (const entry of auth) {
      expect(kindOf(entry.assessment.declared?.(stdio) ?? null), entry.id).toBe(
        "not-applicable"
      );
    }
  });

  it("is not applicable when the server answers without authorization", () => {
    const open = authorization({ oauthRequired: false, oauthOptional: false });
    const withProbe = auth.filter((entry) => entry.assessment.probed);
    expect(withProbe.length).toBe(auth.length);
    for (const entry of withProbe) {
      expect(kindOf(entry.assessment.probed?.(open) ?? null), entry.id).toBe(
        "not-applicable"
      );
    }
  });

  it("applies when OAuth is optional, and waits on a probe that did not finish", () => {
    const optional = authorization({
      oauthRequired: false,
      oauthOptional: true,
    });
    expect(probed("auth.oauth", optional)).toMatchObject({
      kind: "present",
      detail: "Accepts OAuth when offered.",
    });
    const failed = authorization({}, { status: "failed" });
    expect(kindOf(probed("auth.prm", failed))).toBe("unknown");
    const skipped = authorization({}, { status: "not-applicable" });
    expect(kindOf(probed("auth.prm", skipped))).toBe("not-applicable");
    expect(probed("auth.prm", {})).toBeNull();
  });
});

describe("protected resource and authorization server metadata", () => {
  it("reads the challenge and where the metadata was found", () => {
    const viaHeader = authorization({
      ...required,
      challengeHasResourceMetadata: true,
      prmFound: true,
      prmAuthorizationServers: ["https://auth.example.com"],
    });
    expect(kindOf(probed("auth.resource-metadata-challenge", viaHeader))).toBe(
      "present"
    );
    expect(probed("auth.prm", viaHeader)).toMatchObject({
      kind: "present",
      count: 1,
    });
    expect(kindOf(probed("auth.prm-well-known", viaHeader))).toBe("unknown");
    expect(
      kindOf(probed("auth.multiple-authorization-servers", viaHeader))
    ).toBe("not-applicable");

    const wellKnown = authorization({
      ...required,
      challengeHasResourceMetadata: false,
      prmFound: true,
      prmAuthorizationServers: [
        "https://a.example.com",
        "https://b.example.com",
      ],
    });
    expect(kindOf(probed("auth.prm-well-known", wellKnown))).toBe("present");
    expect(
      isGap(
        probed("auth.resource-metadata-challenge", wellKnown),
        makeSurface()
      )
    ).toBe(true);
    expect(
      probed("auth.multiple-authorization-servers", wellKnown)
    ).toMatchObject({
      count: 2,
    });
  });

  it("reports missing metadata as a gap only from a complete probe", () => {
    const missing = authorization({ ...required, prmFound: false });
    expect(isGap(probed("auth.prm", missing), makeSurface())).toBe(true);
    const partial = authorization(
      { ...required, prmFound: false },
      { coverage: "partial" }
    );
    expect(kindOf(probed("auth.prm", partial))).toBe("unknown");
  });

  it("does not grade a challenge sent with the wrong status", () => {
    const odd = authorization({
      ...required,
      nonCompliantChallengeStatus: 403,
      challengeHasResourceMetadata: true,
    });
    expect(kindOf(probed("auth.resource-metadata-challenge", odd))).toBe(
      "unknown"
    );
  });

  it("reads PKCE, CIMD, DCR and the issuer from authorization server metadata", () => {
    const metadata = authorization({
      ...required,
      prmFound: true,
      prmAuthorizationServers: ["https://auth.example.com"],
      asMetadataFound: true,
      asMetadataKind: "oidc",
      issuer: "https://auth.example.com",
      codeChallengeMethods: ["S256"],
      cimdSupported: true,
      registrationEndpoint: false,
    });
    expect(probed("auth.as-metadata", metadata)).toMatchObject({
      kind: "present",
      detail: "OpenID Connect discovery.",
    });
    expect(kindOf(probed("auth.pkce", metadata))).toBe("present");
    expect(kindOf(probed("auth.cimd", metadata))).toBe("present");
    expect(kindOf(probed("auth.dcr", metadata))).toBe("absent");
    expect(kindOf(probed("auth.issuer-validation", metadata))).toBe("present");

    const mismatch = authorization({
      ...required,
      prmAuthorizationServers: ["https://auth.example.com"],
      asMetadataFound: true,
      issuer: "https://other.example.com",
      codeChallengeMethods: ["plain"],
    });
    expect(kindOf(probed("auth.issuer-validation", mismatch))).toBe("absent");
    expect(kindOf(probed("auth.pkce", mismatch))).toBe("absent");

    const noMetadata = authorization({ ...required, asMetadataFound: false });
    expect(probed("auth.pkce", noMetadata)).toBeNull();
    expect(kindOf(probed("auth.as-metadata", noMetadata))).toBe("absent");
  });
});

describe("connect OAuth flow", () => {
  it("shows what only a real sign-in can", () => {
    const summary = makeOAuthSummary();
    for (const id of [
      "auth.oauth",
      "auth.resource-indicators",
      "auth.scope-selection",
      "auth.iss-parameter",
      "auth.issuer-binding",
      "auth.refresh-tokens",
    ]) {
      expect(kindOf(fromOAuthFlow(id, summary)), id).toBe("present");
    }
    expect(fromOAuthFlow("auth.pre-registration", summary)).toBeNull();
    expect(
      kindOf(
        fromOAuthFlow(
          "auth.pre-registration",
          makeOAuthSummary({ registrationStrategy: "preregistered" })
        )
      )
    ).toBe("present");
  });

  it("separates what MCPJam did not ask for from what the server refused", () => {
    expect(
      kindOf(
        fromOAuthFlow(
          "auth.resource-indicators",
          makeOAuthSummary({ resourceIndicatorSent: false })
        )
      )
    ).toBe("unknown");
    expect(
      kindOf(
        fromOAuthFlow(
          "auth.refresh-tokens",
          makeOAuthSummary({ refreshTokenIssued: false })
        )
      )
    ).toBe("unknown");
    expect(
      kindOf(
        fromOAuthFlow(
          "auth.refresh-tokens",
          makeOAuthSummary({
            refreshTokenIssued: false,
            scopesRequested: ["read", "offline_access"],
          })
        )
      )
    ).toBe("absent");
    expect(
      kindOf(
        fromOAuthFlow(
          "auth.iss-parameter",
          makeOAuthSummary({ issReturned: false })
        )
      )
    ).toBe("absent");
  });

  it("lets set-up features say how to set them up", () => {
    const preRegistration = auth.find(
      (entry) => entry.id === "auth.pre-registration"
    );
    expect(preRegistration?.assessment).toMatchObject({
      primary: "configured",
      setup: "pre-registered-client",
    });
    expect(declared("auth.oauth", makeSurface())).toBeNull();
  });
});
