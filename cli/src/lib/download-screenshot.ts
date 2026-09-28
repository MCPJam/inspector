import { operationalError } from "./output.js";
export async function fetchArtifactBytes(
  url: string,
  timeoutMs: number,
  kind = "screenshot"
): Promise<Uint8Array> {
  const controller = new AbortController();
  const handle = setTimeout(() => controller.abort(), timeoutMs);
  handle.unref?.();
  try {
    const response = await fetch(url, { signal: controller.signal });
    if (!response.ok) {
      throw operationalError(
        `Failed to download ${kind} (HTTP ${response.status}).`,
        { url }
      );
    }
    return new Uint8Array(await response.arrayBuffer());
  } catch (error) {
    if (error instanceof Error && error.name === "AbortError") {
      throw operationalError(
        `Timed out downloading ${kind} after ${timeoutMs}ms.`,
        { url }
      );
    }
    throw error;
  } finally {
    clearTimeout(handle);
  }
}
