import { AsyncLocalStorage } from "node:async_hooks";

/** Per-request activation step timings (backend reads, MCP connect and
 * initialize, tools/list, resources/read, durable writes, the tool call).
 * Data only: a span never changes control flow, authority or results. */
export class PluginRequestTimings {
  private readonly spans = new Map<
    string,
    { count: number; totalMs: number; maxMs: number }
  >();
  readonly startedAt = performance.now();

  record(name: string, ms: number) {
    const span = this.spans.get(name) ?? { count: 0, totalMs: 0, maxMs: 0 };
    span.count++;
    span.totalMs += ms;
    span.maxMs = Math.max(span.maxMs, ms);
    this.spans.set(name, span);
  }

  /** Aggregated spans, rounded to 0.1 ms, in first-seen order. */
  summary() {
    return Object.fromEntries(
      [...this.spans].map(([name, span]) => [
        name,
        {
          count: span.count,
          totalMs: Math.round(span.totalMs * 10) / 10,
          maxMs: Math.round(span.maxMs * 10) / 10,
        },
      ]),
    );
  }

  /** RFC Server-Timing value; visible in the browser's network inspector. */
  serverTiming() {
    const parts = [...this.spans].map(
      ([name, span]) =>
        `${name};dur=${span.totalMs.toFixed(1)};desc="x${span.count}"`,
    );
    parts.push(
      `total;dur=${(performance.now() - this.startedAt).toFixed(1)}`,
    );
    return parts.join(", ");
  }
}

const current = new AsyncLocalStorage<PluginRequestTimings>();

/** Run one HTTP request's work with a fresh timing recorder. */
export function withPluginRequestTimings<T>(
  run: (timings: PluginRequestTimings) => Promise<T>,
): Promise<T> {
  const timings = new PluginRequestTimings();
  return current.run(timings, () => run(timings));
}

/** Time one step when a request recorder is active; otherwise just run it. */
export async function timedPluginStep<T>(
  name: string,
  step: () => Promise<T>,
): Promise<T> {
  const timings = current.getStore();
  if (!timings) return step();
  const started = performance.now();
  try {
    return await step();
  } finally {
    timings.record(name, performance.now() - started);
  }
}

export function currentPluginRequestTimings() {
  return current.getStore();
}
