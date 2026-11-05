import { useLayoutEffect, useMemo, useId, useRef } from "react";
import { useSignOutStore } from "@/stores/sign-out-store";
import { useComposerFormStore } from "./composer-form-store";

type ReturnPoint = {
  opener: HTMLElement | null;
  href: string;
  parentDialogs: HTMLElement[];
  composer?: { input: HTMLElement; slot: HTMLElement; workspaceId: string };
  // Inline owners retain the opener without blocking a modal from restoring it.
  owners: Set<string>;
  holders: Set<string>;
  canRestore?: () => boolean;
};
const points = new Map<string, ReturnPoint>();

function visible(element: HTMLElement) {
  if (!element.isConnected) return false;
  for (
    let node: HTMLElement | null = element;
    node;
    node = node.parentElement
  ) {
    const style = getComputedStyle(node);
    if (
      node.hidden ||
      node.inert ||
      style.display === "none" ||
      style.visibility === "hidden"
    )
      return false;
  }
  return true;
}
function parentDialogs(element: Element | null = document.activeElement) {
  const parents: HTMLElement[] = [];
  for (let node = element; node; node = node.parentElement)
    if (node instanceof HTMLElement && node.getAttribute("role") === "dialog")
      parents.push(node);
  return parents;
}
function composer(workspaceId?: string): ReturnPoint["composer"] {
  const candidates: NonNullable<ReturnPoint["composer"]>[] = [];
  for (const slot of useComposerFormStore.getState().slots) {
    if (workspaceId && slot.workspaceId !== workspaceId) continue;
    for (
      let root = slot.element.parentElement;
      root && root !== document.body;
      root = root.parentElement
    ) {
      const inputs = root.querySelectorAll<HTMLElement>(
        "[data-chat-composer-input]",
      );
      if (inputs.length > 1) break;
      if (inputs.length === 1) {
        candidates.push({
          input: inputs[0],
          slot: slot.element,
          workspaceId: slot.workspaceId,
        });
        break;
      }
    }
  }
  const unique = candidates.filter(
    (candidate, index) =>
      candidates.findIndex((row) => row.input === candidate.input) === index,
  );
  return unique.length === 1 ? unique[0] : undefined;
}

/** Programmatic dialogs have no Radix trigger. Keep one return point across
 * the initial dialog and the same form's retained-portal takeover. */
export function useFormDialogFocus(
  workspaceId?: string,
  fallbackWorkspaceId = workspaceId,
  open = true,
  canRestore?: () => boolean,
  returnTo?: HTMLElement,
) {
  const token = useId();
  const key = workspaceId ?? token;
  const activeScope = useRef(workspaceId);
  activeScope.current = workspaceId;
  const holder = useMemo<{ current: ReturnPoint }>(
    () => ({
      current: points.get(key) ?? {
        opener:
          returnTo ??
          (document.activeElement instanceof HTMLElement &&
          document.activeElement !== document.body &&
          document.activeElement !== document.documentElement &&
          document.activeElement.getAttribute("role") !== "dialog"
            ? document.activeElement
            : null),
        href: location.href,
        parentDialogs: parentDialogs(returnTo ?? document.activeElement),
        composer: composer(fallbackWorkspaceId) ?? composer(),
        owners: new Set(),
        holders: new Set(),
        canRestore,
      },
    }),
    [key, fallbackWorkspaceId, canRestore, returnTo],
  );
  const lastOpen = useRef(holder);
  if (open) lastOpen.current = holder;
  useLayoutEffect(() => {
    if (!open && !canRestore) return;
    const current = points.get(key) ?? holder.current;
    current.composer ??= holder.current.composer;
    current.canRestore ??= canRestore;
    holder.current = current;
    points.set(key, current);
    current.holders.add(token);
    if (open) current.owners.add(token);
    return () => {
      current.owners.delete(token);
      current.holders.delete(token);
      queueMicrotask(() => {
        if (!current.holders.size && points.get(key) === current)
          points.delete(key);
      });
    };
  }, [holder, key, token, open, canRestore]);
  return (event?: Event) => {
    event?.preventDefault();
    const current = lastOpen.current.current;
    current.owners.delete(token);
    if (
      (activeScope.current && activeScope.current !== workspaceId) ||
      current.canRestore?.() === false
    )
      return;
    if (
      location.href !== current.href ||
      useSignOutStore.getState().isSigningOut
    )
      return;
    // A newly shown dialog or a form moving between slots owns focus now.
    if ([...points.values()].some((row) => row.owners.size > 0)) return;
    if (current.parentDialogs.some((dialog) => !visible(dialog))) return;
    if (
      [...document.querySelectorAll<HTMLElement>('[role="dialog"]')].some(
        (dialog) => visible(dialog) && !current.parentDialogs.includes(dialog),
      )
    )
      return;
    const active = document.activeElement;
    if (
      active instanceof HTMLElement &&
      active !== document.body &&
      active !== document.documentElement &&
      !current.parentDialogs.includes(active) &&
      visible(active)
    )
      return;
    const insideParents = (element: HTMLElement) =>
      current.parentDialogs.every((dialog) => dialog.contains(element));
    if (
      current.opener &&
      visible(current.opener) &&
      insideParents(current.opener)
    ) {
      current.opener.focus({ preventScroll: true });
      if (document.activeElement === current.opener) return;
    }
    const fallback = current.composer;
    if (
      fallback &&
      visible(fallback.input) &&
      insideParents(fallback.input) &&
      useComposerFormStore
        .getState()
        .slots.some(
          (slot) =>
            slot.element === fallback.slot &&
            slot.workspaceId === fallback.workspaceId,
        )
    ) {
      fallback.input.focus({ preventScroll: true });
    }
  };
}
