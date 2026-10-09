import { parsePluginWorkspaceRecording } from "./plugin-workspace-recording";

export const PLUGIN_REPLAY_IMAGE_MAX_BYTES = 1024 * 1024;

/** Only captured raster bytes; SVG/HTML/URLs never enter the replay frame. */
export function capturedPluginImageDataUrl(base64: string): string {
  if (
    base64.length > Math.ceil(PLUGIN_REPLAY_IMAGE_MAX_BYTES / 3) * 4 ||
    !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(
      base64,
    )
  )
    throw new Error("PLUGIN_REPLAY_IMAGE_INVALID");
  const bytes = atob(base64);
  if (bytes.length > PLUGIN_REPLAY_IMAGE_MAX_BYTES)
    throw new Error("PLUGIN_REPLAY_IMAGE_INVALID");
  const png = bytes.startsWith("\x89PNG\r\n\x1a\n");
  const jpeg = bytes.startsWith("\xff\xd8\xff");
  if (!png && !jpeg) throw new Error("PLUGIN_REPLAY_IMAGE_INVALID");
  return `data:image/${png ? "png" : "jpeg"};base64,${base64}`;
}

/** A standalone captured view: no live ports, scripts, URLs or app HTML. */
export function pluginWorkspaceReplayDocument(
  recording: unknown,
  screenshotBase64?: string,
): string {
  if (recording !== undefined) parsePluginWorkspaceRecording(recording);
  const image = screenshotBase64
    ? capturedPluginImageDataUrl(screenshotBase64)
    : undefined;
  // The capture is the entire view. Recording metadata belongs to the trace
  // timeline, never reconstructed app UI. All attributes below are host-owned.
  return `<!doctype html><html><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src data:; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'; frame-src 'none'; connect-src 'none'"><meta name="referrer" content="no-referrer"><style>html,body{margin:0}img{display:block;max-width:100%;height:auto}</style></head><body>${
    image
      ? `<img alt="Captured workspace" src="${image}">`
      : "<p>No captured image available.</p>"
  }</body></html>`;
}
