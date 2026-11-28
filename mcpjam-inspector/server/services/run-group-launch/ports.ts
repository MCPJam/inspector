/**
 * The services the launch engine uses from the rest of the server, replaced
 * in tests: the backend, time, and the shutdown drain.
 */
import { serverDrain } from "../lifecycle/drain.js";
import {
  convexRunGroupLaunchBackend,
  type RunGroupLaunchBackend,
} from "./backend.js";

export interface RunGroupLaunchPorts<P> {
  backend: (bearer: string) => RunGroupLaunchBackend<P>;
  sleep: (ms: number) => Promise<void>;
  /** Calls `tick` every `ms` until the returned function is called. */
  every: (ms: number, tick: () => void) => () => void;
  /** Keeps a shutdown waiting for the background launch. `work` never rejects. */
  holdDrain: (work: Promise<void>) => void;
  now: () => number;
}

export function defaultRunGroupLaunchPorts<P>(): RunGroupLaunchPorts<P> {
  return {
    backend: convexRunGroupLaunchBackend,
    sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
    every: (ms, tick) => {
      const timer = setInterval(tick, ms);
      // The drain holds the launch; its heartbeat is no reason to keep a
      // process alive on its own.
      timer.unref();
      return () => clearInterval(timer);
    },
    holdDrain: (work) => {
      void serverDrain.track("run_group_launch", work);
    },
    now: () => Date.now(),
  };
}
