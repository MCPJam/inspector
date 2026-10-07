import { useEffect, useMemo, useState, type ReactNode } from "react";
import { OpenAIFormSchema } from "@openai/mcp-extensions/server";
import { Button } from "@mcpjam/design-system/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@mcpjam/design-system/dialog";
import { authFetch } from "@/lib/session-token";
import {
  appendPluginDiagnostics,
  describePluginError,
} from "@/lib/plugin-diagnostics";
import { pluginDiagnostic } from "@/shared/plugin-diagnostics";
import {
  PluginDescribedError,
  withPluginDeadline,
} from "@/shared/plugin-operation";
import { pluginFormResources } from "@/shared/plugin-extensions/form-plan";
import {
  pluginFormFileServicesSchema,
  pluginFormFileUploadResultSchema,
  PLUGIN_FORM_FILE_MAX_BYTES,
  PLUGIN_FORM_FILE_BATCH_MAX_BYTES,
  PLUGIN_FORM_FILE_MAX_COUNT,
  pluginFormDirectoryPaths,
  type PluginFormParent,
} from "@/shared/plugin-form-services";
import type { PluginFormPorts } from "../schema-form/PluginFormFields";
import {
  pluginFormRefusalLogged,
  pluginFormServiceRefusal,
  type PluginFormServiceScope,
  type PluginFormServiceServer,
} from "./form-resource-preview";

function chooseFiles(
  options: { kind?: "file" | "directory"; accept?: string[] },
  multiple: boolean,
  signal: AbortSignal,
): Promise<File[]> {
  signal.throwIfAborted();
  return new Promise((resolve, reject) => {
    const input = document.createElement("input");
    input.type = "file";
    input.multiple = multiple;
    input.webkitdirectory = options.kind === "directory";
    input.accept = options.accept?.join(",") ?? "";
    input.hidden = true;
    const cleanup = () => {
      signal.removeEventListener("abort", abort);
      input.remove();
    };
    const abort = () => {
      cleanup();
      reject(signal.reason ?? new Error("File selection closed"));
    };
    input.onchange = () => {
      const files = [...(input.files ?? [])];
      cleanup();
      resolve(files);
    };
    input.oncancel = () => {
      cleanup();
      resolve([]);
    };
    signal.addEventListener("abort", abort, { once: true });
    document.body.append(input);
    try {
      input.click();
    } catch (error) {
      cleanup();
      reject(error);
    }
  });
}

export function formFileUploadPorts(
  scope: PluginFormServiceScope,
  sourceToken: string,
  parent: PluginFormParent,
): PluginFormPorts {
  const receipts = new Map<string, string>();
  const labels = new Map<string, string>();
  return {
    resourceLabel: (uri) => labels.get(uri) ?? uri,
    chooseResources: async (options, signal, context) => {
      const directory = options.kind === "directory";
      const files = await chooseFiles(options, context.multiple, signal);
      if (!files.length) return [];
      if (directory)
        files.sort((a, b) =>
          a.webkitRelativePath < b.webkitRelativePath
            ? -1
            : a.webkitRelativePath > b.webkitRelativePath
            ? 1
            : 0,
        );
      const relativePaths = directory
        ? files.map((file) => file.webkitRelativePath)
        : undefined;
      if (directory)
        pluginFormDirectoryPaths(
          files.map((file) => ({
            name: file.name,
            relativePath: file.webkitRelativePath,
          })),
        );
      if (
        files.length > PLUGIN_FORM_FILE_MAX_COUNT ||
        files.some((file) => file.size > PLUGIN_FORM_FILE_MAX_BYTES) ||
        files.reduce((sum, file) => sum + file.size, 0) >
          PLUGIN_FORM_FILE_BATCH_MAX_BYTES
      )
        throw new Error("Selected files are too large");
      const hashes = await Promise.all(
        files.map(async (file) => [
          file.name,
          file.type,
          directory ? file.webkitRelativePath : undefined,
          [
            ...new Uint8Array(
              await crypto.subtle.digest("SHA-256", await file.arrayBuffer()),
            ),
          ]
            .map((byte) => byte.toString(16).padStart(2, "0"))
            .join(""),
        ]),
      );
      signal.throwIfAborted();
      const key = JSON.stringify([context.field, hashes]);
      let operationId = receipts.get(key);
      if (!operationId) {
        if (receipts.size >= 64) throw new Error("Too many file selections");
        operationId = crypto.randomUUID();
        receipts.set(key, operationId);
      }
      const form = new FormData();
      form.append(
        "request",
        JSON.stringify({
          projectId: scope.projectId,
          pluginWorkspace: { version: 1, workspaceId: scope.workspaceId },
          sourceToken,
          parent,
          field: context.field,
          operationId,
          ...(relativePaths ? { relativePaths } : {}),
        }),
      );
      // Chromium otherwise uses webkitRelativePath as the multipart filename.
      // Hierarchy is separate validated metadata; the binary part stays a basename.
      files.forEach((file) => form.append("files", file, file.name));
      const response = await authFetch(
        "/api/web/apps/plugin-instances/form-files/upload",
        { method: "POST", body: form, signal },
      );
      if (!response.ok) {
        // A described refusal (a toggle turned off since the form opened)
        // says why here and in the Logs panel.
        const refusal = (await response.json().catch(() => null)) as {
          description?: unknown;
          diagnostics?: unknown;
        } | null;
        appendPluginDiagnostics(refusal?.diagnostics);
        throw new Error(
          typeof refusal?.description === "string" && refusal.description.trim()
            ? refusal.description.slice(0, 1000)
            : "File upload unavailable; retry the same selection",
        );
      }
      const result = pluginFormFileUploadResultSchema.parse(
        await response.json(),
      );
      if (result.uris.length !== (directory ? 1 : files.length))
        throw new Error("File upload receipt changed");
      signal.throwIfAborted();
      result.uris.forEach((uri, index) =>
        labels.set(
          uri,
          directory
            ? files[0]!.webkitRelativePath.split("/")[0]!
            : files[index]!.name,
        ),
      );
      return result.uris;
    },
  };
}

/** How long checking where a form's uploads go may take. */
export const PLUGIN_FORM_DESTINATION_TIMEOUT_MS = 30_000;

const described = (code: string) =>
  new PluginDescribedError(describePluginError(code) ?? code, code);

/**
 * Ask the server where this form's uploads would go, within
 * `PLUGIN_FORM_DESTINATION_TIMEOUT_MS` (and never past the form's own
 * window). A check that can't finish rejects with a plain description and
 * writes one Logs entry. Closing the form (`signal`) is not a failure and
 * logs nothing.
 */
export async function checkPluginFormDestination(options: {
  scope: PluginFormServiceScope;
  sourceToken: string;
  parent: PluginFormParent;
  expiresAt: number;
  server?: PluginFormServiceServer;
  signal: AbortSignal;
}) {
  const { scope, sourceToken, parent, expiresAt, server, signal } = options;
  try {
    if (expiresAt <= Date.now()) throw described("FORM_SOURCE_UNAVAILABLE");
    // The request starts now, not a tick later, so closing the form right
    // after it opens cancels this exact request. The deadline races it: the
    // bearer lookup inside `authFetch` can wait on a session refresh that
    // honors no signal, and that wait must not hold the form open either.
    const deadline = new AbortController();
    const bounded = AbortSignal.any([signal, deadline.signal]);
    const request = (async () => {
      const response = await authFetch(
        "/api/web/apps/plugin-instances/form-files/services",
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          signal: bounded,
          body: JSON.stringify({
            projectId: scope.projectId,
            pluginWorkspace: { version: 1, workspaceId: scope.workspaceId },
            sourceToken,
            parent,
          }),
        },
      );
      const body: unknown = await response.json().catch(() => null);
      if (!response.ok)
        throw pluginFormServiceRefusal(body, "PLUGIN_FORM_DESTINATION_FAILED");
      return pluginFormFileServicesSchema.parse(body);
    })();
    // Settled by the race below; a late rejection is not unhandled.
    request.catch(() => {});
    return await withPluginDeadline(
      signal,
      Math.min(PLUGIN_FORM_DESTINATION_TIMEOUT_MS, expiresAt - Date.now()),
      () =>
        described(
          expiresAt <= Date.now()
            ? "FORM_SOURCE_UNAVAILABLE"
            : "PLUGIN_FORM_DESTINATION_TIMEOUT",
        ),
      (limit) => {
        limit.addEventListener("abort", () => deadline.abort(limit.reason), {
          once: true,
        });
        return request;
      },
    );
  } catch (error) {
    if (signal.aborted) throw error;
    const failure =
      error instanceof PluginDescribedError
        ? error
        : described("PLUGIN_FORM_DESTINATION_FAILED");
    if (!pluginFormRefusalLogged(failure))
      appendPluginDiagnostics(
        [
          pluginDiagnostic(
            "error",
            failure.code,
            "Form file destination not confirmed",
            failure.message,
            { form: parent.kind },
          ),
        ],
        server ?? {},
      );
    throw failure;
  }
}

/** Wait for actual original-target admission before mounting a form needing uploads. */
export function PluginFormFileServices(props: {
  scope?: PluginFormServiceScope;
  sourceToken?: string;
  parent: PluginFormParent;
  schema?: unknown;
  expiresAt: number;
  /** The server that asked for the form, for its Logs entries. */
  server?: PluginFormServiceServer;
  onCancel?: () => Promise<void>;
  children: (services: {
    ports: PluginFormPorts;
    userResources: boolean;
    userResourceKinds: ("file" | "directory")[];
    /** Present once the server described this form's file services. */
    origin?: "server" | "mcp-app";
    fileResources?: boolean;
  }) => ReactNode;
}) {
  const parsed = OpenAIFormSchema.safeParse(props.schema);
  const needed =
    parsed.success &&
    Object.values(parsed.data.properties).some((field) => {
      const input = pluginFormResources(field);
      return (
        input?.selection === "implicit" || input?.userOptions !== undefined
      );
    });
  const parentKey = JSON.stringify(props.parent);
  const serviceKey = JSON.stringify([
    props.scope?.projectId,
    props.scope?.workspaceId,
    props.sourceToken,
    parentKey,
  ]);
  const [admission, setAdmission] = useState<{
    key: string;
    available: boolean;
    kinds: ("file" | "directory")[];
    origin?: "server" | "mcp-app";
    fileResources?: boolean;
  }>();
  // A new immutable source/round/key cannot reuse the previous editor's admission,
  // including the render before its effect cleanup/recheck executes.
  const currentAdmission =
    admission?.key === serviceKey ? admission : undefined;
  const available = currentAdmission?.available;
  // Why the destination check failed, in plain English; unset while it runs.
  const [failure, setFailure] = useState<string>();
  const failed = failure !== undefined;
  const [attempt, setAttempt] = useState(0);
  const [cancelling, setCancelling] = useState(false);
  useEffect(() => {
    if (!needed || !props.scope || !props.sourceToken) return;
    // Aborted only when this check is superseded or the form closes. A check
    // that runs out of time is a failure the person sees, with Retry; it never
    // leaves the form on "Checking the file destination."
    const abort = new AbortController();
    setAdmission(undefined);
    setFailure(undefined);
    void checkPluginFormDestination({
      scope: props.scope,
      sourceToken: props.sourceToken,
      parent: props.parent,
      expiresAt: props.expiresAt,
      ...(props.server ? { server: props.server } : {}),
      signal: abort.signal,
    })
      .then((services) => {
        if (!abort.signal.aborted)
          setAdmission({
            key: serviceKey,
            available:
              services.userResources && services.userResourceKinds.length > 0,
            kinds: services.userResources ? services.userResourceKinds : [],
            ...(services.origin ? { origin: services.origin } : {}),
            ...(services.fileResources !== undefined
              ? { fileResources: services.fileResources }
              : {}),
          });
      })
      .catch((error: unknown) => {
        if (!abort.signal.aborted)
          setFailure(
            error instanceof Error && error.message
              ? error.message
              : (describePluginError("PLUGIN_FORM_DESTINATION_FAILED") ??
                  "Retry or cancel this request."),
          );
      });
    return () => abort.abort();
  }, [
    needed,
    props.scope?.projectId,
    props.scope?.workspaceId,
    props.sourceToken,
    parentKey,
    props.expiresAt,
    attempt,
  ]);
  const ports = useMemo(
    () =>
      available && props.scope && props.sourceToken
        ? formFileUploadPorts(props.scope, props.sourceToken, props.parent)
        : {},
    [
      available,
      props.scope?.projectId,
      props.scope?.workspaceId,
      props.sourceToken,
      parentKey,
    ],
  );
  const cancel = async () => {
    setCancelling(true);
    try {
      await props.onCancel?.();
    } catch {
      setFailure((current) => current ?? "Retry or cancel this request.");
    } finally {
      setCancelling(false);
    }
  };
  if (needed && props.scope && props.sourceToken && available === undefined)
    return (
      <Dialog
        open
        onOpenChange={(open) => {
          if (!open && !cancelling) void cancel();
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>
              {failed ? "File target unavailable" : "Loading form"}
            </DialogTitle>
            <DialogDescription>
              {failed ? failure : "Checking the file destination."}
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            {failed && (
              <Button
                disabled={cancelling}
                onClick={() => setAttempt((value) => value + 1)}
              >
                Retry
              </Button>
            )}
            <Button disabled={cancelling} onClick={() => void cancel()}>
              Cancel
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    );
  return props.children({
    ports,
    userResources: available === true,
    userResourceKinds: currentAdmission?.kinds ?? [],
    ...(currentAdmission?.origin ? { origin: currentAdmission.origin } : {}),
    ...(currentAdmission?.fileResources !== undefined
      ? { fileResources: currentAdmission.fileResources }
      : {}),
  });
}
