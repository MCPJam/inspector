/**
 * Per-surface snapshot providers.
 *
 * `ui_snapshot_app` used to be a `snapshotApp` command handler owned by the
 * Playground, which made it the only screen the agent could observe — from
 * anywhere else it errored, so the model's only way to look at the app was
 * to first change it.
 *
 * A registry rather than more command handlers, because the command bus
 * dispatches handlers in reverse registration order and returns the first
 * success. Two `snapshotApp` handlers would mean the most recently mounted
 * one silently wins and the rest are never consulted — the opposite of what
 * a whole-app snapshot needs. So exactly ONE `snapshotApp` handler exists
 * (registered in App.tsx), and it reads this registry.
 *
 * Providers are read-only by contract: `ui_snapshot_app` is annotated
 * `readOnlyHint: true`, and that exemption from approval is only honest if
 * looking never changes anything.
 */

const providers = new Map<string, () => unknown>();

/** Per-provider budget. A snapshot is orientation, not a state dump. */
export const MAX_SURFACE_SNAPSHOT_CHARS = 8 * 1024;

/** How long one provider may take before the rest go on without it. */
export const SURFACE_SNAPSHOT_TIMEOUT_MS = 2_000;

export type SurfaceSnapshotResult =
  | { ok: true; data: unknown }
  | { ok: false; error: string };

/**
 * Register the snapshot provider for a mounted surface.
 *
 * Re-registering a surface id REPLACES the previous provider rather than
 * throwing: HMR and StrictMode double-mounts re-run effects, and a surface
 * has exactly one provider by definition.
 */
export function registerSurfaceSnapshotProvider(
  surfaceId: string,
  provider: () => unknown,
): () => void {
  providers.set(surfaceId, provider);
  return () => {
    // Only remove OUR provider: a StrictMode remount can register the
    // replacement before the first effect's cleanup runs, and a blind
    // delete would drop the live one.
    if (providers.get(surfaceId) === provider) providers.delete(surfaceId);
  };
}

export function hasSurfaceSnapshotProvider(surfaceId: string): boolean {
  return providers.has(surfaceId);
}

export function listSurfaceSnapshotProviderIds(): string[] {
  return [...providers.keys()].sort();
}

function clampSnapshot(data: unknown): unknown {
  let serialized: string | undefined;
  try {
    serialized = JSON.stringify(data);
  } catch {
    return { error: "snapshot is not JSON-serializable" };
  }
  // `JSON.stringify` returns `undefined` (the value, not a string) for
  // `undefined` and for functions — a provider that returns nothing hits
  // this. Reading `.length` off it would throw, taking down the whole-app
  // snapshot, so normalize to a benign empty result.
  if (serialized === undefined) return { empty: true };
  if (serialized.length <= MAX_SURFACE_SNAPSHOT_CHARS) return data;
  return {
    truncated: true,
    note: `Snapshot exceeded ${MAX_SURFACE_SNAPSHOT_CHARS} chars and was truncated.`,
    preview: serialized.slice(0, MAX_SURFACE_SNAPSHOT_CHARS),
  };
}

/**
 * Read one surface's snapshot, isolating its failures.
 *
 * A provider that throws or hangs must not take down the whole-app snapshot:
 * the answer "everything except Evals, which errored" is useful, and
 * "nothing" is not.
 */
export async function readSurfaceSnapshot(
  surfaceId: string,
): Promise<SurfaceSnapshotResult> {
  const provider = providers.get(surfaceId);
  if (!provider) {
    return { ok: false, error: `No snapshot provider for "${surfaceId}".` };
  }
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const data = await Promise.race([
      Promise.resolve().then(() => provider()),
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(
          () =>
            reject(
              new Error(
                `Snapshot for "${surfaceId}" timed out after ${SURFACE_SNAPSHOT_TIMEOUT_MS}ms.`,
              ),
            ),
          SURFACE_SNAPSHOT_TIMEOUT_MS,
        );
      }),
    ]);
    return { ok: true, data: clampSnapshot(data) };
  } catch (error) {
    return {
      ok: false,
      error: error instanceof Error ? error.message : String(error),
    };
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/**
 * Read every mounted surface, in sorted id order so the same app state
 * serializes the same way twice.
 */
export async function readAllSurfaceSnapshots(): Promise<
  Record<string, unknown>
> {
  // Concurrently: serial reads make one hanging surface cost every later
  // surface the full timeout, so N stalled providers would take N×2s while
  // a chat stream waits. Each read is already isolated and individually
  // timed out. Output is still assembled in sorted id order, so the same app
  // state serializes the same way twice regardless of who resolves first.
  const surfaceIds = listSurfaceSnapshotProviderIds();
  const results = await Promise.all(
    surfaceIds.map(async (surfaceId) => {
      const result = await readSurfaceSnapshot(surfaceId);
      return [
        surfaceId,
        result.ok ? result.data : { error: result.error },
      ] as const;
    }),
  );
  const out: Record<string, unknown> = {};
  for (const [surfaceId, data] of results) out[surfaceId] = data;
  return out;
}

/** Test-only: drop every registration. */
export function __resetSurfaceSnapshotProvidersForTests(): void {
  providers.clear();
}
