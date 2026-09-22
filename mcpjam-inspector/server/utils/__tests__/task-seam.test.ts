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
import {
  readTasksPolicy,
  runToolTaskSeam,
  setTasksPolicy,
  TASK_SEAM_META_KEY,
} from "@mcpjam/sdk";

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

  it("forwards await tuning — including the abort signal — into the produced options", () => {
    // Finding 5: the eval surfaces pass their run controller's signal here so
    // a cancelled run stops an in-flight `await`-mode task drive. Dropping
    // the field on the way through would silently restore the old behavior
    // (polling until the driver timeout).
    const controller = new AbortController();
    const seam = resolveToolTaskSeam({
      tasksPolicy: "on",
      surface: "eval",
      await: { signal: controller.signal },
    });
    expect(seam?.mode).toBe("await");
    expect(seam?.await?.signal).toBe(controller.signal);
  });

  it("aborting mid-await yields an aborted-outcome tool result in bounded time", async () => {
    // The eval seam driving a task that never terminates: cancelling the run
    // must produce the `aborted` outcome promptly — not wait out the driver's
    // default timeout.
    const controller = new AbortController();
    const seam = resolveToolTaskSeam({
      tasksPolicy: "on",
      surface: "eval",
      await: { signal: controller.signal },
    });
    expect(seam).toBeDefined();

    const now = new Date().toISOString();
    const resultPromise = runToolTaskSeam(
      {
        serverId: "srv-1",
        toolName: "slow_tool",
        wire: "extension",
        callPlain: async () => {
          throw new Error("await mode must use the eligible call");
        },
        callEligible: async () => ({
          resultType: "task",
          taskId: "task-1",
          status: "working",
          createdAt: now,
          lastUpdatedAt: now,
          ttlMs: null,
          // A long floor: without an abort-aware wait the drive would sit in
          // this sleep and blow the bounded-time assertion below.
          pollIntervalMs: 60_000,
        }),
        // Never terminal: the ONLY way out before the driver timeout is the
        // abort signal.
        getTask: async () => ({
          status: "working" as const,
          lastUpdatedAt: new Date().toISOString(),
          ttlMs: null,
        }),
      },
      seam!
    );

    setTimeout(() => controller.abort(new Error("run cancelled")), 20);

    const started = Date.now();
    const result = await resultPromise;
    // Bounded: resolved by the abort, not by the driver's default timeout.
    expect(Date.now() - started).toBeLessThan(5_000);
    expect(result.isError).toBe(true);
    const meta = (result._meta as Record<string, unknown>)[
      TASK_SEAM_META_KEY
    ] as { outcome?: string; taskId?: string };
    expect(meta.outcome).toBe("aborted");
    expect(meta.taskId).toBe("task-1");
    // The prompt-facing text says what happened.
    const text = (result.content?.[0] as { text?: string })?.text ?? "";
    expect(text).toContain("aborted");
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
