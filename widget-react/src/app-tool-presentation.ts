import { useCallback, useLayoutEffect, useRef } from "react";
import type { AppInstance, AppToolsRegistryState } from "./app-tools-registry";

/** Host presentation only; never changes tool routing or grants authority. */
export interface AppToolPresentation {
  label?: string;
  visibility?: "visible" | "hidden";
}

export function updateAppPresentation(
  instances: Map<string, AppInstance>,
  bridgeId: string,
  presentation: AppToolPresentation,
) {
  const instance = instances.get(bridgeId);
  if (
    !instance ||
    JSON.stringify(instance.presentation) === JSON.stringify(presentation)
  )
    return instances;
  const next = new Map(instances);
  next.set(bridgeId, { ...instance, presentation });
  return next;
}

/** Hidden ancestors matter; being below the viewport does not hide an App. */
export function appToolPresentation(
  label: string | undefined,
  element: HTMLElement | null,
): AppToolPresentation {
  const presentation: AppToolPresentation = label
    ? { label: label.replace(/\s+/g, " ").trim().slice(0, 200) }
    : {};
  if (!element) return presentation;
  presentation.visibility = element.isConnected ? "visible" : "hidden";
  const visibility = getComputedStyle(element).visibility;
  if (visibility === "hidden" || visibility === "collapse")
    presentation.visibility = "hidden";
  for (
    let node: HTMLElement | null = element;
    node;
    node = node.parentElement
  ) {
    const style = getComputedStyle(node);
    if (
      node.hidden ||
      style.display === "none" ||
      style.contentVisibility === "hidden"
    ) {
      presentation.visibility = "hidden";
      break;
    }
  }
  return presentation;
}

export function useAppToolPresentation(
  registry: { getState: () => AppToolsRegistryState },
  bridgeId: string | null,
  label: string | undefined,
  getElement: () => HTMLElement | null,
) {
  const current = useRef({ label, getElement });
  current.current = { label, getElement };
  const read = useCallback(
    () =>
      appToolPresentation(current.current.label, current.current.getElement()),
    [],
  );
  useLayoutEffect(() => {
    if (!bridgeId) return;
    const observer = new MutationObserver(() => update());
    function update() {
      observer.disconnect();
      registry.getState().updatePresentation(bridgeId!, read());
      for (
        let node = current.current.getElement();
        node;
        node = node.parentElement
      )
        observer.observe(node, {
          attributes: true,
          attributeFilter: ["hidden", "class", "style"],
          childList: true,
        });
    }
    update();
    return () => observer.disconnect();
  });
  return read;
}
