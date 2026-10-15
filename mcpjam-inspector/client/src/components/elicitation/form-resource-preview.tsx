import { authFetch } from "@/lib/session-token";
import { useState } from "react";
import {
  appendPluginDiagnostics,
  describePluginError,
} from "@/lib/plugin-diagnostics";
import {
  pluginFormResourcePreviewSchema,
  pluginFormPreviewBytes,
  type PluginFormParent,
} from "@/shared/plugin-form-services";
import { pluginDiagnostic } from "@/shared/plugin-diagnostics";
import {
  PluginDescribedError,
  withPluginDeadline,
} from "@/shared/plugin-operation";
import type { PluginFormPreview } from "@/shared/plugin-extensions/form-plan";
import type { PluginFormPorts } from "../schema-form/PluginFormFields";

export type PluginFormServiceScope = { projectId: string; workspaceId: string };
/** The server that asked for the form, for its Logs entries. */
export type PluginFormServiceServer = { serverId: string; serverName?: string };

/** How long opening a preview may take. Waiting on the person (an App
 * approval) doesn't count. */
export const PLUGIN_FORM_PREVIEW_TIMEOUT_MS = 30_000;

const described = (code: string) =>
  new PluginDescribedError(describePluginError(code) ?? code, code);

/** Refusals whose own server entries already went to Logs. */
const logged = new WeakSet<Error>();

/** A refused form service response (its parsed body), in the server's own
 * description. Entries the server sent for Logs go there. */
export function pluginFormServiceRefusal(
  body: unknown,
  fallback: string,
): PluginDescribedError {
  const value = (body && typeof body === "object" ? body : {}) as {
    code?: unknown;
    description?: unknown;
    diagnostics?: unknown;
  };
  const entries = appendPluginDiagnostics(value.diagnostics);
  const code =
    typeof value.code === "string" && value.code.trim()
      ? value.code.slice(0, 128)
      : fallback;
  const description =
    typeof value.description === "string" && value.description.trim()
      ? value.description.slice(0, 1000)
      : describePluginError(code) ?? describePluginError(fallback) ?? code;
  const refusal = new PluginDescribedError(description, code);
  if (entries.length) logged.add(refusal);
  return refusal;
}

/** Whether a refusal's own server entries already went to Logs. */
export function pluginFormRefusalLogged(error: Error): boolean {
  return logged.has(error);
}

/**
 * Open one preview within `PLUGIN_FORM_PREVIEW_TIMEOUT_MS`. A preview that
 * can't open rejects with a plain description and writes one Logs entry;
 * the form itself is never touched. Closing the field (its signal) is not
 * a failure and logs nothing.
 */
export async function openPluginFormPreview<T>(
  target: PluginFormPreview,
  signal: AbortSignal,
  server: PluginFormServiceServer | undefined,
  open: (
    bounded: AbortSignal,
    pause: <R>(wait: () => Promise<R>) => Promise<R>,
  ) => Promise<T>,
): Promise<T> {
  try {
    return await withPluginDeadline(
      signal,
      PLUGIN_FORM_PREVIEW_TIMEOUT_MS,
      () => described("PLUGIN_FORM_PREVIEW_TIMEOUT"),
      open,
    );
  } catch (error) {
    if (signal.aborted) throw error;
    const failure =
      error instanceof PluginDescribedError
        ? error
        : described("PLUGIN_FORM_PREVIEW_FAILED");
    if (logged.has(failure)) throw failure;
    appendPluginDiagnostics(
      [
        pluginDiagnostic(
          "error",
          failure.code,
          `Preview didn't open: ${target.name}`.slice(0, 160),
          failure.message,
          {
            previewType: target.type,
            ...(target.type === "resource_link"
              ? { uri: target.uri }
              : { tool: target.name }),
          },
        ),
      ],
      server ?? {},
    );
    throw failure;
  }
}

/** Same authenticated product route for both legacy and keyed MRTR editors. */
export function formResourcePreviewPorts(
  scope: PluginFormServiceScope,
  sourceToken: string | undefined,
  parent: PluginFormParent,
  expiresAt: number,
  server?: PluginFormServiceServer,
): PluginFormPorts {
  if (!sourceToken) return {};
  return resourcePreviewPorts(
    expiresAt,
    async (target, pending) => {
      const response = await authFetch(
        "/api/web/apps/plugin-instances/form-preview",
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          signal: pending,
          body: JSON.stringify({
            projectId: scope.projectId,
            pluginWorkspace: { version: 1, workspaceId: scope.workspaceId },
            sourceToken,
            parent,
            target,
          }),
        },
      );
      if (!response.ok)
        throw pluginFormServiceRefusal(
          await response.json().catch(() => null),
          "PLUGIN_FORM_PREVIEW_FAILED",
        );
      return response.json();
    },
    server,
  );
}

/** Same inert byte renderer for authenticated interactive and admitted run services. */
export function resourcePreviewPorts(
  expiresAt: number,
  read: (
    target: Parameters<NonNullable<PluginFormPorts["preview"]>>[0],
    signal: AbortSignal,
  ) => Promise<unknown>,
  server?: PluginFormServiceServer,
): PluginFormPorts {
  return {
    preview: (target, signal) =>
      openPluginFormPreview(target, signal, server, (bounded) =>
        renderResourcePreview(target, signal, bounded, expiresAt, read),
      ),
  };
}

async function renderResourcePreview(
  target: PluginFormPreview,
  signal: AbortSignal,
  bounded: AbortSignal,
  expiresAt: number,
  read: (target: PluginFormPreview, signal: AbortSignal) => Promise<unknown>,
) {
  if (Date.now() >= expiresAt) throw described("FORM_SOURCE_UNAVAILABLE");
  // The opened preview lives until the field closes it or the form
  // expires; only opening it is bounded.
  const pending = AbortSignal.any([
    signal,
    AbortSignal.timeout(Math.max(1, expiresAt - Date.now())),
  ]);
  const reading = AbortSignal.any([pending, bounded]);
  const value = pluginFormResourcePreviewSchema.parse(
    await read(target, reading),
  );
  reading.throwIfAborted();
  if (
    target.type !== "resource_link" ||
    value.contents.some((item) => item.uri !== target.uri)
  )
    throw new Error("Invalid resource preview");
  const urls: string[] = [];
  const elements = new Set<HTMLImageElement | HTMLMediaElement>();
  let released = false;
  const release = () => {
    if (released) return;
    released = true;
    pending.removeEventListener("abort", release);
    for (const element of elements) {
      if (element instanceof HTMLMediaElement) element.pause();
      element.removeAttribute("src");
      if (element instanceof HTMLMediaElement) element.load();
    }
    elements.clear();
    urls.splice(0).forEach((url) => URL.revokeObjectURL(url));
  };
  const retain = (element: HTMLImageElement | HTMLMediaElement | null) => {
    if (element && !released) elements.add(element);
  };
  try {
    const content = value.contents.map((item, index) => {
      if ("text" in item)
        return (
          <pre
            key={index}
            className="max-h-72 overflow-auto whitespace-pre-wrap break-words text-sm"
          >
            {item.text}
          </pre>
        );
      // Host-created object URLs contain only the authorized response bytes;
      // no resource URI, public storage URL or caller-selected URL is loaded.
      const bytes = pluginFormPreviewBytes(item.blob);
      const url = URL.createObjectURL(
        new Blob([bytes.buffer as ArrayBuffer], { type: item.mimeType }),
      );
      urls.push(url);
      return (
        <ResourcePreviewMedia
          key={index}
          url={url}
          mimeType={item.mimeType}
          name={target.name}
          retain={retain}
        />
      );
    });
    pending.addEventListener("abort", release, { once: true });
    reading.throwIfAborted();
    return {
      content: (
        <div aria-label="Resource preview" className="space-y-3">
          {content}
        </div>
      ),
      release,
    };
  } catch (error) {
    release();
    throw error;
  }
}

function ResourcePreviewMedia({
  url,
  mimeType,
  name,
  retain,
}: {
  url: string;
  mimeType: string;
  name: string;
  retain: (element: HTMLImageElement | HTMLMediaElement | null) => void;
}) {
  const [failed, setFailed] = useState(false);
  if (failed)
    return (
      <p role="alert" className="text-sm text-muted-foreground">
        This resource could not be decoded by your browser.
      </p>
    );
  const attributes = { ref: retain, src: url, onError: () => setFailed(true) };
  if (mimeType.startsWith("image/"))
    return (
      <img
        {...attributes}
        alt={`${name} preview`}
        className="max-h-72 max-w-full object-contain"
      />
    );
  if (mimeType.startsWith("audio/"))
    return (
      <audio
        {...attributes}
        aria-label="Audio preview"
        controls
        preload="metadata"
        className="w-full"
      />
    );
  return (
    <video
      {...attributes}
      aria-label="Video preview"
      controls
      playsInline
      preload="metadata"
      className="max-h-72 max-w-full"
    />
  );
}
