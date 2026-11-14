import { useEffect, useMemo, useRef, useState } from "react";
import { stableStringifyJson } from "@mcpjam/sdk/widget-runtime";
import type {
  PreparedSandboxView,
  PrepareSandboxViewRequest,
} from "@mcpjam/sdk/widget-runtime";
import type { WidgetHostServices } from "./widget-host";
import { SandboxViewAdmissionError } from "./sandbox-view-error";

export interface SandboxViewAdmission {
  services: Pick<WidgetHostServices, "prepareSandboxView" | "releaseSandboxView">;
  request: Omit<PrepareSandboxViewRequest, "viewInstanceId" | "admissionId" | "hostOrigin">;
}

interface AdmissionEntry {
  key: string;
  prepare: NonNullable<WidgetHostServices["prepareSandboxView"]>;
  release: NonNullable<WidgetHostServices["releaseSandboxView"]>;
  request: PrepareSandboxViewRequest;
  controller: AbortController;
  result?: PreparedSandboxView;
  users: number;
  disposed: boolean;
  timer?: ReturnType<typeof setTimeout>;
  expiryTimer?: ReturnType<typeof setTimeout>;
  pending: Promise<PreparedSandboxView>;
}

function releaseEntry(entry: AdmissionEntry): void {
  if (entry.disposed) return;
  entry.disposed = true;
  clearTimeout(entry.timer);
  clearTimeout(entry.expiryTimer);
  // Let pending creation finish so its returned lease can be explicitly closed.
  // Aborting first could discard the only response containing its admission ID.
  if (entry.result) {
    entry.controller.abort();
    void entry.release({ admissionId: entry.result.admissionId }).catch(() => {
      // The server lease also expires; failed cleanup cannot grant a new view.
    });
  }
}

/** Keeps an admitted origin attached to its retained React owner. */
export function useSandboxView(admission?: SandboxViewAdmission) {
  const html = admission?.request.html;
  const recipe = stableStringifyJson({
    source: admission?.request.source,
    sourceReceipt: admission?.request.sourceReceipt,
    policy: admission?.request.policy,
    mode: admission?.request.mode,
  });
  // Streaming host renders must not repeatedly serialize large App documents.
  const key = useMemo(
    () => html === undefined ? null : stableStringifyJson({ html, recipe }),
    [html, recipe],
  );
  const latest = useRef(admission);
  latest.current = admission;
  const entryRef = useRef<AdmissionEntry | null>(null);
  const [state, setState] = useState<{
    key: string;
    result?: PreparedSandboxView;
    error?: string;
  } | null>(null);
  const prepare = admission?.services.prepareSandboxView;
  const release = admission?.services.releaseSandboxView;

  useEffect(() => {
    if (!key || !prepare || !release || !latest.current?.request.html) return;
    let entry = entryRef.current;
    if (!entry || entry.disposed || entry.key !== key || entry.prepare !== prepare) {
      if (entry) releaseEntry(entry);
      const request: PrepareSandboxViewRequest = {
        ...latest.current.request,
        viewInstanceId: crypto.randomUUID(),
        hostOrigin: window.location.origin,
      };
      const controller = new AbortController();
      entry = {
        key, prepare, release, request, controller, users: 0, disposed: false,
        pending: prepare(request, controller.signal),
      };
      entryRef.current = entry;
    }
    const owned = entry;
    owned.users++;
    let active = true;
    const renew = () => {
      if (owned.disposed || !owned.result) return;
      owned.pending = owned.prepare(
        { ...owned.request, admissionId: owned.result.admissionId },
        owned.controller.signal,
      );
      void owned.pending.then(accept, fail);
    };
    const fail = (error: unknown) => {
      if (active && !owned.disposed) {
        const remaining = (owned.result?.expiresAt ?? 0) - Date.now();
        if (remaining > 0 && !(error instanceof SandboxViewAdmissionError && !error.retryable)) {
          owned.timer = setTimeout(renew, Math.min(30_000, remaining));
          return;
        }
        releaseEntry(owned);
        setState({ key, error: new SandboxViewAdmissionError().message });
      }
    };
    const accept = (result: PreparedSandboxView) => {
      owned.result = result;
      if (owned.disposed) {
        owned.controller.abort();
        void owned.release({ admissionId: result.admissionId }).catch(() => {
          // A cancelled preparation can finish remotely; its lease is bounded.
        });
        return;
      }
      if (!active) return;
      setState({ key, result });
      clearTimeout(owned.timer);
      clearTimeout(owned.expiryTimer);
      owned.expiryTimer = setTimeout(() => fail(new SandboxViewAdmissionError()), Math.max(1, result.expiresAt - Date.now()));
      owned.timer = setTimeout(renew, Math.max(1_000, Math.min(30 * 60_000, result.expiresAt - Date.now() - 60_000)));
    };
    void owned.pending.then(accept, fail);
    return () => {
      active = false;
      owned.users--;
      // React's effect rehearsal reattaches the same owner synchronously.
      queueMicrotask(() => { if (owned.users === 0) releaseEntry(owned); });
    };
  }, [key, prepare, release]);

  return {
    required: Boolean(admission),
    result: state?.key === key ? state.result : undefined,
    error: state?.key === key ? state.error : undefined,
  };
}
