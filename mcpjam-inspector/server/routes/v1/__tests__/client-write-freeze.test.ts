import { describe, expect, it, vi } from "vitest";
import {
  freezeClientWriteArgs,
  gatedEntryFor,
  proposalInputForIdempotency,
} from "../agent-op-registry.js";

/**
 * Freezing a CLIENT WRITE proposal.
 *
 * A proposal is a contract about a specific action, and the approval route
 * executes exactly the arguments stored with it. For a client edit, three
 * things can drift between minting and clicking, and each breaks the approval
 * differently: the TARGET (a name can be repointed by a rename), the TOKENS
 * (a made-up `expectedConfigId` turns compare-and-set into "overwrite whatever
 * is there"), and the IMPACT (a consumer attached in between makes the card's
 * blast-radius sentence a lie). These pin all three.
 */

const DETAIL = {
  id: "h1",
  name: "Claude",
  configId: "hc1",
  config: { modelId: "gpt-4o-mini" },
  ownerScope: null,
  impact: {
    liveEnvironmentCount: 3,
    scenarioAttachmentCount: 1,
    activeLegacyJourneyCount: 2,
  },
};

function fakeClient(detail: unknown = DETAIL) {
  const getClient = vi.fn().mockImplementation(async () => {
    if (detail instanceof Error) throw detail;
    return detail;
  });
  return { getClient } as any;
}

const context = (client: any) => ({ projectId: "p1", client });

describe("freezeClientWriteArgs", () => {
  it("replaces a NAME selector with the exact client id", async () => {
    const client = fakeClient();
    const frozen = await freezeClientWriteArgs(
      { client: "Claude", expectedConfigId: "hc1", set: { temperature: 0.2 } },
      context(client)
    );
    // The approved action now names one row forever; a rename cannot repoint it.
    expect(frozen.client).toBe("h1");
    expect(frozen.resolvedClientId).toBe("h1");
    expect(frozen.clientLabel).toBe("Claude");
  });

  it("injects the impact the approval card will quote", async () => {
    const frozen = await freezeClientWriteArgs(
      { client: "Claude", expectedConfigId: "hc1", set: { temperature: 0.2 } },
      context(fakeClient())
    );
    expect(frozen.expectedImpact).toEqual(DETAIL.impact);
  });

  it("refuses a config token that disagrees with the server", async () => {
    // Verify, never substitute: freezing in whatever the server currently has
    // would turn compare-and-set into "overwrite whatever is there", which is
    // exactly the failure the token exists to prevent.
    await expect(
      freezeClientWriteArgs(
        {
          client: "Claude",
          expectedConfigId: "stale",
          set: { temperature: 0.2 },
        },
        context(fakeClient())
      )
    ).rejects.toThrow(/changed since it was read/i);
  });

  it("refuses a name token that disagrees with the server", async () => {
    await expect(
      freezeClientWriteArgs(
        { client: "Claude", expectedName: "Old name", name: "New" },
        context(fakeClient())
      )
    ).rejects.toThrow(/renamed since it was read/i);
  });

  it("refuses when the client cannot be read at all", async () => {
    // A hidden User Testing backing client is a 404 from the DEFAULT read the
    // agent surface uses, so it lands here as a refusal to mint.
    const client = fakeClient(new Error("Client not found"));
    await expect(
      freezeClientWriteArgs(
        { client: "Backing", expectedConfigId: "hc1", set: {} },
        context(client)
      )
    ).rejects.toThrow(/not found/i);
  });

  it("refuses when the backend reported no impact", async () => {
    // Minting an approval whose blast-radius sentence nothing can check is
    // worse than minting none.
    const { impact: _dropped, ...withoutImpact } = DETAIL;
    await expect(
      freezeClientWriteArgs(
        { client: "Claude", expectedConfigId: "hc1", set: {} },
        context(fakeClient(withoutImpact))
      )
    ).rejects.toThrow(/did not report what an edit affects/i);
  });

  it("is declared fail-closed on both frozen keys", () => {
    for (const name of ["update_client", "set_client_servers"]) {
      const entry = gatedEntryFor(name);
      expect(entry?.proposal.requiredFrozenKeys).toEqual([
        "resolvedClientId",
        "expectedImpact",
      ]);
    }
  });
});

describe("proposalInputForIdempotency for client writes", () => {
  const frozen = {
    client: "h1",
    resolvedClientId: "h1",
    clientLabel: "Claude",
    expectedConfigId: "hc1",
    expectedImpact: DETAIL.impact,
    set: { temperature: 0.2 },
  };

  it("drops the display-only and proof-only keys", () => {
    expect(proposalInputForIdempotency(frozen)).toEqual({
      client: "h1",
      expectedConfigId: "hc1",
      expectedImpact: DETAIL.impact,
      set: { temperature: 0.2 },
    });
  });

  it("gives a renamed-but-identical action the SAME identity", () => {
    // A harmless rename between Slack redeliveries must not mint a second
    // approval control for the same frozen action.
    const renamed = { ...frozen, clientLabel: "Claude QA" };
    expect(proposalInputForIdempotency(renamed)).toEqual(
      proposalInputForIdempotency(frozen)
    );
  });

  it("gives a CHANGED IMPACT a different identity", () => {
    // A different blast radius is a different action, and the human should be
    // asked about it again rather than shown the old card.
    const widened = {
      ...frozen,
      expectedImpact: { ...DETAIL.impact, liveEnvironmentCount: 9 },
    };
    expect(proposalInputForIdempotency(widened)).not.toEqual(
      proposalInputForIdempotency(frozen)
    );
  });

  it("leaves inputs with no client keys untouched", () => {
    const other = { suite: "smoke", models: ["a"] };
    expect(proposalInputForIdempotency(other)).toEqual(other);
  });
});

describe("gated client proposal copy", () => {
  const describeFor = (name: string, input: Record<string, unknown>) =>
    gatedEntryFor(name)!.proposal.describe(input);

  it("states the field change and all three impact counts", () => {
    const copy = describeFor("update_client", {
      client: "h1",
      clientLabel: "Claude",
      expectedConfigId: "hc1",
      expectedImpact: DETAIL.impact,
      set: { temperature: 0.2 },
    });
    expect(copy).toContain("**Claude**");
    expect(copy).toContain("set temperature to 0.2");
    expect(copy).toContain("3 live environments");
    expect(copy).toContain("1 scenario attachment");
    expect(copy).toContain("2 active legacy journeys");
    expect(copy).toContain(
      "Past runs and pinned suite snapshots are unaffected"
    );
  });

  it("says so plainly when nothing durable uses the client", () => {
    // "This affects nothing else" is information. Omitting the sentence would
    // read as the counts having been left out.
    const copy = describeFor("update_client", {
      client: "h1",
      clientLabel: "Claude",
      expectedConfigId: "hc1",
      expectedImpact: {
        liveEnvironmentCount: 0,
        scenarioAttachmentCount: 0,
        activeLegacyJourneyCount: 0,
      },
      set: { temperature: 0.2 },
    });
    expect(copy).toContain("Nothing durable currently uses this client");
  });

  it("claims nothing about execution for a rename-only edit", () => {
    // A rename does not change what any environment or journey resolves, and
    // asking for consent to an effect that does not happen is worse copy, not
    // safer copy.
    const copy = describeFor("update_client", {
      client: "h1",
      clientLabel: "Claude",
      expectedName: "Claude",
      name: "Claude QA",
      expectedImpact: DETAIL.impact,
    });
    expect(copy).toBe("Rename client **Claude** to **Claude QA**");
  });

  it("states both halves of a combined rename-and-edit", () => {
    const copy = describeFor("update_client", {
      client: "h1",
      clientLabel: "Claude",
      expectedName: "Claude",
      expectedConfigId: "hc1",
      name: "Claude QA",
      expectedImpact: DETAIL.impact,
      set: { harness: null },
    });
    expect(copy).toContain("clear harness");
    expect(copy).toContain("rename it to **Claude QA**");
    expect(copy).toContain("3 live environments");
  });

  it("warns that a server replacement detaches what it omits", () => {
    const copy = describeFor("set_client_servers", {
      client: "h1",
      clientLabel: "Claude",
      serverIds: ["s1", "s2"],
      expectedConfigId: "hc1",
      expectedImpact: DETAIL.impact,
    });
    expect(copy).toContain("2 required");
    expect(copy).toContain("Servers not listed are detached");
  });

  it("names the template a create came from", () => {
    expect(
      describeFor("create_client", { name: "Claude QA", template: "claude" })
    ).toBe("Create client **Claude QA** from template claude");
  });
});
