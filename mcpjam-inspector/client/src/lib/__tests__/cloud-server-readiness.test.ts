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
    ).toEqual({ status: "no_servers", labels: ["Claude"] });
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
      }),
    ).toEqual({ status: "no_servers", labels: ["Claude"] });
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
    });
    expect(copy?.message).toBe(
      "Claude and Cursor have no servers to run against.",
    );
    expect(copy?.detail).toMatch(/connect a server/i);
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
