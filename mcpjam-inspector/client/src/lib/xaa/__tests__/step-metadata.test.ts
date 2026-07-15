import { describe, expect, it } from "vitest";
import {
  getXAAPhaseNumber,
  getXAAReceivedStepForRequest,
  getXAAStepInfo,
  XAA_PHASE_ORDER,
  XAA_PHASES,
  XAA_STEP_METADATA,
  XAA_STEP_ORDER,
} from "../step-metadata";

// The phase layer maps the debugger's machine steps onto the four numbered
// steps of draft-ietf-oauth-identity-assertion-authz-grant plus a Phase 0
// for MCP discovery. These invariants keep the teaching structure honest.

describe("XAA phase metadata", () => {
  it("assigns every step except idle to a phase", () => {
    for (const step of XAA_STEP_ORDER) {
      const { phase } = XAA_STEP_METADATA[step];
      if (step === "idle") {
        expect(phase).toBeUndefined();
      } else {
        expect(phase, `step ${step} must belong to a phase`).toBeDefined();
        expect(XAA_PHASE_ORDER).toContain(phase);
      }
    }
  });

  it("orders steps so phases never interleave or run backwards", () => {
    const phaseIndexes = XAA_STEP_ORDER.filter((s) => s !== "idle").map(
      (step) => getXAAPhaseNumber(XAA_STEP_METADATA[step].phase!)
    );
    const sorted = [...phaseIndexes].sort((a, b) => a - b);
    expect(phaseIndexes).toEqual(sorted);
  });

  it("numbers phases 0-4 with bootstrap as the only non-spec phase", () => {
    expect(getXAAPhaseNumber("bootstrap")).toBe(0);
    expect(XAA_PHASES.bootstrap.specStep).toBeNull();
    // Phases 1-4 carry the draft's step numbers in order.
    const specSteps = XAA_PHASE_ORDER.filter((p) => p !== "bootstrap").map(
      (p) => XAA_PHASES[p].specStep
    );
    expect(specSteps).toEqual([1, 2, 3, 4]);
  });

  it("matches phase numbers to spec step numbers for the grant phases", () => {
    for (const phase of XAA_PHASE_ORDER) {
      const { specStep } = XAA_PHASES[phase];
      if (specStep !== null) {
        expect(getXAAPhaseNumber(phase)).toBe(specStep);
      }
    }
  });

  it("expands the ID-JAG acronym on the received_id_jag step", () => {
    const moments = XAA_STEP_METADATA.received_id_jag.teachableMoments ?? [];
    expect(
      moments.some((m) =>
        m.includes("Identity Assertion JWT Authorization Grant")
      )
    ).toBe(true);
  });
});

describe("identity assertion format overrides", () => {
  const overriddenSteps = [
    "user_authentication",
    "received_identity_assertion",
    "token_exchange_request",
  ] as const;

  it("returns the base metadata when no format is passed (back-compat)", () => {
    for (const step of XAA_STEP_ORDER) {
      expect(getXAAStepInfo(step)).toEqual(XAA_STEP_METADATA[step]);
    }
  });

  it("returns the base metadata for the oidc format", () => {
    for (const step of XAA_STEP_ORDER) {
      expect(getXAAStepInfo(step, "oidc")).toEqual(XAA_STEP_METADATA[step]);
    }
  });

  it("overrides only the three identity-leg steps for saml", () => {
    for (const step of XAA_STEP_ORDER) {
      const info = getXAAStepInfo(step, "saml");
      if ((overriddenSteps as readonly string[]).includes(step)) {
        expect(info.title).not.toBe(XAA_STEP_METADATA[step].title);
        expect(info.summary).not.toBe(XAA_STEP_METADATA[step].summary);
        // Phase membership is shared; copy is format-accurate. No SAML-flow
        // wording may say "ID token", and it must not claim a real SP-initiated
        // SSO round-trip (the mock issues the assertion directly).
        expect(info.phase).toBe(XAA_STEP_METADATA[step].phase);
        const copy = [
          info.title,
          info.summary,
          ...(info.teachableMoments ?? []),
        ].join(" ");
        expect(copy).not.toMatch(/ID token/i);
        expect(copy).not.toMatch(/SP-initiated/i);
      } else {
        expect(info).toEqual(XAA_STEP_METADATA[step]);
      }
    }
  });

  it("names SAML in the saml override titles/summaries", () => {
    for (const step of overriddenSteps) {
      const info = getXAAStepInfo(step, "saml");
      expect(`${info.title} ${info.summary}`).toMatch(/SAML/);
    }
  });

  it("keeps the sso and token_exchange phase copy format-neutral", () => {
    for (const phase of ["sso", "token_exchange"] as const) {
      // The phase headers render once regardless of format, so they must not
      // hard-code either assertion format in the title.
      expect(XAA_PHASES[phase].title).not.toMatch(/ID token|SAML/);
      expect(XAA_PHASES[phase].title).toContain("identity assertion");
    }
  });
});

describe("dynamic registration steps", () => {
  it("keeps all four strategy-specific steps in the bootstrap phase", () => {
    for (const step of [
      "request_client_registration",
      "received_client_credentials",
      "fetch_client_metadata_document",
      "received_client_metadata",
    ] as const) {
      expect(XAA_STEP_ORDER).toContain(step);
      expect(XAA_STEP_METADATA[step].phase).toBe("bootstrap");
    }
  });
});

describe("request/response presentation pairs", () => {
  it.each([
    ["discover_resource_metadata", "received_resource_metadata"],
    ["discover_authz_metadata", "received_authz_metadata"],
    ["request_client_registration", "received_client_credentials"],
    ["fetch_client_metadata_document", "received_client_metadata"],
    ["user_authentication", "received_identity_assertion"],
    ["token_exchange_request", "received_id_jag"],
    ["jwt_bearer_request", "received_access_token"],
    ["authenticated_mcp_request", "complete"],
  ] as const)("pairs %s with %s", (request, response) => {
    expect(getXAAReceivedStepForRequest(request)).toBe(response);
  });

  it("leaves local-only actions unpaired", () => {
    expect(getXAAReceivedStepForRequest("inspect_id_jag")).toBeUndefined();
    expect(
      getXAAReceivedStepForRequest("received_client_credentials")
    ).toBeUndefined();
  });
});
