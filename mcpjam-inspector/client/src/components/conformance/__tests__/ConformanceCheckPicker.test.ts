import { describe, expect, it } from "vitest";
import { CHECK_ERAS, MCP_CHECK_IDS } from "@mcpjam/sdk/browser";
import { runnableSelection } from "@/hooks/use-conformance-run";
import {
  checkCatalogs,
  withOAuthStep,
  withOAuthSuite,
  withPicked,
} from "../ConformanceCheckPicker";
import {
  OAUTH_ADVICE_CATALOG,
  OAUTH_CATALOG,
  TASKS_ADVICE_CATALOG,
  protocolAdviceCatalog,
} from "../conformance-catalogs";

const modernOnly = MCP_CHECK_IDS.filter(
  (id) => !(CHECK_ERAS[id] as readonly string[]).includes("legacy"),
);

describe("withPicked", () => {
  it("keeps the checks a version pin hides", () => {
    const pinned = checkCatalogs("2025-11-25").protocol;
    const next = withPicked({}, "protocol", pinned, ["ping"], false);

    expect(next.protocol).not.toContain("ping");
    // Unticking one legacy check must not drop every newer-version check.
    expect(modernOnly.length).toBeGreaterThan(0);
    for (const id of modernOnly) expect(next.protocol).toContain(id);
  });

  it("goes back to the whole suite once everything is picked", () => {
    const pinned = checkCatalogs("2025-11-25").protocol;
    const without = withPicked({}, "protocol", pinned, ["ping"], false);
    expect(
      withPicked(without, "protocol", pinned, ["ping"], true).protocol,
    ).toBeUndefined();
  });
});

describe("protocol advice picks", () => {
  it("lists only the advice a pinned version can give", () => {
    const legacy = protocolAdviceCatalog("2025-11-25").map((entry) => entry.id);
    expect(legacy).not.toContain("readiness-log-level-filtering");
    expect(
      protocolAdviceCatalog("2026-07-28").map((entry) => entry.id),
    ).toContain("readiness-log-level-filtering");
    // Auto lists all of it and tags the era-only ones.
    expect(
      protocolAdviceCatalog("auto").find(
        (entry) => entry.id === "readiness-log-level-filtering",
      )?.note,
    ).toBe("modern only");
  });

  it("keeps the advice a pin hides, and goes back to all of it", () => {
    const pinned = protocolAdviceCatalog("2025-11-25");
    const without = withPicked(
      {},
      "protocolAdvice",
      pinned,
      ["readiness-parse-error-handling"],
      false,
    );
    expect(without.protocolAdvice).not.toContain(
      "readiness-parse-error-handling",
    );
    expect(without.protocolAdvice).toContain("readiness-log-level-filtering");
    expect(
      withPicked(
        without,
        "protocolAdvice",
        pinned,
        ["readiness-parse-error-handling"],
        true,
      ).protocolAdvice,
    ).toBeUndefined();
  });

  it("keeps an empty list, which runs no advice", () => {
    const all = protocolAdviceCatalog("auto");
    const none = withPicked(
      {},
      "protocolAdvice",
      all,
      all.map((entry) => entry.id),
      false,
    );
    expect(none.protocolAdvice).toEqual([]);
    expect(runnableSelection(none, "2026-07-28")?.protocolAdvice).toEqual([]);
  });
});

describe("Tasks and OAuth advice picks", () => {
  it("picks each suite's advice in its own list", () => {
    const tasks = withPicked(
      {},
      "tasksAdvice",
      TASKS_ADVICE_CATALOG,
      ["tasks-readiness-failed-status-message"],
      false,
    );
    expect(tasks.tasksAdvice).toEqual([
      "tasks-readiness-unknown-task-id-mutations",
    ]);
    expect(tasks.protocolAdvice).toBeUndefined();

    const oauth = withPicked(
      {},
      "oauthAdvice",
      OAUTH_ADVICE_CATALOG,
      ["readiness-oauth-iss-advertised"],
      false,
    );
    expect(oauth.oauthAdvice).toEqual([]);
    expect(
      withPicked(
        oauth,
        "oauthAdvice",
        OAUTH_ADVICE_CATALOG,
        ["readiness-oauth-iss-advertised"],
        true,
      ).oauthAdvice,
    ).toBeUndefined();
  });

  it("no longer lists the iss advice under Protocol", () => {
    expect(
      protocolAdviceCatalog("auto").map((entry) => entry.id),
    ).not.toContain("readiness-oauth-iss-advertised");
  });
});

describe("runnableSelection", () => {
  it("drops ids this build does not know", () => {
    const selection = runnableSelection(
      {
        protocol: ["ping", "renamed-check"] as never,
        apps: ["gone"] as never,
        oauth: false,
      },
      "auto",
    );
    expect(selection).toEqual({
      protocol: ["ping"],
      apps: [],
      tasks: undefined,
      oauth: false,
    });
  });

  it("drops protocol checks outside a pinned version's era", () => {
    const selection = runnableSelection(
      { protocol: ["ping", ...modernOnly] },
      "2025-11-25",
    );
    expect(selection?.protocol).toEqual(["ping"]);
  });

  it("leaves an absent selection absent", () => {
    expect(runnableSelection(undefined, "auto")).toBeUndefined();
  });

  it("offers and runs the tasks update acknowledgement check", () => {
    // The app sends the answers set under it, so it runs like any other.
    const selection = runnableSelection(
      { tasks: ["tasks-update-ack-shape", "tasks-wire-resolvable"] },
      "auto",
    );
    expect(selection?.tasks).toEqual([
      "tasks-wire-resolvable",
      "tasks-update-ack-shape",
    ]);
    expect(checkCatalogs("auto").tasks.map((entry) => entry.id)).toContain(
      "tasks-update-ack-shape",
    );
  });
});

describe("OAuth checks that do not count", () => {
  const ids = OAUTH_CATALOG.map((entry) => entry.id);

  it("records an unchecked OAuth check as unscored, and the flow still runs", () => {
    const next = withOAuthStep({}, ids[0]!, false);
    expect(next).toEqual({ oauth: true, oauthUnscored: [ids[0]] });
    expect(withOAuthStep(next, ids[0]!, true)).toEqual({ oauth: true });
  });

  it("leaves the flow out once no check counts", () => {
    let selection = {};
    for (const id of ids) selection = withOAuthStep(selection, id, false);
    expect(selection).toEqual({ oauth: false });
  });

  it("turns the flow on with only the checked one counting", () => {
    const next = withOAuthStep({ oauth: false }, ids[1]!, true);
    expect(next.oauth).toBe(true);
    expect(next.oauthUnscored).toHaveLength(ids.length - 1);
    expect(next.oauthUnscored).not.toContain(ids[1]);
  });

  it("puts every check back with the suite's box", () => {
    expect(
      withOAuthSuite({ oauth: true, oauthUnscored: [ids[0]!] }, true),
    ).toEqual({ oauth: true });
  });
});
