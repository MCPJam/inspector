import { useEffect, useState } from "react";
import {
  capturedPluginImageDataUrl,
  pluginWorkspaceReplayDocument,
  PLUGIN_REPLAY_IMAGE_MAX_BYTES,
} from "@/shared/plugin-workspace-replay";
import { parsePluginWorkspaceRecording } from "@/shared/plugin-workspace-recording";
import {
  fetchArtifact,
  isSignedArtifactUrl,
  useFreshArtifactUrl,
} from "@/lib/artifact-urls";

/** Pure replay: callers preload owned bytes; this component cannot fetch. */
export function PluginWorkspaceReplay({
  recording,
  screenshotBase64,
}: {
  recording?: unknown;
  screenshotBase64?: string;
}) {
  let srcDoc: string;
  try {
    srcDoc = pluginWorkspaceReplayDocument(recording, screenshotBase64);
  } catch {
    return (
      <p role="status" className="text-xs text-muted-foreground">
        Unsupported workspace capture.
      </p>
    );
  }
  return (
    <iframe
      title="Recorded plugin workspace"
      sandbox=""
      referrerPolicy="no-referrer"
      srcDoc={srcDoc}
      className="h-96 w-full rounded-md border border-border bg-background"
    />
  );
}

/** Artifact loading is separate from inert replay and uses the existing read grant. */
export function RecordedPluginWorkspace({
  recording,
  screenshotUrl,
}: {
  recording?: unknown;
  screenshotUrl?: string | null;
}) {
  const url = useFreshArtifactUrl(screenshotUrl ?? undefined);
  const [loaded, setLoaded] = useState<{
    url: string | undefined;
    base64?: string;
    failed?: boolean;
  }>();
  let supported = false;
  try {
    if (recording !== undefined) parsePluginWorkspaceRecording(recording);
    supported = true;
  } catch {
    /* diagnose only this capture */
  }
  useEffect(() => {
    if (!supported || !url) return;
    const abort = new AbortController();
    void (async () => {
      try {
        if (!isSignedArtifactUrl(url))
          throw new Error("Owned screenshot link unavailable");
        const response = await fetchArtifact(url, {
          signal: abort.signal,
          credentials: "omit",
          redirect: "error",
        });
        if (!response.ok || !response.body)
          throw new Error("Screenshot unavailable");
        const reader = response.body.getReader();
        const chunks: Uint8Array[] = [];
        let size = 0;
        try {
          while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            size += value.byteLength;
            if (size > PLUGIN_REPLAY_IMAGE_MAX_BYTES)
              throw new Error("Screenshot too large");
            chunks.push(value);
          }
        } finally {
          await reader.cancel().catch(() => {});
          reader.releaseLock();
        }
        const bytes = new Uint8Array(size);
        let offset = 0;
        for (const chunk of chunks) {
          bytes.set(chunk, offset);
          offset += chunk.length;
        }
        let binary = "";
        for (let index = 0; index < bytes.length; index += 8192)
          binary += String.fromCharCode(...bytes.subarray(index, index + 8192));
        const base64 = btoa(binary);
        // Raster validation happens before retaining the bytes or mounting replay.
        capturedPluginImageDataUrl(base64);
        if (!abort.signal.aborted) setLoaded({ url, base64 });
      } catch {
        if (!abort.signal.aborted) setLoaded({ url, failed: true });
      }
    })();
    return () => abort.abort();
  }, [url, supported]);
  if (!supported) return <PluginWorkspaceReplay recording={recording} />;
  if (url && loaded?.url !== url)
    return (
      <p role="status" className="text-xs text-muted-foreground">
        Loading captured workspace…
      </p>
    );
  return (
    <div className="space-y-2">
      {loaded?.failed ? (
        <p role="status" className="text-xs text-muted-foreground">
          Captured image unavailable.
        </p>
      ) : null}
      <PluginWorkspaceReplay
        recording={recording}
        screenshotBase64={url ? loaded?.base64 : undefined}
      />
    </div>
  );
}
