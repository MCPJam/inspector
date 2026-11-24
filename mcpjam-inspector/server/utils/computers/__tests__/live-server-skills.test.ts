/**
 * The listing a live turn makes of its connected servers' skills (SEP-2640),
 * and how those skills join the turn's set.
 *
 * PIN: modelcontextprotocol/ext-skills @ c1aa87e (`specification/stable/skills.mdx`).
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  assignServerSlugs,
  assignSkillRefs,
} from "../../../../shared/server-skill-refs";
import {
  buildLiveEffectiveCapabilities,
  withLiveServerSkills,
} from "../../../services/environments/effective-capabilities";
import {
  makeServerSkillWire,
  SKILL_URI,
} from "../../../test/support/server-skill-wire";
import { listLiveServerSkills } from "../live-server-skills";

const SERVERS = [{ serverId: "srv1", serverLabel: "Acme Billing" }];

afterEach(() => {
  vi.useRealTimers();
});

describe("listLiveServerSkills", () => {
  it("lists each declaring server's skills under the user's label for it", async () => {
    const wire = await makeServerSkillWire();
    const live = await listLiveServerSkills(wire, SERVERS);
    expect(live?.providers).toEqual([
      {
        serverId: "srv1",
        serverLabel: "Acme Billing",
        serverSlug: "acme-billing",
      },
    ]);
    expect(live?.skills.map((skill) => [skill.ref, skill.serverLabel])).toEqual(
      [["acme-billing/refunds", "Acme Billing"]],
    );
    expect(live?.skills[0]?.skillUri).toBe(SKILL_URI);
  });

  it("is undefined, and touches no wire, when no server declares the extension", async () => {
    const wire = await makeServerSkillWire({ active: false });
    expect(await listLiveServerSkills(wire, SERVERS)).toBeUndefined();
    expect(await listLiveServerSkills(wire, [])).toBeUndefined();
    expect(wire.calls).toEqual([]);
  });

  it("keeps a fast server's skills when a slow one misses the deadline", async () => {
    vi.useFakeTimers();
    // srv1 answers at once; srv2 never does.
    const wire = await makeServerSkillWire({ stalledServers: ["srv2"] });
    const pending = listLiveServerSkills(wire, [
      ...SERVERS,
      { serverId: "srv2", serverLabel: "Slow Co" },
    ]);
    await vi.advanceTimersByTimeAsync(5_000);

    // Partial, not empty: one stalled server must not make every healthy
    // server's skills invisible for the turn.
    const live = await pending;
    expect(live?.providers.map((p) => p.serverSlug)).toEqual([
      "acme-billing",
      "slow-co",
    ]);
    expect(live?.skills.map((skill) => skill.ref)).toEqual([
      "acme-billing/refunds",
    ]);
  });

  it("gives up at the deadline rather than stalling the turn", async () => {
    vi.useFakeTimers();
    // A server that never answers. Every live turn waits on this listing, so
    // an unresponsive server must not spend a user's turn on it.
    const wire = await makeServerSkillWire({ stalledServers: ["srv1"] });
    const pending = listLiveServerSkills(wire, SERVERS);
    await vi.advanceTimersByTimeAsync(5_000);
    // The server still declares the extension, so its skills stay reachable
    // by URI; the listing simply has nothing from it.
    const live = await pending;
    expect(live?.providers).toHaveLength(1);
    expect(live?.skills).toEqual([]);
  });

  it("skips a server whose listing fails and keeps the others", async () => {
    const wire = await makeServerSkillWire({ failingServers: ["srv2"] });
    const live = await listLiveServerSkills(wire, [
      ...SERVERS,
      { serverId: "srv2", serverLabel: "Broken Co" },
    ]);
    expect(live?.skills.map((skill) => skill.ref)).toEqual([
      "acme-billing/refunds",
    ]);
  });

  it("lists a server selected twice once", async () => {
    const wire = await makeServerSkillWire();
    const live = await listLiveServerSkills(wire, [...SERVERS, ...SERVERS]);
    expect(live?.providers).toHaveLength(1);
    expect(wire.calls.filter((call) => call === "skills/list")).toHaveLength(1);
  });
});

describe("slugs and refs", () => {
  it("uniquifies slugs across servers so refs cannot collide", async () => {
    const wire = await makeServerSkillWire();
    const live = await listLiveServerSkills(wire, [
      { serverId: "a", serverLabel: "Acme" },
      { serverId: "b", serverLabel: "acme" },
      { serverId: "c", serverLabel: "ACME!" },
    ]);
    expect(live?.providers.map((p) => p.serverSlug)).toEqual([
      "acme",
      "acme-2",
      "acme-3",
    ]);
  });

  it("holds a slug for a server that does not serve skills", async () => {
    // Slugs are assigned over EVERY selected server, then filtered. If the
    // filter ran first, `srv1` would take `acme-billing` here while the
    // picker, which cannot tell which servers declare the extension, still
    // showed `acme-billing-2`, and the ref the user clicked would resolve to
    // nothing.
    const servers = [
      { serverId: "srv0", serverLabel: "Acme Billing" },
      { serverId: "srv1", serverLabel: "Acme Billing" },
    ];
    const wire = await makeServerSkillWire({ inactiveServers: ["srv0"] });
    const live = await listLiveServerSkills(wire, servers);
    expect(live?.skills.map((skill) => skill.ref)).toEqual([
      "acme-billing-2/refunds",
    ]);
    // The shared assigner, run over the full list as the picker runs it,
    // agrees.
    expect(
      assignServerSlugs(servers).find(
        (entry) => entry.server.serverId === "srv1",
      )?.serverSlug,
    ).toBe("acme-billing-2");
  });

  it("disambiguates BOTH skills when one server serves a duplicated name", async () => {
    const second = {
      uri: "skill://acme/support/refunds/SKILL.md",
      frontmatter: { name: "refunds", description: "Support refunds." },
      resources: [
        { uri: "skill://acme/support/refunds/SKILL.md", digest: "sha256:x" },
      ],
    };
    const wire = await makeServerSkillWire({ extraSkills: [second] });
    const refs = (await listLiveServerSkills(wire, SERVERS))?.skills.map(
      (skill) => skill.ref,
    );
    // Neither gets the bare ref: which one arrived first is a listing-order
    // accident the server controls, and the picker must reach the same answer.
    expect(refs).not.toContain("acme-billing/refunds");
    expect(refs).toHaveLength(2);
    const expected = (
      await assignSkillRefs("acme-billing", [
        { name: "refunds", skillUri: SKILL_URI },
        { name: "refunds", skillUri: second.uri },
      ])
    ).map((entry) => entry.ref);
    expect([...(refs ?? [])].sort()).toEqual([...expected].sort());
  });
});

describe("withLiveServerSkills", () => {
  it("adds the servers' skills to the set, and the set's own entries win a ref", async () => {
    const wire = await makeServerSkillWire();
    const live = (await listLiveServerSkills(wire, SERVERS))!;
    const own = buildLiveEffectiveCapabilities({
      standaloneSkills: [
        {
          skillId: "sk_deploy",
          ref: "deploy",
          name: "deploy",
          description: "Deploy.",
          content: "# Deploy",
          aggregateHash: "h",
          files: [],
          channels: [],
        },
      ],
    });
    const joined = withLiveServerSkills(own, live);
    expect(joined.liveServerSkills?.skills.map((s) => s.ref)).toEqual([
      "acme-billing/refunds",
    ]);
    expect(joined.standaloneSkills).toBe(own.standaloneSkills);
    expect(joined.problems).toEqual([]);

    // A captured copy of the same server's skill holds the ref already.
    const captured = {
      ...own,
      serverSkills: [
        {
          skillId: "ss_refunds",
          ref: "acme-billing/refunds",
          name: "refunds",
          description: "Handle refunds.",
          content: "# Refunds",
          aggregateHash: "h",
          files: [],
          serverId: "srv1",
          serverLabel: "Acme Billing",
          skillUri: SKILL_URI,
          versionId: "v1",
          versionNumber: 1,
          capturedAt: 1,
        },
      ],
    };
    const collided = withLiveServerSkills(captured, live);
    expect(collided.liveServerSkills?.skills).toEqual([]);
    expect(collided.liveServerSkills?.providers).toEqual(live.providers);
    expect(collided.problems).toMatchObject([
      { code: "skill_ref_collision", ref: "acme-billing/refunds" },
    ]);
  });
});
