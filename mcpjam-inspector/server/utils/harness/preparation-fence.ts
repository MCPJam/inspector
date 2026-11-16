/**
 * The fence around a box preparation's work in the box.
 *
 * A write or a command starts only if it will have ended before the claim can
 * lapse, as this process can prove it: the claim holds at least the remaining
 * TTL the backend answered, counted from when the request it answered was
 * sent, on the monotonic clock. A command runs in the box under coreutils
 * `timeout -s KILL`, which kills its whole process group at `commandBoundMs`
 * whatever E2B does with a timed-out command, and a write's request is cut off
 * at the same bound, so nothing starts unless now + `commandBoundMs` +
 * `marginMs` falls short of that expiry; the margin covers the request's way
 * to the box. Spawning is refused: a spawned process runs with no timeout.
 *
 * It also knows what may still be running. A call that returned has ended:
 * the box answered it. A call that threw, or has not settled, may still reach
 * the box late, past any bound counted here and past the claim's own expiry.
 * The preparation then releases its claim `uncertain`, and the backend
 * retires the box, so no Send runs on it.
 */
import type { Experimental_SandboxSession } from "@ai-sdk/provider-utils";
import type { BoxReleaseOutcome } from "./harness-box-reservation.js";
import { shellQuote } from "./shell-quote.js";

export class StaleClaimError extends Error {
  override readonly name = "StaleClaimError";
}

export class PreparationFence {
  private heldUntil = 0;
  private inFlight = 0;
  private interrupted = false;
  private readonly commandBoundMs: number;
  private readonly marginMs: number;
  private readonly signal: AbortSignal;

  constructor(args: {
    commandBoundMs: number;
    marginMs: number;
    signal: AbortSignal;
  }) {
    this.commandBoundMs = args.commandBoundMs;
    this.marginMs = args.marginMs;
    this.signal = args.signal;
  }

  /** The backend answered a claim or renewal sent at `sentAt` with `ttlMs` left. */
  confirm(sentAt: number, ttlMs: number | undefined): void {
    if (ttlMs !== undefined) {
      this.heldUntil = Math.max(this.heldUntil, sentAt + ttlMs);
    }
  }

  /**
   * How the preparation releases its claim: `clean` once every call it
   * covered returned, or none started; `uncertain` while one may still reach
   * the box.
   */
  get outcome(): BoxReleaseOutcome {
    return this.inFlight === 0 && !this.interrupted ? "clean" : "uncertain";
  }

  /** A command too short to need the bound, such as a version check. */
  probe(inner: Experimental_SandboxSession, command: string) {
    return this.start(() => inner.run({ command }));
  }

  /** The session a bootstrap gets: its writes and commands pass the fence. */
  session(inner: Experimental_SandboxSession): Experimental_SandboxSession {
    const seconds = Math.ceil(this.commandBoundMs / 1000);
    return {
      description: inner.description,
      readFile: (options) => inner.readFile(options),
      readBinaryFile: (options) => inner.readBinaryFile(options),
      readTextFile: (options) => inner.readTextFile(options),
      writeFile: (options) =>
        this.start((bound) => inner.writeFile(withBound(options, bound))),
      writeBinaryFile: (options) =>
        this.start((bound) => inner.writeBinaryFile(withBound(options, bound))),
      writeTextFile: (options) =>
        this.start((bound) => inner.writeTextFile(withBound(options, bound))),
      run: (options) =>
        this.start(() =>
          inner.run({
            ...options,
            command: `timeout -s KILL ${seconds} bash -c ${shellQuote(options.command)}`,
          }),
        ),
      spawn: async () => {
        throw new Error("A box preparation starts no long-lived process.");
      },
    };
  }

  /** `call` gets a signal that aborts at the bound, for a write's request. */
  private async start<T>(
    call: (bound: AbortSignal) => PromiseLike<T>,
  ): Promise<T> {
    this.signal.throwIfAborted();
    if (
      performance.now() + this.commandBoundMs + this.marginMs >=
      this.heldUntil
    ) {
      throw new StaleClaimError("The box claim may lapse before this ends.");
    }
    const bound = new AbortController();
    const timer = setTimeout(
      () => bound.abort(new Error("The call ran past its bound.")),
      this.commandBoundMs,
    );
    this.inFlight += 1;
    try {
      return await call(bound.signal);
    } catch (error) {
      this.interrupted = true;
      throw error;
    } finally {
      this.inFlight -= 1;
      clearTimeout(timer);
    }
  }
}

/** The call's own cancellation, and the fence's bound. */
function withBound<O extends { abortSignal?: AbortSignal }>(
  options: O,
  bound: AbortSignal,
): O {
  return {
    ...options,
    abortSignal: options.abortSignal
      ? AbortSignal.any([options.abortSignal, bound])
      : bound,
  };
}
