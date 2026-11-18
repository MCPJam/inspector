/**
 * What the chat session last rendered: whether its status is idle, and whether
 * the turn is paused on the user (a tool approval or an App input round).
 */
export interface IdleGate {
  /** The rendered status is idle (`ready` or `error`). */
  isIdle(): boolean;
  /** Resolves once the rendered status is idle. */
  waitForIdle(): Promise<void>;
  /**
   * Resolves once the status is idle and nothing waits on the user, or once
   * `isCurrent` turns false: a dropped send needs no answer to the old turn.
   */
  waitForTurnEnd(isCurrent: () => boolean): Promise<void>;
}

/**
 * One chat turn at a time for a session. `run` starts its task at once when
 * nothing is queued and the status is idle; otherwise it waits for every
 * earlier turn to settle and for the turn to end, including an approval or App
 * round the user still has to answer. A task whose `isCurrent` turns false
 * stops waiting for the user, so it can drop at once. The task learns whether
 * it waited, and returns its result and, when it started a request, that
 * request's promise: the AI SDK settles it once the reply and its automatic
 * follow-up requests have ended.
 */
export function createChatTurnQueue() {
  let tail: Promise<void> = Promise.resolve();
  let unsettled = 0;
  return function run<T>(
    task: (waited: boolean) => Promise<{ result: T; turn?: Promise<unknown> }>,
    gate: IdleGate,
    isCurrent: () => boolean = () => true,
  ): Promise<T> {
    const previous = tail;
    let release!: () => void;
    tail = new Promise<void>((done) => {
      release = done;
    });
    const startNow = unsettled === 0 && gate.isIdle();
    unsettled += 1;
    const settle = () => {
      unsettled -= 1;
      release();
    };
    return (async () => {
      let turn: Promise<unknown> | undefined;
      try {
        if (!startNow) {
          await previous;
          await gate.waitForTurnEnd(isCurrent);
        }
        const started = await task(!startNow);
        turn = started.turn;
        return started.result;
      } finally {
        if (turn) void turn.then(settle, settle);
        else settle();
      }
    })();
  };
}

/**
 * Follows what React rendered. The SDK settles a request's promise before that
 * render, so a turn started on the promise alone could skip the previous
 * turn's post-stream work.
 */
export function createIdleGate(): IdleGate & {
  set(state: { idle: boolean; awaitingUser: boolean }): void;
  /** Re-checks waiting sends, e.g. after a Stop made one stale. */
  recheck(): void;
} {
  let idle = true;
  let awaitingUser = false;
  // A waiter with `isCurrent` waits for the turn end; one without, for idle.
  let waiters: Array<{ isCurrent?: () => boolean; resolve: () => void }> = [];
  const open = (isCurrent?: () => boolean) =>
    isCurrent ? !isCurrent() || (idle && !awaitingUser) : idle;
  const wait = (isCurrent?: () => boolean) =>
    open(isCurrent)
      ? Promise.resolve()
      : new Promise<void>((resolve) => waiters.push({ isCurrent, resolve }));
  const recheck = () => {
    const ready = waiters.filter((w) => open(w.isCurrent));
    waiters = waiters.filter((w) => !ready.includes(w));
    for (const w of ready) w.resolve();
  };
  return {
    isIdle: () => idle,
    waitForIdle: () => wait(),
    waitForTurnEnd: (isCurrent) => wait(isCurrent),
    recheck,
    set(state) {
      idle = state.idle;
      awaitingUser = state.awaitingUser;
      recheck();
    },
  };
}
