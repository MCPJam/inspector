import { useCallback, useEffect, useRef, useState } from "react";
import {
  acknowledgeLocalAutoApprove,
  fetchLocalHarnessAvailability,
  type LocalHarnessClientId,
} from "@/lib/local-harness-consent";

/**
 * Consent is checked against server state before a send unless the polled
 * availability already shows it; the chat route enforces it either way, and
 * its typed refusal reopens this dialog. The toggle is only a preference.
 */
export function useLocalAutoApproveConsent(args: {
  enabled: boolean;
  ready: boolean;
  projectId: string | null | undefined;
  harnessId: LocalHarnessClientId;
  scopeKey: string;
  acknowledged: boolean;
  onCancel: () => void;
  onAcknowledged: () => void;
}) {
  const [open, setOpen] = useState(false);
  const pending = useRef<Array<(allowed: boolean) => void>>([]);
  const currentScope = useRef(args.scopeKey);
  currentScope.current = args.scopeKey;
  const enabled = useRef(args.enabled);
  enabled.current = args.enabled;
  const acceptedScope = useRef<string | null>(null);
  const settle = useCallback((allowed: boolean) => {
    setOpen(false);
    for (const resolve of pending.current.splice(0)) resolve(allowed);
  }, []);
  useEffect(() => {
    acceptedScope.current = null;
    settle(false);
    return () => {
      for (const resolve of pending.current.splice(0)) resolve(false);
    };
  }, [args.scopeKey, settle]);
  useEffect(() => {
    if (!args.enabled) {
      settle(false);
      return;
    }
    if (
      args.ready &&
      !args.acknowledged &&
      acceptedScope.current !== args.scopeKey
    )
      setOpen(true);
  }, [args.enabled, args.ready, args.acknowledged, args.scopeKey, settle]);
  const request = useCallback(() => {
    setOpen(true);
    return new Promise<boolean>((resolve) => pending.current.push(resolve));
  }, []);
  const ensure = useCallback(async () => {
    if (!args.enabled || args.acknowledged) return true;
    if (!args.projectId) return false;
    const scope = args.scopeKey;
    const result = await fetchLocalHarnessAvailability(
      args.projectId,
      args.harnessId,
    );
    if (currentScope.current !== scope || !enabled.current) return false;
    if (!result.ok) throw new Error(result.message);
    if (result.availability.autoApproveAcknowledged === true) return true;
    return request();
  }, [
    args.enabled,
    args.acknowledged,
    args.projectId,
    args.scopeKey,
    args.harnessId,
    request,
  ]);
  const approve = useCallback(async () => {
    if (!args.projectId) throw new Error("Choose a project first");
    const scope = args.scopeKey;
    await acknowledgeLocalAutoApprove(args.projectId, args.harnessId);
    if (currentScope.current !== scope) {
      settle(false);
      return;
    }
    acceptedScope.current = scope;
    args.onAcknowledged();
    settle(true);
  }, [
    args.projectId,
    args.harnessId,
    args.scopeKey,
    args.onAcknowledged,
    settle,
  ]);
  const cancel = useCallback(() => {
    args.onCancel();
    settle(false);
  }, [args.onCancel, settle]);
  return { open, ensure, request, approve, cancel };
}
