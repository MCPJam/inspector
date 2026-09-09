/**
 * What the agent does while a person is holding the browser.
 *
 * Until now: nothing useful. A command arrived, the daemon refused it with
 * `lease_blocked`, and the tool answered "a person has taken control — wait
 * for them to hand it back, then re-observe". Which is correct advice and a
 * terrible mechanism, because there is no way for a model to wait. It has one
 * move — call a tool — so "wait" becomes a retry, and a person signing in for
 * ninety seconds watches the transcript fill with identical refusals while the
 * run burns tokens on them. Worse, some of those refusals are the last thing
 * in a turn, so the run ends having achieved nothing at the exact moment the
 * person finished clearing the obstacle it was stuck on.
 *
 * So the waiting moves HERE, into the tool call itself. The call parks — it is
 * a promise, and a promise can wait — and comes back when the browser does.
 *
 * WHAT COMES BACK IS NOT THE ORIGINAL COMMAND'S RESULT. The command was never
 * run, and running it now would be replaying a click decided against a page
 * that a person has since logged into, navigated away from, or dismissed a
 * dialog on. That is the same stale-targeting failure `stale_observation`
 * exists to catch, arriving through a door the guard does not watch. Instead
 * the call answers with a fresh observation and says plainly that control came
 * back and the plan needs re-deciding. The model gets to reconsider, which is
 * the only honest thing to do with a page somebody else has been using.
 *
 * Everything here is injected, so the waiting, the polling and the clock are
 * all testable without a browser or a real second of real time.
 */

/** Who is holding it, when anybody is. */
export interface HandoffHolder {
  kind: "human" | "script";
}

export type HandoffLeaseRead =
  | { held: false }
  | { held: true; holder: HandoffHolder }
  /**
   * We could not tell.
   *
   * Its own case rather than folded into `held: true`, because they lead
   * different places: a lease we know is held is worth waiting on, and a lease
   * we cannot read is a browser we may have lost entirely — waiting on that is
   * waiting for a message that will never come.
   */
  | { held: "unknown" };

export type HandoffOutcome =
  /** The person handed back. Re-observe, then let the model re-decide. */
  | { status: "released"; waitedMs: number }
  /** Still held when the budget ran out. The model is told to try later. */
  | { status: "still_held"; holder: HandoffHolder; waitedMs: number }
  /** The turn was stopped while waiting. */
  | { status: "cancelled" }
  /** The lease could not be read. @see HandoffLeaseRead */
  | { status: "unknown" };

export interface HandoffWaitDeps {
  readLease: (signal?: AbortSignal) => Promise<HandoffLeaseRead>;
  /** Sleep, abortably. Injected so a test does not spend real seconds. */
  sleep: (ms: number, signal?: AbortSignal) => Promise<void>;
  now?: () => number;
  /**
   * Told when the wait starts and when it ends, so a surface can show it.
   *
   * This is the "visible waiting state" half of the feature: without it the
   * only difference between "the agent is parked behind a person" and "the
   * agent has hung" is that one of them eventually finishes.
   */
  onWaiting?: (state: { waiting: boolean; holder?: HandoffHolder }) => void;
  pollMs?: number;
  /**
   * How long to park before giving up and telling the model to come back.
   *
   * Generous, because the thing being waited on is a person doing a two-factor
   * dance with their phone, and a budget that expires under them turns a
   * successful handoff into a failed run. Bounded anyway, because a tool call
   * that never returns is a turn that can never end — including one whose
   * person closed the tab and went home.
   */
  maxWaitMs?: number;
}

const DEFAULT_POLL_MS = 1_000;
const DEFAULT_MAX_WAIT_MS = 5 * 60 * 1_000;

/**
 * Park until the browser comes back, or until it is clear it will not.
 *
 * Polled rather than pushed, deliberately. There is a socket that already
 * knows — the frame stream carries the lease state — but it belongs to a PANE,
 * and this runs in a tool call on a server that may have no pane attached at
 * all: an eval, a swarm, an outside agent through the door. A poll costs one
 * cheap request a second against a daemon that is doing nothing anyway,
 * because the browser it is holding is being used by hand.
 */
export async function waitForHandoff(
  deps: HandoffWaitDeps,
  signal?: AbortSignal,
): Promise<HandoffOutcome> {
  const now = deps.now ?? (() => Date.now());
  const pollMs = deps.pollMs ?? DEFAULT_POLL_MS;
  const maxWaitMs = deps.maxWaitMs ?? DEFAULT_MAX_WAIT_MS;
  const startedAt = now();
  let announced = false;
  let lastHolder: HandoffHolder = { kind: "human" };

  try {
    for (;;) {
      if (signal?.aborted) return { status: "cancelled" };
      let read: HandoffLeaseRead;
      try {
        read = await deps.readLease(signal);
      } catch {
        // A read that THREW is not the same as a lease we could not parse: the
        // browser may simply be unreachable for a moment. Treated as unknown,
        // which stops the wait — a caller that keeps polling an unreachable
        // daemon for five minutes is a caller nobody can stop.
        return { status: "unknown" };
      }
      if (read.held === false) {
        return { status: "released", waitedMs: now() - startedAt };
      }
      if (read.held === "unknown") return { status: "unknown" };
      lastHolder = read.holder;
      if (!announced) {
        announced = true;
        deps.onWaiting?.({ waiting: true, holder: read.holder });
      }
      if (now() - startedAt >= maxWaitMs) {
        return {
          status: "still_held",
          holder: read.holder,
          waitedMs: now() - startedAt,
        };
      }
      try {
        await deps.sleep(pollMs, signal);
      } catch {
        // An aborted sleep is a stopped turn, not a failure.
        return { status: "cancelled" };
      }
    }
  } finally {
    // ALWAYS, including on the cancelled and unknown paths. A surface left
    // showing "waiting for you to hand the browser back" after the turn was
    // stopped is a spinner nothing will ever clear.
    if (announced) deps.onWaiting?.({ waiting: false, holder: lastHolder });
  }
}

/**
 * What the model is told when control comes back.
 *
 * NAMED as a resumption rather than as the original command's result, and
 * insistent about what did not happen. A model that reads "ok" after a park
 * assumes its click landed; a model that reads "the page may have changed"
 * without being told its action never ran assumes it ran and then something
 * moved. Both lead to the same wrong next step, which is to carry on from a
 * state that does not exist.
 */
export function resumedMessage(waitedMs: number): string {
  const seconds = Math.max(1, Math.round(waitedMs / 1000));
  return (
    `browser_resumed: a person had control of this browser for about ` +
    `${seconds}s and has handed it back. YOUR ACTION WAS NOT PERFORMED — it ` +
    `was never sent. They may have signed in, dismissed something, or ` +
    `navigated elsewhere, so any element you had targeted may be gone. The ` +
    `observation below is the page as it is NOW; decide your next action from ` +
    `it rather than repeating the one that was blocked.`
  );
}

/** What the model is told when the wait ran out with the browser still held. */
export function stillHeldMessage(holder: HandoffHolder): string {
  return holder.kind === "script"
    ? "browser_in_use: a script attached to this browser still has control. " +
        "Nothing was run and nothing was observed. This is not something you " +
        "can wait out — report it rather than retrying."
    : "browser_in_use: a person still has control of this browser after a " +
        "long wait. Nothing was run and nothing was observed. Do something " +
        "else, or tell the user you are blocked on the browser — retrying " +
        "will not free it.";
}


/**
 * The whole handoff, from the refusal to the answer the model reads.
 *
 * Wraps `waitForHandoff` with the two things a caller would otherwise have to
 * repeat: reading the lease off a `SessionClient`, and taking the fresh
 * observation that makes a resumption usable. Written against the narrowest
 * possible shapes so a unit test needs neither a browser nor a session.
 *
 * THE OBSERVATION IS TAKEN AFTER THE RELEASE AND NOT BEFORE. Obvious once
 * stated, and the tempting alternative — keep the observation the turn already
 * had and just say "this may be stale" — is exactly the failure this exists to
 * prevent: the model would re-decide from a picture taken before somebody
 * signed in.
 */
export interface ParkForHandoffArgs<Token> {
  /**
   * Anything that can read the lease.
   *
   * Structural rather than `SessionClient`, so this module imports nothing
   * from the browser stack and a test can pass an object literal. `lease` is
   * optional on `SessionClient` itself, and an engine without one is answered
   * exactly as it was before this feature existed.
   */
  client: {
    lease?: () => Promise<{
      state: string;
      holder?: string;
      holderKind?: string;
    }>;
  };
  /** Take a fresh look once control is back. */
  observe: (signal?: AbortSignal) => Promise<{
    ok: boolean;
    output?: unknown;
    error?: string;
    stateToken?: Token;
  }>;
  signal?: AbortSignal;
  onWaiting?: HandoffWaitDeps["onWaiting"];
  /** Test seams. Real callers take the defaults. */
  sleep?: HandoffWaitDeps["sleep"];
  now?: () => number;
  pollMs?: number;
  maxWaitMs?: number;
}

/**
 * Always `ok: false`, and that is the point.
 *
 * Nothing was performed. A success would tell the model its action landed, and
 * the error channel is what a model reads as "this did not do what you asked"
 * — which is precisely true. The fresh observation rides along in `output` so
 * the re-decision costs no extra round trip.
 */
export interface ParkedOutcome<Token> {
  ok: false;
  error: string;
  output?: unknown;
  stateToken?: Token;
}

export async function parkForHandoff<Token>(
  args: ParkForHandoffArgs<Token>,
): Promise<ParkedOutcome<Token>> {
  const readLease = args.client.lease;
  if (!readLease) {
    // An engine with no lease endpoint cannot be waited on. Answered exactly
    // as it was before this feature existed, rather than parked forever.
    return { ok: false, error: stillHeldMessage({ kind: "human" }) };
  }
  const outcome = await waitForHandoff(
    {
      readLease: async () => {
        const lease = await readLease();
        if (lease.state === "free") return { held: false };
        return {
          held: true,
          holder: { kind: lease.holderKind === "script" ? "script" : "human" },
        };
      },
      sleep: args.sleep ?? defaultSleep,
      ...(args.now ? { now: args.now } : {}),
      ...(args.onWaiting ? { onWaiting: args.onWaiting } : {}),
      ...(args.pollMs !== undefined ? { pollMs: args.pollMs } : {}),
      ...(args.maxWaitMs !== undefined ? { maxWaitMs: args.maxWaitMs } : {}),
    },
    args.signal,
  );

  switch (outcome.status) {
    case "released": {
      const fresh = await args.observe(args.signal);
      if (!fresh.ok) {
        // Control came back and the page could not be read. Still reported as
        // a resumption rather than as the original command's failure, because
        // the important fact — the action never ran — is the same either way.
        return {
          ok: false,
          error:
            `${resumedMessage(outcome.waitedMs)} The page could not be read ` +
            `just now (${fresh.error ?? "no detail"}); observe again before acting.`,
        };
      }
      return {
        ok: false,
        error: resumedMessage(outcome.waitedMs),
        output: fresh.output,
        ...(fresh.stateToken ? { stateToken: fresh.stateToken } : {}),
      };
    }
    case "still_held":
      return { ok: false, error: stillHeldMessage(outcome.holder) };
    case "cancelled":
      return {
        ok: false,
        error:
          "browser_cancelled: this call was stopped while waiting for a " +
          "person to hand the browser back. Nothing was run.",
      };
    default:
      return {
        ok: false,
        error:
          "browser_unavailable: a person had taken control and this browser " +
          "then stopped answering. Nothing was run and nothing was observed.",
      };
  }
}

/** Abortable sleep. Rejects on abort, which `waitForHandoff` reads as stopped. */
function defaultSleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    if (signal?.aborted) {
      reject(new Error("aborted"));
      return;
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      reject(new Error("aborted"));
    };
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}
