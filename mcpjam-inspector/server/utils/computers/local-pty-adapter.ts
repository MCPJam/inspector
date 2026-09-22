/**
 * node-pty → `PtyCreator` adapter, so the local terminal reuses the cloud
 * terminal's `createPtyWithCwd` (and its "stale cwd must not brick the open"
 * retry) instead of growing a second spawn path.
 *
 * This is NOT a pass-through — every difference below is load-bearing:
 *
 *  - E2B's `pty.create` REJECTS on a bad cwd, which is what triggers the retry
 *    in `createPtyWithCwd`. `node-pty.spawn` is synchronous and does not: a
 *    missing cwd gives you a shell that dies milliseconds later, so the retry
 *    never fires and the user gets an empty terminal that immediately exits.
 *    We pre-check `existsSync(cwd)` and throw, restoring the rejection the
 *    retry is written against.
 *  - `spawn` throws SYNCHRONOUSLY (bad shell path, fork failure). `create` is
 *    declared async so those become rejections, which is what callers expect.
 *  - node-pty streams `string`; the WS wire protocol and `PtyBaseOpts.onData`
 *    are bytes. We encode to UTF-8.
 *  - `timeoutMs` is an E2B sandbox-side PTY TTL. There is no such concept for a
 *    local child process (its lifetime is the socket's), so it is ignored.
 */
import { existsSync } from "node:fs";
import type { PtyCreator } from "./create-pty.js";
import type { NodePtyModule, NodePtyProcess } from "./local-pty.js";

export function createLocalPtyCreator(args: {
  ptyModule: NodePtyModule;
  /** Absolute path to the shell to spawn ($SHELL → bash → sh). */
  shell: string;
  /** The local-command env ALLOWLIST (see local-machine.ts) — never process.env. */
  env: NodeJS.ProcessEnv;
}): PtyCreator<NodePtyProcess> {
  const encoder = new TextEncoder();
  return {
    pty: {
      create: async (opts) => {
        if (opts.cwd !== undefined && !existsSync(opts.cwd)) {
          // Restores the rejection `createPtyWithCwd`'s fallback is written
          // against; without it a stale workspace dir yields an instantly-dead
          // shell instead of a retry into home.
          throw new Error(`Terminal working directory does not exist.`);
        }
        const proc = args.ptyModule.spawn(args.shell, [], {
          name: "xterm-color",
          cols: opts.cols,
          rows: opts.rows,
          ...(opts.cwd !== undefined ? { cwd: opts.cwd } : {}),
          env: args.env,
        });
        proc.onData((chunk) => opts.onData(encoder.encode(chunk)));
        return proc;
      },
    },
  };
}
