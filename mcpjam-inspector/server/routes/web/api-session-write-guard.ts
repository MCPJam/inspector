/** The restored origin is a hint for an early refusal, never write authority.
 * Ingestion independently rejects web writes to API conversations. */
export async function apiSessionWriteAllowed(
  origin: unknown,
  read: () => Promise<{ writable: boolean }>,
): Promise<boolean> {
  if (origin !== "api") return true;
  try {
    return (await read()).writable;
  } catch {
    return true;
  }
}
