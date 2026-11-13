/**
 * The fence around a box preparation's sandbox commands.
 *
 * A command starts only while the preparation's claim is fresh: the backend
 * accepted a claim or renewal sent at most `freshMs` ago. That is read from
 * the clock, not a timer, so neither a stalled process nor a renewal that
 * never answers can start a command the claim might not outlive. The backend
 * keeps a preparation's claim long enough past that confirmation for E2B to
 * end any command started then (`HARNESS_BOX_PREPARATION_TTL_MS`).
 *
 * It also counts the commands that may still be running. A call that returned
 * ended its command; one that threw (an abort, a dropped connection) may have
 * left it running, so it stays counted, and the preparation then leaves its
 * claim to expire instead of releasing it.
 */
import type { Experimental_SandboxSession } from "@ai-sdk/provider-utils";

export class StaleClaimError extends Error {
  override readonly name = "StaleClaimError";
}

export class PreparationFence {
  private confirmedAt: number;
  private running = 0;
  private readonly freshMs: number;
  private readonly signal: AbortSignal;

  /** `sentAt`: when the request for the claim the backend accepted was sent. */
  constructor(args: { sentAt: number; freshMs: number; signal: AbortSignal }) {
    this.confirmedAt = args.sentAt;
    this.freshMs = args.freshMs;
    this.signal = args.signal;
  }

  /** The backend accepted a renewal sent at `sentAt`. */
  confirm(sentAt: number): void {
    this.confirmedAt = Math.max(this.confirmedAt, sentAt);
  }

  /** True when no command this preparation started can still be running. */
  get idle(): boolean {
    return this.running === 0;
  }

  /** Start a command, counted until its call returns. */
  async command<T>(start: () => PromiseLike<T>): Promise<T> {
    this.assertMayStart();
    this.running += 1;
    const result = await start();
    this.running -= 1;
    return result;
  }

  /** The session a bootstrap gets: its writes and commands pass the fence. */
  session(inner: Experimental_SandboxSession): Experimental_SandboxSession {
    const write = async <T>(start: () => PromiseLike<T>): Promise<T> => {
      this.assertMayStart();
      return start();
    };
    return {
      description: inner.description,
      readFile: (options) => inner.readFile(options),
      readBinaryFile: (options) => inner.readBinaryFile(options),
      readTextFile: (options) => inner.readTextFile(options),
      writeFile: (options) => write(() => inner.writeFile(options)),
      writeBinaryFile: (options) => write(() => inner.writeBinaryFile(options)),
      writeTextFile: (options) => write(() => inner.writeTextFile(options)),
      run: (options) => this.command(() => inner.run(options)),
      // A spawned process outlives its call, so it never counts as ended.
      spawn: async (options) => {
        this.assertMayStart();
        this.running += 1;
        return inner.spawn(options);
      },
    };
  }

  private assertMayStart(): void {
    this.signal.throwIfAborted();
    if (Date.now() - this.confirmedAt > this.freshMs) {
      throw new StaleClaimError("The box claim was not renewed in time.");
    }
  }
}
