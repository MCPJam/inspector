import { describe, expect, it } from "vitest";
import { runServerScope } from "../run-server-scope";

type Run = {
  client: string;
  configSnapshot: {
    tests: [];
    environment: { servers: string[] };
    environmentServerAttachmentId?: string;
  };
};

function run(client: string, servers: string[], groupId?: string): Run {
  return {
    client,
    configSnapshot: {
      tests: [],
      environment: { servers },
      ...(groupId ? { environmentServerAttachmentId: groupId } : {}),
    },
  };
}

const groups = new Map([
  ["g-uat", "CTRL UAT"],
  ["g-all", "CTRL ALL ENVS"],
]);
const options = { showGroups: true, clientLabel: (r: Run) => r.client };

describe("runServerScope", () => {
  it("merges targets that share a group, without naming clients", () => {
    expect(
      runServerScope(
        [
          run("Claude", ["CTRL UAT", "CTRL SimNext"], "g-all"),
          run("Codex", ["CTRL SimNext", "CTRL UAT"], "g-all"),
        ],
        groups,
        options,
      ),
    ).toEqual([
      {
        group: { id: "g-all", name: "CTRL ALL ENVS" },
        servers: ["CTRL UAT", "CTRL SimNext"],
        clients: [],
      },
    ]);
  });

  it("names the clients of each group when the launch used several", () => {
    const entries = runServerScope(
      [
        run("Claude", ["CTRL UAT"], "g-uat"),
        run("Codex", ["CTRL SimNext"], "g-sim"),
        run("Cursor", ["CTRL UAT"], "g-uat"),
      ],
      new Map([...groups, ["g-sim", "CTRL SimNext"]]),
      options,
    );
    expect(entries.map((e) => [e.group, e.clients])).toEqual([
      [{ id: "g-uat", name: "CTRL UAT" }, ["Claude", "Cursor"]],
      [{ id: "g-sim", name: "CTRL SimNext" }, ["Codex"]],
    ]);
  });

  it("keeps servers without a group when the run recorded none", () => {
    expect(
      runServerScope([run("Claude", ["DMS DEV"])], groups, options),
    ).toEqual([{ group: null, servers: ["DMS DEV"], clients: [] }]);
  });

  it("marks a group missing from a loaded list as deleted", () => {
    expect(
      runServerScope([run("Claude", ["DMS DEV"], "g-gone")], groups, options)[0]
        .group,
    ).toEqual({ id: "g-gone", deleted: true });
  });

  it("never reads a group as deleted while the list loads", () => {
    expect(
      runServerScope(
        [run("Claude", ["CTRL UAT"], "g-uat")],
        undefined,
        options,
      )[0].group,
    ).toEqual({ id: "g-uat", pending: true });
  });

  it("drops groups when they are hidden, keeping the servers", () => {
    expect(
      runServerScope(
        [
          run("Claude", ["CTRL UAT"], "g-uat"),
          run("Codex", ["CTRL SimNext"], "g-all"),
        ],
        groups,
        { ...options, showGroups: false },
      ),
    ).toEqual([
      { group: null, servers: ["CTRL UAT", "CTRL SimNext"], clients: [] },
    ]);
  });

  it("returns nothing for no targets", () => {
    expect(runServerScope([], groups, options)).toEqual([]);
  });
});
