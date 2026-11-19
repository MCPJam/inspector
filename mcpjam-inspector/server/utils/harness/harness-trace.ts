import { logger } from "../logger.js";

/**
 * Benchmark tracing for one harness turn's remote work, on only when
 * `MCPJAM_HARNESS_TRACE=1`. Each line carries a wall-clock start (`t=`, the
 * same clock as the turn's marks) and a duration, so a benchmark can lay the
 * sandbox calls of a turn on its timeline. Labels drop anything token-shaped.
 */
export function harnessTraceEnabled(): boolean {
  return process.env.MCPJAM_HARNESS_TRACE === "1";
}

const TOKEN_SHAPED = /[A-Za-z0-9_-]{24,}/g;

export function traceLabel(text: string): string {
  return text.replace(/\s+/g, " ").replace(TOKEN_SHAPED, "~").slice(0, 120);
}

export function traceEvent(
  name: string,
  fields: Record<string, string | number | boolean | undefined> = {},
): void {
  if (!harnessTraceEnabled()) return;
  const extra = Object.entries(fields)
    .filter(([, value]) => value !== undefined)
    .map(([key, value]) => ` ${key}=${value}`)
    .join("");
  logger.info(`[harness][trace] t=${Date.now()} ${name}${extra}`);
}

export async function traceSpan<T>(
  name: string,
  label: string,
  run: () => Promise<T>,
): Promise<T> {
  if (!harnessTraceEnabled()) return run();
  const start = Date.now();
  try {
    const value = await run();
    logger.info(
      `[harness][trace] t=${start} ${name} durMs=${Date.now() - start} ok ${traceLabel(label)}`,
    );
    return value;
  } catch (error) {
    const reason = error instanceof Error ? error.name : "unknown";
    logger.info(
      `[harness][trace] t=${start} ${name} durMs=${Date.now() - start} err=${reason} ${traceLabel(label)}`,
    );
    throw error;
  }
}

/** Phase marks for one request; `end` writes them as one line. */
export interface TraceRecord {
  mark(phase: string): void;
  set(field: string, value: string | number | undefined): void;
  end(name: string, fields?: Record<string, string | number | undefined>): void;
}

export function startTraceRecord(): TraceRecord | undefined {
  if (!harnessTraceEnabled()) return undefined;
  const start = Date.now();
  let previous = start;
  const phases: string[] = [];
  const extra: Record<string, string | number | undefined> = {};
  return {
    mark(phase) {
      const now = Date.now();
      phases.push(`${phase}=${now - previous}`);
      previous = now;
    },
    set(field, value) {
      extra[field] = value;
    },
    end(name, fields = {}) {
      const all = { ...extra, ...fields };
      const text = Object.entries(all)
        .filter(([, value]) => value !== undefined)
        .map(([key, value]) => ` ${key}=${traceLabel(String(value))}`)
        .join("");
      logger.info(
        `[harness][trace] t=${start} ${name} durMs=${Date.now() - start}${text} phases=${phases.join(",")}`,
      );
    },
  };
}

/** Wrap a sandbox session's remote methods with `traceSpan`, in place. */
export function traceSandboxSession<S extends object>(session: S): S {
  if (!harnessTraceEnabled()) return session;
  const labelOf: Record<string, (arg: Record<string, unknown>) => string> = {
    readTextFile: (arg) => String(arg.path),
    readBinaryFile: (arg) => String(arg.path),
    readFile: (arg) => String(arg.path),
    writeTextFile: (arg) => String(arg.path),
    writeBinaryFile: (arg) => String(arg.path),
    writeFile: (arg) => String(arg.path),
    run: (arg) => String(arg.command),
    spawn: (arg) => String(arg.command),
  };
  for (const [method, label] of Object.entries(labelOf)) {
    const original: unknown = Reflect.get(session, method);
    if (typeof original !== "function") continue;
    Reflect.set(session, method, (arg: Record<string, unknown>) =>
      traceSpan(`box.${method}`, label(arg ?? {}), () =>
        Promise.resolve(Reflect.apply(original, session, [arg])),
      ),
    );
  }
  return session;
}
