/**
 * What the chat session last rendered: whether its status is idle, and whether
 * the turn is paused on the user (a tool approval or an App input round).
 */
export interface IdleGate {
  /** The rendered status is idle (`ready` or `error`). */
  isIdle(): boolean;
  /** Resolves once the rendered status is idle. */
  waitForIdle(): Promise<void>;
  /** Resolves once the status is idle and nothing waits on the user. */
  waitForTurnEnd(): Promise<void>;
}

/**
 * One chat turn at a time for a session. `run` starts its task at once when
 * nothing is queued and the status is idle; otherwise it waits for every
 * earlier turn to settle and for the turn to end, including an approval or App
 * round the user still has to answer. The task returns its result and, when it
 * started a request, that request's promise: the AI SDK settles it once the
 * reply and its automatic follow-up requests have ended.
 */
export function createChatTurnQueue() {
  let tail: Promise<void> = Promise.resolve();
  let unsettled = 0;
  return function run<T>(
    task: () => Promise<{ result: T; turn?: Promise<unknown> }>,
    gate: IdleGate,
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
          await gate.waitForTurnEnd();
        }
        const started = await task();
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
} {
  let idle = true;
  let awaitingUser = false;
  let waiters: Array<{ needsTurnEnd: boolean; resolve: () => void }> = [];
  const open = (needsTurnEnd: boolean) =>
    idle && (!needsTurnEnd || !awaitingUser);
  const wait = (needsTurnEnd: boolean) =>
    open(needsTurnEnd)
      ? Promise.resolve()
      : new Promise<void>((resolve) => waiters.push({ needsTurnEnd, resolve }));
  return {
    isIdle: () => idle,
    waitForIdle: () => wait(false),
    waitForTurnEnd: () => wait(true),
    set(state) {
      idle = state.idle;
      awaitingUser = state.awaitingUser;
      const ready = waiters.filter((w) => open(w.needsTurnEnd));
      waiters = waiters.filter((w) => !open(w.needsTurnEnd));
      for (const w of ready) w.resolve();
    },
  };
}
