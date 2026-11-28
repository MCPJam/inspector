import { describe, expect, it } from "vitest";
import type { LauncherAttachTask } from "@/shared/launcher-attach";
import { chooseLauncherDestination, targetsMatch } from "../destination";

const ACME = { id: "proj-acme", name: "Acme Tools" };
const BILLING = { id: "proj-billing", name: "Billing" };
const URL_B = "http://127.0.0.1:7102/mcp";

function task(overrides: Partial<LauncherAttachTask> = {}): LauncherAttachTask {
  return {
    kind: "attach",
    attachId: "a1",
    server: { name: "billing-mcp", url: URL_B },
    openProjects: [ACME],
    ...overrides,
  };
}

describe("chooseLauncherDestination", () => {
  it("saves here when every open tab shows this project", () => {
    expect(chooseLauncherDestination(task(), ACME, {})).toEqual({ kind: "save" });
  });

  it("asks when open tabs show different projects", () => {
    expect(
      chooseLauncherDestination(task({ openProjects: [ACME, BILLING] }), ACME, {}),
    ).toEqual({ kind: "ask", projects: [ACME, BILLING] });
  });

  it("reuses the entry a restart of the same dev command made", () => {
    const result = chooseLauncherDestination(
      task({
        openProjects: [ACME, BILLING],
        decision: {
          projectId: ACME.id,
          projectName: ACME.name,
          serverName: "billing-mcp",
          createdByAttach: true,
        },
      }),
      ACME,
      { "billing-mcp": { url: URL_B } },
    );
    expect(result).toEqual({ kind: "reuse", createdByAttach: true });
  });

  it("asks again after a restart if the earlier entry is gone", () => {
    const result = chooseLauncherDestination(
      task({
        openProjects: [ACME, BILLING],
        decision: {
          projectId: ACME.id,
          projectName: ACME.name,
          serverName: "billing-mcp",
          createdByAttach: true,
        },
      }),
      ACME,
      {},
    );
    expect(result.kind).toBe("ask");
  });

  it("uses a server the project already had and marks it pre-existing", () => {
    expect(
      chooseLauncherDestination(task({ openProjects: [ACME, BILLING] }), ACME, {
        "billing-mcp": { url: URL_B },
      }),
    ).toEqual({ kind: "existing" });
  });

  it("refuses a name already used by a different server", () => {
    expect(
      chooseLauncherDestination(task(), ACME, {
        "billing-mcp": { url: "http://127.0.0.1:9999/mcp" },
      }),
    ).toEqual({ kind: "conflict" });
  });

  it("leaves a request the developer routed to another project", () => {
    expect(
      chooseLauncherDestination(task({ targetProjectId: BILLING.id }), ACME, {}),
    ).toEqual({ kind: "elsewhere", projectId: BILLING.id });
  });

  it("saves without asking in the project the developer picked", () => {
    expect(
      chooseLauncherDestination(
        task({ targetProjectId: ACME.id, openProjects: [ACME, BILLING] }),
        ACME,
        {},
      ),
    ).toEqual({ kind: "save" });
  });
});

describe("targetsMatch", () => {
  it("compares URLs after normalizing them", () => {
    expect(
      targetsMatch({ url: "http://127.0.0.1:7102/mcp" }, { name: "b", url: "HTTP://127.0.0.1:7102/mcp" }),
    ).toBe(true);
  });

  it("compares a stdio command and its arguments", () => {
    const server = { name: "s", command: "node", args: ["server.js"] };
    expect(targetsMatch({ command: "node", args: ["server.js"] }, server)).toBe(true);
    expect(targetsMatch({ command: "node", args: ["other.js"] }, server)).toBe(false);
    expect(targetsMatch({ url: URL_B }, server)).toBe(false);
  });
});
