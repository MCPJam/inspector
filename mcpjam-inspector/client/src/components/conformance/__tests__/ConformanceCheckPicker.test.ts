import { describe, expect, it } from "vitest";
import { CHECK_ERAS, MCP_CHECK_IDS } from "@mcpjam/sdk/browser";
import { runnableSelection } from "@/hooks/use-conformance-run";
import { checkCatalogs, withPicked } from "../ConformanceCheckPicker";

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

  it("never runs the tasks update acknowledgement check, which the app cannot feed", () => {
    // It needs `inputResponses`, and the app has no way to supply them, so a
    // saved pick of it is dropped like an unknown id.
    const selection = runnableSelection(
      { tasks: ["tasks-update-ack-shape", "tasks-wire-resolvable"] },
      "auto",
    );
    expect(selection?.tasks).toEqual(["tasks-wire-resolvable"]);
    expect(checkCatalogs("auto").tasks.map((entry) => entry.id)).not.toContain(
      "tasks-update-ack-shape",
    );
  });
});
