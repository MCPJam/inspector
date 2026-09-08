import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

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
  /** What the run's ENVIRONMENT selects — the grant boundary. */
  selection: [] as string[],
  selectionError: null as Error | null,
  selectionCalls: 0,
}));

vi.mock("../../computers/convex-secrets-client.js", () => ({
  convexListProjectSecretBindings: vi.fn(async () => {
    clientState.calls += 1;
    if (clientState.error) throw clientState.error;
    return clientState.rows;
  }),
  convexGetEnvironmentSecretSelection: vi.fn(async () => {
    clientState.selectionCalls += 1;
    if (clientState.selectionError) throw clientState.selectionError;
    return clientState.selection;
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

const SELECTED_ID = "secret-cursor";

function brokeredRow(overrides: Record<string, unknown> = {}) {
  return {
    secretId: SELECTED_ID,
    name: "CURSOR_API_KEY",
    delivery: "brokered",
    brokerHosts: ["api2.cursor.sh"],
    brokerHeader: "authorization",
    brokerTemplate: "Bearer {}",
    ...overrides,
  };
}

type BrokeredAsk = Parameters<typeof fetchBrokeredCredentialNames>[0];

/** The default ask: an ephemeral box, on an environment that DOES grant the
 *  row `brokeredRow()` produces. Every case that changes one of those states
 *  overrides it explicitly. */
function ask(overrides: Partial<BrokeredAsk> = {}): BrokeredAsk {
  return {
    bearer: "Bearer t",
    projectId: "project-1",
    environmentId: "env-1",
    boxKind: "sandbox",
    required: REQUIRED,
    ...overrides,
  };
}

beforeEach(() => {
  clientState.selection = [SELECTED_ID];
});

afterEach(() => {
  clientState.rows = [];
  clientState.error = null;
  clientState.calls = 0;
  clientState.selection = [];
  clientState.selectionError = null;
  clientState.selectionCalls = 0;
});

describe("fetchBrokeredCredentialNames", () => {
  it("reports a correctly bound brokered secret on an ephemeral box", async () => {
    clientState.rows = [brokeredRow()];
    const result = await fetchBrokeredCredentialNames(ask());
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
    const result = await fetchBrokeredCredentialNames(
      ask({ boxKind: "computer" }),
    );
    expect(result?.available.size).toBe(0);
    expect(clientState.calls).toBe(0);
  });

  it("does NOT report a correctly bound row the ENVIRONMENT does not select", async () => {
    // THE bug this scoping exists to close. The project holds a brokered
    // CURSOR_API_KEY, bound to exactly the right host/header/template — but the
    // environment this run launched from does not grant it, so
    // `listBrokeredSecretsForBox` composes NOTHING onto the box. Reporting it
    // available starts a turn that provisions a sandbox and then authenticates
    // with the placeholder.
    clientState.rows = [brokeredRow()];
    clientState.selection = ["secret-something-else"];
    const result = await fetchBrokeredCredentialNames(ask());
    expect(result?.available.size).toBe(0);
    expect(result?.unselected.has("CURSOR_API_KEY")).toBe(true);
    // Not a binding problem — the binding is perfect. Saying "misbound" would
    // send the reader to re-bind a correct row.
    expect(result?.misboundHosts).toEqual({});
    expect(result?.environmentMissing).toBe(false);
  });

  it("does NOT report anything when the environment selects nothing at all", async () => {
    clientState.rows = [brokeredRow()];
    clientState.selection = [];
    const result = await fetchBrokeredCredentialNames(ask());
    expect(result?.available.size).toBe(0);
    expect(result?.unselected.has("CURSOR_API_KEY")).toBe(true);
  });

  it("treats an ABSENT environment as no grant, and says which", async () => {
    // The backend agrees: `resolveGrantForSandbox` answers NO_GRANT whenever it
    // cannot resolve an environment for the box, so nothing is composed.
    clientState.rows = [brokeredRow()];
    const result = await fetchBrokeredCredentialNames(
      ask({ environmentId: undefined }),
    );
    expect(result?.available.size).toBe(0);
    expect(result?.unselected.has("CURSOR_API_KEY")).toBe(true);
    expect(result?.environmentMissing).toBe(true);
    // Nothing to scope against, so nothing to ask.
    expect(clientState.selectionCalls).toBe(0);
  });

  it("carries a caller's UNRESOLVED reason through, without changing the answer", async () => {
    // Eval replay: the run has an environment, this process cannot name it.
    // The availability answer is identical to any other unnamed environment —
    // refused — but the reason rides along so the copy can be honest.
    clientState.rows = [brokeredRow()];
    const result = await fetchBrokeredCredentialNames(
      ask({
        environmentId: undefined,
        environmentUnresolvedReason: "replaying a run does not carry it.",
      }),
    );
    expect(result?.available.size).toBe(0);
    expect(result?.unselected.has("CURSOR_API_KEY")).toBe(true);
    expect(result?.environmentMissing).toBe(true);
    expect(result?.environmentUnresolvedReason).toBe(
      "replaying a run does not carry it.",
    );
    expect(clientState.selectionCalls).toBe(0);
  });

  it("ignores an unresolved reason when the environment IS known", async () => {
    // Defensive: a caller that sets both must not have its selection check
    // downgraded into an excuse.
    clientState.rows = [brokeredRow()];
    clientState.selection = ["secret-something-else"];
    const result = await fetchBrokeredCredentialNames(
      ask({ environmentUnresolvedReason: "should be ignored" }),
    );
    expect(result?.environmentMissing).toBe(false);
    expect(result?.environmentUnresolvedReason).toBeUndefined();
    expect(result?.unselected.has("CURSOR_API_KEY")).toBe(true);
  });

  it("skips the environment read when the project brokers nothing", async () => {
    // A project with no brokered row for this credential gets the same "add it"
    // refusal it always got — one query, not two.
    clientState.rows = [
      { secretId: "s1", name: "OTHER", delivery: "brokered" },
    ];
    const result = await fetchBrokeredCredentialNames(ask());
    expect(result?.available.size).toBe(0);
    expect(clientState.selectionCalls).toBe(0);
  });

  it("returns null — not 'none' — when the ENVIRONMENT read fails", async () => {
    // Same tri-state rule as the bindings read: an unestablished grant is
    // refused, never guessed in either direction.
    clientState.rows = [brokeredRow()];
    clientState.selectionError = new Error("convex unavailable");
    const result = await fetchBrokeredCredentialNames(ask());
    expect(result).toBeNull();
  });

  it("returns null — not 'none' — when the metadata read fails", async () => {
    clientState.error = new Error("convex unavailable");
    const result = await fetchBrokeredCredentialNames(ask());
    expect(result).toBeNull();
  });

  it("returns null when there is no bearer to ask with", async () => {
    const result = await fetchBrokeredCredentialNames({
      projectId: "project-1",
      environmentId: "env-1",
      boxKind: "sandbox",
      required: REQUIRED,
    });
    expect(result).toBeNull();
    expect(clientState.calls).toBe(0);
  });

  it("ignores a MATERIALIZED row with the same name", async () => {
    clientState.rows = [{ name: "CURSOR_API_KEY", delivery: "materialized" }];
    const result = await fetchBrokeredCredentialNames(ask());
    expect(result?.available.size).toBe(0);
  });

  it("records a row bound to the WRONG host as misbound, not available", async () => {
    // The one misconfiguration that would otherwise reach the vendor as a
    // placeholder and come back as an unexplained 401.
    clientState.rows = [brokeredRow({ brokerHosts: ["api.example.com"] })];
    const result = await fetchBrokeredCredentialNames(ask());
    expect(result?.available.size).toBe(0);
    expect(result?.misboundHosts).toEqual({
      CURSOR_API_KEY: ["api.example.com"],
    });
  });

  it("rejects a row bound to the wrong HEADER", async () => {
    clientState.rows = [brokeredRow({ brokerHeader: "x-api-key" })];
    const result = await fetchBrokeredCredentialNames(ask());
    expect(result?.available.size).toBe(0);
  });

  it("rejects a template with no substitution point", async () => {
    // Without `{}` the backend injects a constant header and the plaintext is
    // never delivered at all.
    clientState.rows = [brokeredRow({ brokerTemplate: "Bearer" })];
    const result = await fetchBrokeredCredentialNames(ask());
    expect(result?.available.size).toBe(0);
  });

  it("accepts a template whose surrounding text differs", async () => {
    // The vendor, not MCPJam, decides what its own header may look like.
    clientState.rows = [brokeredRow({ brokerTemplate: "bearer {}" })];
    const result = await fetchBrokeredCredentialNames(ask());
    expect(result?.available.has("CURSOR_API_KEY")).toBe(true);
  });

  it("lets a correctly bound row supersede a misbound sibling", async () => {
    clientState.rows = [
      brokeredRow({
        secretId: "secret-wrong",
        brokerHosts: ["api.example.com"],
      }),
      brokeredRow(),
    ];
    clientState.selection = ["secret-wrong", SELECTED_ID];
    const result = await fetchBrokeredCredentialNames(ask());
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

  it("names the SELECTION as the fix when the row exists but is not granted", () => {
    // "Add a CURSOR_API_KEY" would be wrong twice over: the secret exists, and
    // the reader would create a duplicate instead of granting the one they have.
    let message = "";
    try {
      planExternalAccountCredentials({
        ...base,
        secretEnv: undefined,
        brokeredAvailable: new Set(),
        unselected: new Set(["CURSOR_API_KEY"]),
      });
    } catch (error) {
      message = (error as Error).message;
    }
    expect(message).toContain("CURSOR_API_KEY");
    expect(message).toMatch(/does not select it/i);
    expect(message).not.toMatch(/Project Settings . Secrets/);
  });

  it("says there is NO environment when that is why nothing is granted", () => {
    let message = "";
    try {
      planExternalAccountCredentials({
        ...base,
        secretEnv: undefined,
        brokeredAvailable: new Set(),
        unselected: new Set(["CURSOR_API_KEY"]),
        environmentMissing: true,
      });
    } catch (error) {
      message = (error as Error).message;
    }
    expect(message).toMatch(/no Project Environment/i);
    expect(message).toMatch(/grant boundary/i);
  });

  it("blames the PATH, not the user, when the environment could not be named", () => {
    // The replay refusal. The reader's secret and selection may both be
    // perfect, so the copy must not tell them to change either — and must not
    // claim the run has no environment, because it does.
    let message = "";
    try {
      planExternalAccountCredentials({
        ...base,
        secretEnv: undefined,
        brokeredAvailable: new Set(),
        unselected: new Set(["CURSOR_API_KEY"]),
        environmentMissing: true,
        environmentUnresolvedReason:
          "replaying a run does not carry the original run's Project " +
          "Environment through to the runner.",
      });
    } catch (error) {
      message = (error as Error).message;
    }
    expect(message).toContain("CURSOR_API_KEY");
    expect(message).toContain("replaying a run");
    // NOT the remediation for a selection the reader never made…
    expect(message).not.toMatch(/does not select it/i);
    expect(message).not.toMatch(/no Project Environment/i);
    // …and it says plainly that the secret is fine.
    expect(message).toMatch(/nothing about the secret itself needs to change/i);
  });

  it("prefers the MISBOUND complaint over the unselected one", () => {
    // A granted row with the wrong binding is the sharper problem: re-binding
    // is the fix, and the selection is already correct.
    let message = "";
    try {
      planExternalAccountCredentials({
        ...base,
        secretEnv: undefined,
        brokeredAvailable: new Set(),
        misboundHosts: { CURSOR_API_KEY: ["api.example.com"] },
        unselected: new Set(["CURSOR_API_KEY"]),
      });
    } catch (error) {
      message = (error as Error).message;
    }
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
