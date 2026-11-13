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

  it("hides group names but still says which client used which servers", () => {
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
      { group: null, servers: ["CTRL UAT"], clients: ["Claude"] },
      { group: null, servers: ["CTRL SimNext"], clients: ["Codex"] },
    ]);
  });

  it("merges hidden groups that connected the same servers", () => {
    expect(
      runServerScope(
        [
          run("Claude", ["A", "B"], "g-uat"),
          run("Codex", ["B", "A"], "g-all"),
        ],
        groups,
        { ...options, showGroups: false },
      ),
    ).toEqual([{ group: null, servers: ["A", "B"], clients: [] }]);
  });

  it("splits targets without a group by the servers they ran against", () => {
    const entries = runServerScope(
      [run("Claude", ["DMS DEV"]), run("Codex", ["DMS QA"])],
      groups,
      options,
    );
    expect(entries.map((e) => [e.group, e.servers, e.clients])).toEqual([
      [null, ["DMS DEV"], ["Claude"]],
      [null, ["DMS QA"], ["Codex"]],
    ]);
  });

  it("lists a server once, in first-seen order", () => {
    expect(
      runServerScope(
        [run("Claude", ["B", "A", "B"], "g-uat"), run("Codex", ["A", "C"], "g-uat")],
        groups,
        options,
      )[0].servers,
    ).toEqual(["B", "A", "C"]);
  });

  it("returns nothing for no targets", () => {
    expect(runServerScope([], groups, options)).toEqual([]);
  });
});
