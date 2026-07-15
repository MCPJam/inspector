/**
 * Create a PTY, optionally in a starting working directory, with a fallback.
 *
 * The Playground Shell can ask to open in the harness session workdir
 * (`/home/user/claude-code-<id>`). That dir normally exists, but it could be
 * stale/gone (computer recycled, session cleaned up). A missing `cwd` must never
 * brick the terminal — so if `pty.create` rejects *with* a cwd, we retry once
 * *without* it (lands in home). Extracted from the WS route so the retry has a
 * unit test (the route itself isn't unit-testable — it holds a live socket).
 */

/** The subset of E2B's `pty.create` options we set. */
export interface PtyBaseOpts {
  cols: number;
  rows: number;
  timeoutMs: number;
  onData: (data: Uint8Array) => void;
}

/** Minimal shape of the E2B sandbox we depend on (keeps this unit-testable). */
export interface PtyCreator<Handle> {
  pty: {
    create: (opts: PtyBaseOpts & { cwd?: string }) => Promise<Handle>;
  };
}

export async function createPtyWithCwd<Handle>(
  sandbox: PtyCreator<Handle>,
  baseOpts: PtyBaseOpts,
  cwd: string | undefined,
): Promise<Handle> {
  if (!cwd) {
    return sandbox.pty.create(baseOpts);
  }
  try {
    return await sandbox.pty.create({ ...baseOpts, cwd });
  } catch {
    // Stale/invalid workdir — fall back to home rather than failing the open.
    return sandbox.pty.create(baseOpts);
  }
}

/** Accept only an absolute, length-bounded path as a cwd; reject anything else. */
export function sanitizeTerminalCwd(raw: string | undefined): string | undefined {
  if (!raw || !raw.startsWith("/") || raw.length > 1024) return undefined;
  return raw;
}
