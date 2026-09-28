/**
 * SUTB-5. The rules here decide whether a cloud-only surface refuses to launch,
 * so the cases that matter are the two failure shapes the resolver reports as
 * one (`ENV_NO_SERVERS`), and — just as much — every shape that must NOT be
 * blocked: a false block walls a user off from a setup that runs fine, and the
 * resolver is still there to catch what we skip.
 */
import { describe, expect, it } from "vitest";
import {
  assessCloudServerReadiness,
  describeCloudServerBlock,
  serversAreRunnable,
  type CloudLaunchTarget,
} from "../cloud-server-readiness";

const REMOTE = {
  _id: "s-remote",
  name: "Notion",
  url: "https://mcp.notion.com/mcp",
};
const STDIO = { _id: "s-stdio", name: "Fetch", command: "uvx" };
const LOOPBACK = {
  _id: "s-local",
  name: "Local HTTP",
  url: "http://localhost:8001/mcp",
};

function client(
  label: string,
  serverCount: number | null,
  extra: Partial<CloudLaunchTarget> = {},
): CloudLaunchTarget {
  return { label, serverIds: null, serverCount, ...extra };
}

describe("assessCloudServerReadiness", () => {
  it("passes a target backed by a cloud-reachable server", () => {
    expect(
      assessCloudServerReadiness({
        targets: [client("Claude", 1)],
        servers: [REMOTE],
      }),
    ).toEqual({ status: "ok" });
  });

  it("reports a target that resolves to zero servers", () => {
    expect(
      assessCloudServerReadiness({
        targets: [client("Claude", 0), client("Cursor", 1)],
        servers: [REMOTE],
      }),
    ).toEqual({
      status: "no_servers",
      labels: ["Claude"],
      attachable: ["Notion"],
      poolSize: 1,
    });
  });

  it("reports a target whose servers are all local-only, naming them", () => {
    expect(
      assessCloudServerReadiness({
        targets: [client("Claude", 2)],
        servers: [STDIO, LOOPBACK],
      }),
    ).toEqual({
      status: "unrunnable_servers",
      labels: ["Claude"],
      serverNames: ["Fetch", "Local HTTP"],
    });
  });

  // The runner refuses a stdio server on its own; a reachable sibling does not
  // rescue it.
  it("reports a target carrying a stdio server, naming just that one", () => {
    expect(
      assessCloudServerReadiness({
        targets: [client("Claude", 2)],
        servers: [STDIO, REMOTE],
      }),
    ).toEqual({
      status: "unrunnable_servers",
      labels: ["Claude"],
      serverNames: ["Fetch"],
    });
  });

  // Only stdio is confirmed to fail on its own. A loopback URL alongside a
  // reachable server stays unblocked rather than blocked on a guess.
  // A group with no members resolves to zero servers, so it cannot back a run
  // even though there is nothing unreachable to name.
  it("calls an empty server set unrunnable", () => {
    expect(serversAreRunnable([])).toBe(false);
    expect(serversAreRunnable([REMOTE])).toBe(true);
  });

  it("passes a mixed target whose unreachable server is a loopback url", () => {
    expect(
      assessCloudServerReadiness({
        targets: [client("Claude", 2)],
        servers: [LOOPBACK, REMOTE],
      }),
    ).toEqual({ status: "ok" });
  });

  // Emptiness needs a different fix than unreachability, and reporting both at
  // once would put two instructions in one sentence.
  it("prefers the empty target when both problems are present", () => {
    expect(
      assessCloudServerReadiness({
        targets: [client("Claude", 0), client("Cursor", 1)],
        servers: [STDIO],
      })
    ).toEqual({
      status: "no_servers",
      labels: ["Claude"],
      attachable: [],
      poolSize: 1,
    });
  });

  it("judges a named group by its own members, not the whole catalog", () => {
    const group: CloudLaunchTarget = {
      label: "Prod group",
      serverIds: [REMOTE._id],
      serverCount: 1,
    };
    expect(
      assessCloudServerReadiness({
        targets: [group],
        servers: [REMOTE, STDIO],
      }),
    ).toEqual({ status: "ok" });
    expect(
      assessCloudServerReadiness({
        targets: [{ ...group, serverIds: [STDIO._id] }],
        servers: [REMOTE, STDIO],
      }),
    ).toEqual({
      status: "unrunnable_servers",
      labels: ["Prod group"],
      serverNames: ["Fetch"],
    });
  });

  describe("fails open on anything it cannot measure", () => {
    it("treats an absent server count as unknown, not zero", () => {
      expect(
        assessCloudServerReadiness({
          targets: [client("Claude", null)],
          servers: [STDIO],
        }),
      ).toEqual({ status: "ok" });
    });

    it("skips a target while the catalog is still empty", () => {
      expect(
        assessCloudServerReadiness({
          targets: [client("Claude", 3)],
          servers: [],
        }),
      ).toEqual({ status: "ok" });
    });

    it("skips a group whose members are not all in view", () => {
      expect(
        assessCloudServerReadiness({
          targets: [
            {
              label: "Prod group",
              serverIds: [STDIO._id, "s-gone"],
              serverCount: 2,
            },
          ],
          servers: [STDIO],
        }),
      ).toEqual({ status: "ok" });
    });

    it("skips an opaque target — a pinned plugin brings servers we can't see", () => {
      expect(
        assessCloudServerReadiness({
          targets: [client("Plugin env", 0, { opaque: true })],
          servers: [],
        }),
      ).toEqual({ status: "ok" });
    });

    it("passes an empty selection — other validation owns 'nothing picked'", () => {
      expect(
        assessCloudServerReadiness({ targets: [], servers: [REMOTE] }),
      ).toEqual({ status: "ok" });
    });
  });
});

describe("describeCloudServerBlock", () => {
  it("says nothing when there is nothing to say", () => {
    expect(describeCloudServerBlock({ status: "ok" })).toBeNull();
  });

  it("tells the empty case to connect a server", () => {
    const copy = describeCloudServerBlock({
      status: "no_servers",
      labels: ["Claude", "Cursor"],
      attachable: [],
      poolSize: 0,
    });
    expect(copy?.message).toBe(
      "Claude and Cursor have no servers to run against.",
    );
    // The imperative moved to the action button (BB-63).
    expect(copy?.action?.label).toMatch(/connect a server/i);
  });

  // The distinction SUTB-5 asks for: the server EXISTS, and the next step is
  // reachability rather than connecting anything.
  it("tells the local-only case why the cloud can't reach it", () => {
    const copy = describeCloudServerBlock({
      status: "unrunnable_servers",
      labels: ["Staging"],
      serverNames: ["Fetch"],
    });
    expect(copy?.message).toContain("Staging");
    expect(copy?.message).toContain("Fetch");
    expect(copy?.detail).toMatch(/MCPJam's cloud/);
    expect(copy?.detail).toMatch(/tunnel/i);
  });
});

/**
 * BB-63. "No servers to run against" is THREE situations wearing one sentence,
 * and the most common one is the one the copy gets wrong: the project already
 * has a usable server, it just isn't in this setup. Telling that user to
 * "connect a server" sends them to redo something they already did — which is
 * precisely the "what did I do wrong?" the ticket reports.
 *
 * So the assessment has to say not just THAT the target is empty, but what the
 * project could put in it. `attachable` is the reachable subset of the catalog
 * (a cloud run cannot use a stdio or loopback server, so offering one would
 * walk the user into the `unrunnable_servers` failure on the next click), and
 * `poolSize` separates "nothing to offer because the project is empty" from
 * "nothing to offer because none of it is reachable" — different fixes.
 */
describe("no_servers tells the three situations apart (BB-63)", () => {
  it("reports what the project could attach when the pool has a reachable server", () => {
    expect(
      assessCloudServerReadiness({
        targets: [client("MCPJam", 0)],
        servers: [REMOTE],
      })
    ).toEqual({
      status: "no_servers",
      labels: ["MCPJam"],
      attachable: ["Notion"],
      poolSize: 1,
    });
  });

  it("reports an empty project as nothing to attach", () => {
    expect(
      assessCloudServerReadiness({
        targets: [client("MCPJam", 0)],
        servers: [],
      })
    ).toEqual({
      status: "no_servers",
      labels: ["MCPJam"],
      attachable: [],
      poolSize: 0,
    });
  });

  // The trap this closes: "Use Fetch" would resolve, then fail at connect time
  // inside the cloud run. A server we cannot offer is not attachable.
  it("does not offer a local-only server — a cloud run cannot reach it", () => {
    expect(
      assessCloudServerReadiness({
        targets: [client("MCPJam", 0)],
        servers: [STDIO, LOOPBACK],
      })
    ).toEqual({
      status: "no_servers",
      labels: ["MCPJam"],
      attachable: [],
      poolSize: 2,
    });
  });

  it("offers only the reachable half of a mixed pool", () => {
    expect(
      assessCloudServerReadiness({
        targets: [client("MCPJam", 0)],
        servers: [STDIO, REMOTE],
      })
    ).toEqual({
      status: "no_servers",
      labels: ["MCPJam"],
      attachable: ["Notion"],
      poolSize: 2,
    });
  });
});

describe("describeCloudServerBlock points at the fix the user can take (BB-63)", () => {
  const target = { status: "no_servers" as const, labels: ["MCPJam"] };

  it("names the server the project already has instead of asking for a new one", () => {
    const copy = describeCloudServerBlock({
      ...target,
      attachable: ["Notion"],
      poolSize: 1,
    });
    const text = `${copy?.message} ${copy?.detail}`;
    expect(text).toContain("Notion");
    // The defect verbatim: this user HAS a server. "Connect a server" is an
    // instruction to redo work already done.
    expect(text).not.toMatch(/connect a server/i);
  });

  it("names a couple of servers and counts the rest rather than listing everything", () => {
    const copy = describeCloudServerBlock({
      ...target,
      attachable: ["Notion", "Linear", "Sentry", "Stripe"],
      poolSize: 4,
    });
    const text = `${copy?.message} ${copy?.detail}`;
    expect(text).toContain("Notion");
    expect(text).toContain("Linear");
    expect(text).toMatch(/2 more/);
    expect(text).not.toContain("Stripe");
  });

  it("points an unreachable-only project at reachability, not at connecting more", () => {
    const copy = describeCloudServerBlock({
      ...target,
      attachable: [],
      poolSize: 2,
    });
    const text = `${copy?.message} ${copy?.detail}`;
    expect(text).toMatch(/tunnel/i);
    expect(text).not.toMatch(/connect a server/i);
  });

  /**
   * The jargon guardrail, and the reason it is a test rather than a review
   * note: "A cloud run takes its servers from the client" is the resolver's
   * own model. It is accurate and it is unreadable to someone who has never
   * been told what a client is in MCPJam.
   *
   * Scoped to `no_servers` on purpose — `unrunnable_servers` still says "point the
   * client at that URL", which has the same problem and is outside BB-63.
   */
  it("never explains an empty setup in terms of clients", () => {
    for (const readiness of [
      { ...target, attachable: ["Notion"], poolSize: 1 },
      { ...target, attachable: [], poolSize: 0 },
      { ...target, attachable: [], poolSize: 2 },
    ]) {
      const copy = describeCloudServerBlock(readiness);
      expect(`${copy?.message} ${copy?.detail}`).not.toMatch(/\bclients?\b/i);
    }
  });
});

/**
 * BB-63 asks for "guidance messaging that is calm and less warning coded".
 * Rewriting the sentence was only half of that — the amber band and the alert
 * triangle are the other half, and a calm sentence inside an alarm box is
 * still an alarm.
 *
 * The tone is decided HERE rather than in the component that paints it,
 * because it follows from which situation this is, and that is what this
 * module already knows. The line it draws: nothing attached yet is a step in
 * setup; attached-but-unusable is a problem the user has to act on.
 */
describe("describeCloudServerBlock grades how loud the block should be (BB-63)", () => {
  it("treats a setup with nothing attached yet as guidance", () => {
    const unattached = [
      {
        status: "no_servers" as const,
        labels: ["MCPJam"],
        attachable: ["Notion"],
        poolSize: 1,
      },
      {
        status: "no_servers" as const,
        labels: ["MCPJam"],
        attachable: [],
        poolSize: 0,
      },
      {
        status: "no_servers" as const,
        labels: ["MCPJam"],
        attachable: [],
        poolSize: 2,
      },
    ];
    for (const readiness of unattached) {
      expect(describeCloudServerBlock(readiness)?.tone).toBe("guidance");
    }
  });

  it("keeps a warning for servers that ARE attached and still cannot run", () => {
    expect(
      describeCloudServerBlock({
        status: "unrunnable_servers",
        labels: ["Staging"],
        serverNames: ["Fetch"],
      })?.tone
    ).toBe("warning");
  });
});

/**
 * BB-63. "Connect a server and it shows up here" names an action the user
 * cannot take from where they are standing. For an empty project that
 * navigation is unavoidable — there is nothing on this screen to pick — so the
 * least the block can do is make it one click.
 *
 * Only the empty case gets it. A project that HAS servers is fixed by picking
 * one right here, and sending that user to Connect would be the original
 * misdiagnosis wearing a button.
 */
describe("describeCloudServerBlock offers a way out of an empty project (BB-63)", () => {
  it("points an empty project at Connect", () => {
    const copy = describeCloudServerBlock({
      status: "no_servers",
      labels: ["Claude"],
      attachable: [],
      poolSize: 0,
    });
    expect(copy?.action).toEqual({
      label: "Connect a server",
      route: "servers",
    });
  });

  it("offers no such shortcut when the project already has servers", () => {
    const withServers = describeCloudServerBlock({
      status: "no_servers",
      labels: ["Claude"],
      attachable: ["Notion"],
      poolSize: 1,
    });
    expect(withServers?.action).toBeUndefined();

    const unreachable = describeCloudServerBlock({
      status: "no_servers",
      labels: ["Claude"],
      attachable: [],
      poolSize: 2,
    });
    expect(unreachable?.action).toBeUndefined();

    const localOnly = describeCloudServerBlock({
      status: "unrunnable_servers",
      labels: ["Staging"],
      serverNames: ["Fetch"],
    });
    expect(localOnly?.action).toBeUndefined();
  });

  // The prose explains; the button acts. Repeating the imperative in both
  // reads as a stutter.
  it("leaves the imperative to the button", () => {
    const copy = describeCloudServerBlock({
      status: "no_servers",
      labels: ["Claude"],
      attachable: [],
      poolSize: 0,
    });
    expect(copy?.detail).not.toMatch(/connect a server/i);
    expect(copy?.detail).toMatch(/shows up here/i);
  });
});

/**
 * Review finding 1. The catalog arrives on its own query, so "still loading"
 * and "project is empty" reach this module as the same empty array. They lead
 * to opposite advice, and the wrong one ships a button that navigates away.
 */
describe("an unknown catalog is not an empty project (review)", () => {
  it("reports the pool as unknown rather than zero", () => {
    expect(
      assessCloudServerReadiness({
        targets: [client("Claude", 0)],
        servers: undefined,
      })
    ).toEqual({
      status: "no_servers",
      labels: ["Claude"],
      attachable: [],
      poolSize: null,
    });
  });

  it("offers no shortcut and claims nothing while the pool is unknown", () => {
    const copy = describeCloudServerBlock({
      status: "no_servers",
      labels: ["Claude"],
      attachable: [],
      poolSize: null,
    });
    expect(copy?.action).toBeUndefined();
    expect(copy?.tone).toBe("guidance");
    // Neither "connect your first one" nor "expose it over HTTPS" is known to
    // be true yet, so it must say neither.
    expect(copy?.detail).not.toMatch(/connect/i);
    expect(copy?.detail).not.toMatch(/https|tunnel/i);
  });
});

/** Review finding 2. Capping at two costs characters when there are three. */
describe("naming three servers (review)", () => {
  it("spells all three out instead of counting one of them", () => {
    const copy = describeCloudServerBlock({
      status: "no_servers",
      labels: ["Claude"],
      attachable: ["a", "b", "c"],
      poolSize: 3,
    });
    expect(copy?.detail).toContain("a, b and c");
    expect(copy?.detail).not.toMatch(/1 more/);
  });

  it("still counts the tail at four", () => {
    const copy = describeCloudServerBlock({
      status: "no_servers",
      labels: ["Claude"],
      attachable: ["a", "b", "c", "d"],
      poolSize: 4,
    });
    expect(copy?.detail).toMatch(/a, b and 2 more/);
  });
});
