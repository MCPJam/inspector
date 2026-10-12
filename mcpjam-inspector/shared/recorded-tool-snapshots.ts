import { z } from "zod";

const entrySchema = z
  .object({
    snapshot: z.unknown().optional(),
    snapshotUrl: z.string().nullable().optional(),
  })
  .passthrough();
const contextSchema = z
  .object({ toolSnapshots: z.array(z.unknown()) })
  .passthrough();
const snapshotSchema = z
  .object({ version: z.number(), servers: z.array(z.unknown()) })
  .passthrough();

/** Signed archive downloads keep complete catalogs outside query responses. */
export async function hydrateRecordedToolSnapshots(
  context: Record<string, unknown>,
  load: (url: string) => Promise<unknown>,
  reportFailure: (error: unknown) => void,
): Promise<Record<string, unknown>> {
  const parsed = contextSchema.safeParse(context);
  if (!parsed.success) return context;
  const toolSnapshots: unknown[] = [];
  for (const value of parsed.data.toolSnapshots) {
    const entry = entrySchema.safeParse(value);
    if (!entry.success || entry.data.snapshot || !entry.data.snapshotUrl) {
      toolSnapshots.push(value);
      continue;
    }
    try {
      const snapshot = snapshotSchema.parse(await load(entry.data.snapshotUrl));
      toolSnapshots.push({ ...entry.data, snapshot });
    } catch (error) {
      // Missing evidence is explicit; other catalogs and the transcript still load.
      reportFailure(error);
      toolSnapshots.push({
        ...entry.data,
        snapshot: null,
        snapshotUnavailable: true,
      });
    }
  }
  return { ...context, toolSnapshots };
}

export function isToolSnapshotUnavailable(context: unknown): boolean {
  if (
    z
      .object({ toolSnapshotCaptureStatus: z.literal("unavailable") })
      .safeParse(context).success
  )
    return true;
  const parsed = contextSchema.safeParse(context);
  return (
    parsed.success &&
    parsed.data.toolSnapshots.some(
      (entry) =>
        entrySchema.safeParse(entry).data?.snapshotUnavailable === true,
    )
  );
}
