import { describe, expect, it } from "vitest";
import {
  checkedAccountIds,
  chosenAccountProblems,
  runsAsEntries,
  serverIdsForRefs,
  type SuiteAccountsServer,
  type SuiteAccountsView,
} from "../eval-accounts";

const live = {
  connectionId: "conn-live",
  name: "Live",
  isDefault: true,
  needsReauth: false,
};
const dummy = {
  connectionId: "conn-dummy",
  name: "Dummy",
  isDefault: false,
  needsReauth: false,
};

function asana(overrides: Partial<SuiteAccountsServer> = {}): SuiteAccountsServer {
  return {
    serverId: "srv-asana",
    mode: "accounts",
    accounts: [live, dummy],
    chosen: null,
    ...overrides,
  };
}

const names = (serverId: string) =>
  ({ "srv-asana": "Asana", "srv-linear": "Linear" })[serverId] ?? serverId;

describe("checkedAccountIds", () => {
  it("preselects the default account when nothing is saved", () => {
    expect(checkedAccountIds(asana())).toEqual(["conn-live"]);
    expect(checkedAccountIds(asana({ chosen: [] }))).toEqual(["conn-live"]);
  });

  it("keeps the saved choice and drops an account that was removed", () => {
    expect(checkedAccountIds(asana({ chosen: ["conn-dummy"] }))).toEqual([
      "conn-dummy",
    ]);
    expect(
      checkedAccountIds(asana({ chosen: ["conn-dummy", "conn-gone"] })),
    ).toEqual(["conn-dummy"]);
  });
});

describe("chosenAccountProblems", () => {
  it("names a chosen account that needs reconnecting", () => {
    const view: SuiteAccountsView = {
      servers: [
        asana({
          chosen: ["conn-dummy"],
          accounts: [live, { ...dummy, needsReauth: true }],
        }),
      ],
      scheduleOwners: [],
    };
    expect(chosenAccountProblems(view, names)).toEqual([
      {
        kind: "needs_reconnect",
        serverId: "srv-asana",
        serverName: "Asana",
        connectionId: "conn-dummy",
        accountName: "Dummy",
      },
    ]);
  });

  it("reports a removed choice once per server", () => {
    const view: SuiteAccountsView = {
      servers: [asana({ chosen: ["conn-gone", "conn-also-gone"] })],
      scheduleOwners: [],
    };
    expect(chosenAccountProblems(view, names)).toEqual([
      { kind: "removed", serverId: "srv-asana", serverName: "Asana" },
    ]);
  });

  it("leaves a suite nobody chose accounts for alone, even when the default needs reconnecting", () => {
    const view: SuiteAccountsView = {
      servers: [asana({ accounts: [{ ...live, needsReauth: true }, dummy] })],
      scheduleOwners: [],
    };
    expect(chosenAccountProblems(view, names)).toEqual([]);
  });
});

describe("runsAsEntries", () => {
  it("lists each of the person's servers with the accounts it runs with", () => {
    const view: SuiteAccountsView = {
      servers: [
        asana({ chosen: ["conn-dummy"] }),
        {
          serverId: "srv-linear",
          mode: "accounts",
          accounts: [
            { connectionId: "w", name: "Work", isDefault: true, needsReauth: false },
          ],
          chosen: null,
        },
        { serverId: "srv-shared", mode: "shared", accounts: [], chosen: null },
      ],
      scheduleOwners: [],
    };
    expect(runsAsEntries(view, names)).toEqual([
      {
        serverId: "srv-asana",
        serverName: "Asana",
        accounts: [{ name: "Dummy", needsReauth: false }],
      },
      {
        serverId: "srv-linear",
        serverName: "Linear",
        accounts: [{ name: "Work", needsReauth: false }],
      },
    ]);
  });
});

describe("serverIdsForRefs", () => {
  it("resolves names and ids to project server ids, once each, in order", () => {
    const servers = [
      { _id: "srv-asana", name: "Asana" },
      { _id: "srv-linear", name: "Linear" },
    ];
    expect(
      serverIdsForRefs(["Linear", "srv-asana", "Asana", "Gone"], servers),
    ).toEqual(["srv-linear", "srv-asana"]);
    expect(serverIdsForRefs(["Asana"], undefined)).toEqual([]);
  });
});
