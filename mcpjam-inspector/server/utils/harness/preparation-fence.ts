/**
 * The fence around a box preparation's work in the box.
 *
 * A write or a command starts only if it will have ended before the claim can
 * lapse, as this process can prove it: the claim holds at least the remaining
 * TTL the backend answered, counted from when the request it answered was
 * sent, on the monotonic clock. A command runs in the box under coreutils
 * `timeout -s KILL`, which kills its whole process group at `commandBoundMs`
 * whatever E2B does with a timed-out command, so nothing starts unless now +
 * `commandBoundMs` + `marginMs` falls short of that expiry; the margin covers
 * the request's way to the box. Spawning is refused: a spawned process runs
 * with no timeout.
 *
 * It also knows what may still be running. A call that returned has ended. A
 * command whose call threw (an abort, a dropped connection) is over once its
 * bound has passed. A write whose call threw has no bound in the box, so only
 * the claim's TTL is safe then.
 */
import type { Experimental_SandboxSession } from "@ai-sdk/provider-utils";
import { shellQuote } from "./shell-quote.js";

export class StaleClaimError extends Error {
  override readonly name = "StaleClaimError";
}

type Started = { kind: "command" | "write"; at: number };

export class PreparationFence {
  private heldUntil = 0;
  private quietAt = 0;
  private unbounded = false;
  private readonly inFlight = new Set<Started>();
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
   * When the claim can be handed back, on the monotonic clock: by now when
   * nothing can be running, once every interrupted command's bound has
   * passed, or never (undefined) while a write may still land.
   */
  releasableAt(): number | undefined {
    if (this.unbounded) return undefined;
    let at = this.quietAt;
    for (const started of this.inFlight) {
      if (started.kind === "write") return undefined;
      at = Math.max(at, this.boundPassedAt(started.at));
    }
    return at;
  }

  /** A command too short to need the bound, such as a version check. */
  probe(inner: Experimental_SandboxSession, command: string) {
    return this.start("command", () => inner.run({ command }));
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
        this.start("write", () => inner.writeFile(options)),
      writeBinaryFile: (options) =>
        this.start("write", () => inner.writeBinaryFile(options)),
      writeTextFile: (options) =>
        this.start("write", () => inner.writeTextFile(options)),
      run: (options) =>
        this.start("command", () =>
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

  private boundPassedAt(startedAt: number): number {
    return startedAt + this.commandBoundMs + this.marginMs;
  }

  private async start<T>(
    kind: Started["kind"],
    call: () => PromiseLike<T>,
  ): Promise<T> {
    this.signal.throwIfAborted();
    const at = performance.now();
    if (this.boundPassedAt(at) >= this.heldUntil) {
      throw new StaleClaimError("The box claim may lapse before this ends.");
    }
    const started: Started = { kind, at };
    this.inFlight.add(started);
    try {
      const result = await call();
      this.inFlight.delete(started);
      return result;
    } catch (error) {
      this.inFlight.delete(started);
      if (kind === "write") this.unbounded = true;
      else this.quietAt = Math.max(this.quietAt, this.boundPassedAt(at));
      throw error;
    }
  }
}
