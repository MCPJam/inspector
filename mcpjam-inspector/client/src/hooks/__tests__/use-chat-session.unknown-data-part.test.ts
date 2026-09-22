/**
 * Old bundles must ignore parts they don't understand.
 *
 * A hosted server can emit a data part that a cached browser bundle has never
 * heard of. The guarantee that this is harmless is structural: the data-part
 * dispatch is an `if / else if` chain with NO terminal `else`, so an unmatched
 * part falls through to a bare `return`.
 *
 * That is a property of the source, not of any behavior a rendering test can
 * observe — a future `else { ... }` would compile, pass every existing test,
 * and turn every unknown part into a visible error for users on old bundles.
 * So it is asserted against the source text, which is the only thing that can
 * actually catch it.
 */

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  HOSTED_TASKS_VERSION,
  isTaskCreatedDataPart,
} from "@/shared/hosted-task-created";

const HOOK_SOURCE = readFileSync(
  join(dirname(fileURLToPath(import.meta.url)), "..", "use-chat-session.ts"),
  "utf8",
);

describe("unknown data parts degrade silently", () => {
  it("has no terminal else on the data-part dispatch chain", () => {
    // The shape being protected:
    //
    //   } else if (isTaskCreatedDataPart(part)) {
    //     ...
    //   }
    //   return;
    //
    // An `} else {` immediately before that `return;` is the regression.
    // Scoped to the dispatch chain, and tolerant of nested braces. An earlier
    // version used `[^}]*` for the else body, which cannot cross a single
    // nested brace — so the most likely real regression,
    // `} else { setError({ message: ... }); }`, slipped past unmatched while
    // the suite reported health. It was also unanchored, so an unrelated
    // else/return pair elsewhere in the hook would have failed it for no
    // reason.
    const start = HOOK_SOURCE.indexOf("isTaskCreatedDataPart(part)");
    expect(start).toBeGreaterThan(-1);
    const chainTail = HOOK_SOURCE.slice(start, start + 2000);
    expect(/}\s*else\s*{[\s\S]*?}\s*\n\s*return;/.test(chainTail)).toBe(false);
  });

  it("still routes the parts it does know", () => {
    // Guards against the opposite failure: deleting the branch entirely would
    // also satisfy the assertion above.
    expect(HOOK_SOURCE).toContain("isTaskCreatedDataPart(part)");
    expect(HOOK_SOURCE).toContain("trackTask({");
  });

  it("does not navigate away when a task is created", () => {
    // A chat turn must not yank the user out of the conversation to a task
    // list. The branch tracks and stops.
    const branch = HOOK_SOURCE.slice(
      HOOK_SOURCE.indexOf("isTaskCreatedDataPart(part)"),
    ).slice(0, 1200);
    expect(branch).not.toContain("navigateApp");
  });

  it("sends the tasks handshake alongside the existing ones", () => {
    expect(HOOK_SOURCE).toContain("hostedTasksVersion: HOSTED_TASKS_VERSION");
    expect(HOSTED_TASKS_VERSION).toBe(1);
  });

  it("rejects a part shaped like a task-created part but versioned wrong", () => {
    expect(isTaskCreatedDataPart({ type: "data-task-created", data: {} })).toBe(
      false,
    );
  });
});
