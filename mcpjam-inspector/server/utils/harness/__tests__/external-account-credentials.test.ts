import { afterEach, describe, expect, it, vi } from "vitest";

/**
 * The two-delivery credential decision for an EXTERNAL-ACCOUNT harness.
 *
 * The failure this module exists to prevent is not "the turn errors" — it is a
 * turn that STARTS with a credential that will never arrive, because the box
 * carries a placeholder and no transform was ever installed to replace it. Every
 * case below is one way that could happen.
 */

const clientState = vi.hoisted(() => ({
  rows: [] as Record<string, unknown>[],
  error: null as Error | null,
  calls: 0,
}));

vi.mock("../../computers/convex-secrets-client.js", () => ({
  convexListProjectSecretBindings: vi.fn(async () => {
    clientState.calls += 1;
    if (clientState.error) throw clientState.error;
    return clientState.rows;
  }),
  // Imported by `runtime-secrets.ts`, which this module's import graph does not
  // reach — declared so the factory is a complete stand-in for the module.
  convexListSecretsForRuntimeExecution: vi.fn(async () => []),
  convexMarkSecretsDelivered: vi.fn(async () => ({ marked: 0 })),
}));

import {
  EXTERNAL_ACCOUNT_BROKERED_PLACEHOLDER,
  fetchBrokeredCredentialNames,
  planExternalAccountCredentials,
} from "../external-account-credentials";

const CURSOR_BINDING = {
  hosts: ["api2.cursor.sh"] as [string, ...string[]],
  header: "authorization",
  template: "Bearer {}",
};
const REQUIRED = { CURSOR_API_KEY: CURSOR_BINDING };

function brokeredRow(overrides: Record<string, unknown> = {}) {
  return {
    name: "CURSOR_API_KEY",
    delivery: "brokered",
    brokerHosts: ["api2.cursor.sh"],
    brokerHeader: "authorization",
    brokerTemplate: "Bearer {}",
    ...overrides,
  };
}

afterEach(() => {
  clientState.rows = [];
  clientState.error = null;
  clientState.calls = 0;
});

describe("fetchBrokeredCredentialNames", () => {
  it("reports a correctly bound brokered secret on an ephemeral box", async () => {
    clientState.rows = [brokeredRow()];
    const result = await fetchBrokeredCredentialNames({
      bearer: "Bearer t",
      projectId: "project-1",
      boxKind: "sandbox",
      required: REQUIRED,
    });
    expect(result?.available.has("CURSOR_API_KEY")).toBe(true);
    expect(result?.misboundHosts).toEqual({});
  });

  it("answers 'none' for a PERSISTENT computer without asking anything", async () => {
    // `projectSecretsEgress.listBrokeredSecretsForBox` returns `[]` for any box
    // with no `sandboxRowId` — persistent computers receive no brokered secrets
    // in v1 — so this is a known answer, not an unknown one. Reading the
    // project's secrets would have said "yes" and started a turn whose
    // credential the box never receives.
    clientState.rows = [brokeredRow()];
    const result = await fetchBrokeredCredentialNames({
      bearer: "Bearer t",
      projectId: "project-1",
      boxKind: "computer",
      required: REQUIRED,
    });
    expect(result?.available.size).toBe(0);
    expect(clientState.calls).toBe(0);
  });

  it("returns null — not 'none' — when the metadata read fails", async () => {
    clientState.error = new Error("convex unavailable");
    const result = await fetchBrokeredCredentialNames({
      bearer: "Bearer t",
      projectId: "project-1",
      boxKind: "sandbox",
      required: REQUIRED,
    });
    expect(result).toBeNull();
  });

  it("returns null when there is no bearer to ask with", async () => {
    const result = await fetchBrokeredCredentialNames({
      projectId: "project-1",
      boxKind: "sandbox",
      required: REQUIRED,
    });
    expect(result).toBeNull();
    expect(clientState.calls).toBe(0);
  });

  it("ignores a MATERIALIZED row with the same name", async () => {
    clientState.rows = [{ name: "CURSOR_API_KEY", delivery: "materialized" }];
    const result = await fetchBrokeredCredentialNames({
      bearer: "Bearer t",
      projectId: "project-1",
      boxKind: "sandbox",
      required: REQUIRED,
    });
    expect(result?.available.size).toBe(0);
  });

  it("records a row bound to the WRONG host as misbound, not available", async () => {
    // The one misconfiguration that would otherwise reach the vendor as a
    // placeholder and come back as an unexplained 401.
    clientState.rows = [brokeredRow({ brokerHosts: ["api.example.com"] })];
    const result = await fetchBrokeredCredentialNames({
      bearer: "Bearer t",
      projectId: "project-1",
      boxKind: "sandbox",
      required: REQUIRED,
    });
    expect(result?.available.size).toBe(0);
    expect(result?.misboundHosts).toEqual({
      CURSOR_API_KEY: ["api.example.com"],
    });
  });

  it("rejects a row bound to the wrong HEADER", async () => {
    clientState.rows = [brokeredRow({ brokerHeader: "x-api-key" })];
    const result = await fetchBrokeredCredentialNames({
      bearer: "Bearer t",
      projectId: "project-1",
      boxKind: "sandbox",
      required: REQUIRED,
    });
    expect(result?.available.size).toBe(0);
  });

  it("rejects a template with no substitution point", async () => {
    // Without `{}` the backend injects a constant header and the plaintext is
    // never delivered at all.
    clientState.rows = [brokeredRow({ brokerTemplate: "Bearer" })];
    const result = await fetchBrokeredCredentialNames({
      bearer: "Bearer t",
      projectId: "project-1",
      boxKind: "sandbox",
      required: REQUIRED,
    });
    expect(result?.available.size).toBe(0);
  });

  it("accepts a template whose surrounding text differs", async () => {
    // The vendor, not MCPJam, decides what its own header may look like.
    clientState.rows = [brokeredRow({ brokerTemplate: "bearer {}" })];
    const result = await fetchBrokeredCredentialNames({
      bearer: "Bearer t",
      projectId: "project-1",
      boxKind: "sandbox",
      required: REQUIRED,
    });
    expect(result?.available.has("CURSOR_API_KEY")).toBe(true);
  });

  it("lets a correctly bound row supersede a misbound sibling", async () => {
    clientState.rows = [
      brokeredRow({ brokerHosts: ["api.example.com"] }),
      brokeredRow(),
    ];
    const result = await fetchBrokeredCredentialNames({
      bearer: "Bearer t",
      projectId: "project-1",
      boxKind: "sandbox",
      required: REQUIRED,
    });
    expect(result?.available.has("CURSOR_API_KEY")).toBe(true);
    expect(result?.misboundHosts).toEqual({});
  });
});

describe("planExternalAccountCredentials", () => {
  const base = {
    harnessDisplayName: "Cursor CLI",
    required: ["CURSOR_API_KEY"],
    brokerBinding: REQUIRED,
  };

  it("uses the MATERIALIZED value when the project has one", () => {
    const plan = planExternalAccountCredentials({
      ...base,
      secretEnv: { CURSOR_API_KEY: "key_live_abc" },
      brokeredAvailable: new Set(),
    });
    expect(plan.auth).toEqual({ CURSOR_API_KEY: "key_live_abc" });
    expect(plan.materializedNames).toEqual(["CURSOR_API_KEY"]);
    expect(plan.brokeredNames).toEqual([]);
  });

  it("hands the adapter a PLACEHOLDER on the brokered path", () => {
    const plan = planExternalAccountCredentials({
      ...base,
      secretEnv: undefined,
      brokeredAvailable: new Set(["CURSOR_API_KEY"]),
    });
    // The real key never enters this process: the backend injects it into the
    // box's egress transform, which overwrites the header outside the VM.
    expect(plan.auth).toEqual({
      CURSOR_API_KEY: EXTERNAL_ACCOUNT_BROKERED_PLACEHOLDER,
    });
    expect(plan.brokeredNames).toEqual(["CURSOR_API_KEY"]);
    // Nothing to stamp: this process delivered nothing.
    expect(plan.materializedNames).toEqual([]);
  });

  it("prefers MATERIALIZED when both deliveries are configured", () => {
    // A materialized value is the one this process can prove reached the box.
    const plan = planExternalAccountCredentials({
      ...base,
      secretEnv: { CURSOR_API_KEY: "key_live_abc" },
      brokeredAvailable: new Set(["CURSOR_API_KEY"]),
    });
    expect(plan.auth.CURSOR_API_KEY).toBe("key_live_abc");
    expect(plan.brokeredNames).toEqual([]);
  });

  it("refuses when NEITHER delivery is present, naming both", () => {
    expect(() =>
      planExternalAccountCredentials({
        ...base,
        secretEnv: undefined,
        brokeredAvailable: new Set(),
      }),
    ).toThrow(/CURSOR_API_KEY/);
    let message = "";
    try {
      planExternalAccountCredentials({
        ...base,
        secretEnv: undefined,
        brokeredAvailable: new Set(),
      });
    } catch (error) {
      message = (error as Error).message;
    }
    expect(message).toMatch(/brokered/i);
    expect(message).toMatch(/materialized/i);
    expect(message).toMatch(/Project Settings/);
    expect(message).toContain("Cursor CLI");
  });

  it("refuses on an UNESTABLISHED brokered answer exactly like an absence", () => {
    // `null` is the third state of the tri-state: a metadata read that failed.
    // Guessing "yes" here starts a turn whose credential silently never comes.
    expect(() =>
      planExternalAccountCredentials({
        ...base,
        secretEnv: undefined,
        brokeredAvailable: null,
      }),
    ).toThrow(/CURSOR_API_KEY/);
  });

  it("names the wrong hosts when a brokered row exists but is misbound", () => {
    let message = "";
    try {
      planExternalAccountCredentials({
        ...base,
        secretEnv: undefined,
        brokeredAvailable: new Set(),
        misboundHosts: { CURSOR_API_KEY: ["api.example.com"] },
      });
    } catch (error) {
      message = (error as Error).message;
    }
    // "Missing" would send the reader to create a second secret they already
    // have; the fix is a re-bind.
    expect(message).toContain("api.example.com");
    expect(message).toContain("api2.cursor.sh");
    expect(message).toMatch(/Re-bind/i);
  });

  it("refuses a name the adapter cannot broker at all, without a broker hint", () => {
    let message = "";
    try {
      planExternalAccountCredentials({
        harnessDisplayName: "Cursor CLI",
        required: ["OTHER_KEY"],
        brokerBinding: REQUIRED,
        secretEnv: undefined,
        brokeredAvailable: new Set(["OTHER_KEY"]),
      });
    } catch (error) {
      message = (error as Error).message;
    }
    // Availability alone must not satisfy a name the runtime does not
    // authenticate with by header — there is nothing to inject it into.
    expect(message).toContain("OTHER_KEY");
    expect(message).not.toMatch(/api2\.cursor\.sh/);
  });
});
