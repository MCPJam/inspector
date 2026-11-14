/** Whether the chat status React last rendered is idle, and a wait for it. */
export interface IdleGate {
  isIdle(): boolean;
  wait(): Promise<void>;
}

/**
 * One chat turn at a time for a session. `run` starts its task once every
 * earlier turn has settled and the gate is idle; with nothing running it starts
 * at once, in the caller's tick. The task returns its result and, when it
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
          await gate.wait();
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
 * Follows the chat status React rendered. The SDK settles a request's promise
 * before that render, so a turn that started on the promise alone could skip
 * the previous turn's post-stream work.
 */
export function createIdleGate(): IdleGate & { set(idle: boolean): void } {
  let idle = true;
  let waiters: Array<() => void> = [];
  return {
    isIdle: () => idle,
    set(next: boolean) {
      idle = next;
      if (!idle) return;
      const ready = waiters;
      waiters = [];
      for (const resolve of ready) resolve();
    },
    wait(): Promise<void> {
      return idle
        ? Promise.resolve()
        : new Promise((resolve) => waiters.push(resolve));
    },
  };
}
