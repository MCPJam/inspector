/**
 * Surface resolution for the tool-call task seam.
 *
 * The scan at the bottom is the load-bearing test. "pinned" and "replay" are
 * EVAL vocabulary in this repo — `evals/pinned-turn.ts` calls `executeTool`
 * for real and `evals/replay-suite-run.ts` re-runs a whole suite against live
 * servers — so a reviewer reading those filenames could reasonably wire them
 * as `TaskSurface: "replay"` and silently hard-disable tasks for a surface
 * that genuinely executes. A doc comment cannot prevent that; a scan can.
 */

import { readFileSync, readdirSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join, relative } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { readTasksPolicy, setTasksPolicy } from "@mcpjam/sdk";

import { resolveToolTaskSeam } from "../task-seam.js";

vi.mock("../logger.js", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

const HERE = dirname(fileURLToPath(import.meta.url));
const SERVER_ROOT = join(HERE, "..", "..");

describe("resolveToolTaskSeam", () => {
  it("returns undefined for every surface when the host says off", () => {
    for (const surface of ["tools", "chat", "agent", "eval"] as const) {
      expect(
        resolveToolTaskSeam({ tasksPolicy: "off", surface })
      ).toBeUndefined();
    }
  });

  it("returns undefined for a malformed policy — fail closed", () => {
    expect(
      resolveToolTaskSeam({ tasksPolicy: "invalid", surface: "chat" })
    ).toBeUndefined();
  });

  it("leaves chat, agent and eval off for a host that never opted in", () => {
    // The zero-change guarantee: adding these surfaces is a non-event for a
    // host that said nothing.
    for (const surface of ["chat", "agent", "eval"] as const) {
      expect(
        resolveToolTaskSeam({ tasksPolicy: "unset", surface })
      ).toBeUndefined();
    }
  });

  it("keeps the Tools tab exposed under unset", () => {
    const seam = resolveToolTaskSeam({ tasksPolicy: "unset", surface: "tools" });
    expect(seam?.mode).toBe("expose");
  });

  it("drives evals to a terminal result but only exposes handles in chat", () => {
    expect(resolveToolTaskSeam({ tasksPolicy: "on", surface: "eval" })?.mode).toBe(
      "await"
    );
    expect(resolveToolTaskSeam({ tasksPolicy: "on", surface: "chat" })?.mode).toBe(
      "expose"
    );
  });

  it("carries the scope into the created-task identity", async () => {
    const seam = resolveToolTaskSeam({
      tasksPolicy: "on",
      surface: "chat",
      scope: "proj_123",
    });
    expect(seam?.scope).toBe("proj_123");
    // A seam with no sink still reports; it must not throw.
    await seam?.onTaskCreated({
      identity: { serverId: "s", wire: "extension", taskId: "t" },
      wire: "extension",
      surface: "chat",
    });
  });
});

describe("host-only resolution", () => {
  it("reads a stored policy off a host config record", () => {
    const host = setTasksPolicy({ name: "h" }, true);
    expect(readTasksPolicy(host)).toBe("on");
    expect(
      resolveToolTaskSeam({ tasksPolicy: readTasksPolicy(host), surface: "chat" })
        ?.mode
    ).toBe("expose");
  });
});

describe('"replay" is only ever used by genuinely inert surfaces', () => {
  /**
   * Files allowed to pass `"replay"` as a TaskSurface. Empty today: no
   * server-side surface renders a saved result through the task seam. The
   * point is that adding one is a deliberate edit here, with the reviewer
   * forced to ask whether the file actually executes anything.
   */
  const ALLOWED: ReadonlyArray<string> = [];

  it("does not appear as a surface argument anywhere on the server", () => {
    const offenders: string[] = [];
    const files = listTsFiles(SERVER_ROOT);

    for (const file of files) {
      const text = readFileSync(file, "utf8");
      // Matches `surface: "replay"` in any spacing, which is the only way the
      // value reaches `resolveToolTaskSeam` or `taskModeForSurface`.
      if (!/surface:\s*["']replay["']/.test(text)) continue;
      const rel = relative(SERVER_ROOT, file);
      // This file states the pattern in order to search for it.
      if (rel === join("utils", "__tests__", "task-seam.test.ts")) continue;
      if (ALLOWED.includes(rel)) continue;
      offenders.push(rel);
    }

    expect(offenders).toEqual([]);
  });

  it("keeps the eval replay/pinned paths on the eval surface", () => {
    // These two execute tools against live servers despite their names. If
    // either ever declares `replay`, tasks are silently off for a surface that
    // is really running an eval.
    for (const file of [
      join(SERVER_ROOT, "services", "evals", "pinned-turn.ts"),
      join(SERVER_ROOT, "services", "evals", "replay-suite-run.ts"),
    ]) {
      const text = readFileSync(file, "utf8");
      expect(/surface:\s*["']replay["']/.test(text)).toBe(false);
    }
  });
});

function listTsFiles(root: string): string[] {
  const out: string[] = [];
  const walk = (dir: string) => {
    for (const entry of readdirSync(dir)) {
      if (entry === "node_modules" || entry === "dist") continue;
      const full = join(dir, entry);
      if (statSync(full).isDirectory()) {
        walk(full);
        continue;
      }
      if (full.endsWith(".ts") || full.endsWith(".tsx")) out.push(full);
    }
  };
  walk(root);
  return out;
}
