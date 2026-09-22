import { TESTER_LINK_RUNTIME_PATH_PATTERN } from "@/lib/tester-link-path";

/**
 * Detect same-origin embed of the public scenario runtime inside the app
 * (e.g. User Testing Preview iframe). Mirrors the exception in main.tsx
 * that allows the scenario tree to mount instead of IframeRouterError — both
 * match the shared tester-link path shape.
 */
export function isEmbeddedPreview(): boolean {
  try {
    if (window.self === window.top) {
      return false;
    }
    try {
      const sameOrigin =
        window.top!.location.origin === window.location.origin;
      return (
        sameOrigin &&
        TESTER_LINK_RUNTIME_PATH_PATTERN.test(window.location.pathname)
      );
    } catch {
      return false;
    }
  } catch {
    return false;
  }
}

/** Sync the scenario session name hash without growing history when embedded. */
export function syncScenarioSessionHash(slug: string): void {
  const targetHash = `#${slug}`;
  if (window.location.hash === targetHash) {
    return;
  }

  if (isEmbeddedPreview()) {
    window.history.replaceState(
      {},
      "",
      `${window.location.pathname}${window.location.search}${targetHash}`,
    );
    return;
  }

  window.location.hash = slug;
}

/** Bootstrap/recovery hash bookmark (standalone scenario uses root + hash). */
export function syncScenarioBootstrapHash(slug: string): void {
  const targetHash = `#${slug}`;
  if (window.location.hash === targetHash) {
    return;
  }

  if (isEmbeddedPreview()) {
    window.history.replaceState(
      {},
      "",
      `${window.location.pathname}${window.location.search}${targetHash}`,
    );
    return;
  }

  window.history.replaceState({}, "", `/${targetHash}`);
}
