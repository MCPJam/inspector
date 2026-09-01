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
  /**
   * Extra environment for the shell — how a MATERIALIZED project secret reaches
   * a HUMAN typing `stripe customers list` into the terminal, not just an agent
   * calling a tool.
   *
   * Carried through the retry-without-cwd fallback below, which is the whole
   * reason it lives on the BASE opts rather than being passed alongside them: a
   * stale workdir must cost the terminal its directory, never its environment.
   *
   * NOT WIRED YET, and the reason is a real constraint rather than an omission.
   * The only PTY routes today are the persistent-computer terminals, and a
   * persistent computer has no stable binding to any one Project Environment —
   * it outlives runs, is reused across them, and can be attached to several — so
   * there is no honest answer to "which secrets does this box hold". The backend
   * grant resolver refuses to invent one (`projectSecretsEgress.ts`), and this
   * side must not invent one either. When a session-sandbox terminal exists, its
   * box DOES have an environment, and wiring it is one field at that call site.
   */
  envs?: Record<string, string>;
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
export function sanitizeTerminalCwd(
  raw: string | undefined,
): string | undefined {
  if (!raw || !raw.startsWith("/") || raw.length > 1024) return undefined;
  return raw;
}
