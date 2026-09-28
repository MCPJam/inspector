/** The restored origin is a hint for an early refusal, never write authority.
 * Ingestion independently rejects web writes to API conversations. */
export async function apiSessionWriteAllowed(
  origin: unknown,
  read: (signal: AbortSignal) => Promise<{ writable: boolean }>,
  timeoutMs = 2_000,
): Promise<boolean> {
  if (origin !== "api") return true;
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      read(controller.signal).then((result) => result.writable),
      new Promise<boolean>((resolve) => {
        timer = setTimeout(() => {
          controller.abort();
          resolve(true);
        }, timeoutMs);
      }),
    ]);
  } catch {
    return true;
  } finally {
    clearTimeout(timer);
  }
}
