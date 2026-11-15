/**
 * Remote work a turn starts before it needs the result, so independent calls
 * overlap instead of queueing.
 *
 * The started promise never rejects: a turn that fails before reaching the
 * await leaves it settled rather than unhandled, and the code that does need
 * the result gets the original error back from `takeEarly`, at the same point
 * in the turn where it would have thrown had the call run serially.
 */
export type EarlyStart<T> = Promise<
  { ok: true; value: T } | { ok: false; error: unknown }
>;

export function startEarly<T>(run: () => Promise<T>): EarlyStart<T> {
  return new Promise<T>((resolve) => resolve(run())).then(
    (value) => ({ ok: true as const, value }),
    (error: unknown) => ({ ok: false as const, error }),
  );
}

export async function takeEarly<T>(started: EarlyStart<T>): Promise<T> {
  const result = await started;
  if (!result.ok) throw result.error;
  return result.value;
}
