import { TESTER_LINK_RUNTIME_PATH_PATTERN } from "@/lib/tester-link-path";

/**
 * Detect same-origin embed of the public chatbox runtime inside the app
 * (e.g. User Testing Preview iframe). Mirrors the exception in main.tsx
 * that allows the chatbox tree to mount instead of IframeRouterError — both
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

/** Sync the chatbox session name hash without growing history when embedded. */
export function syncChatboxSessionHash(slug: string): void {
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

/** Bootstrap/recovery hash bookmark (standalone chatbox uses root + hash). */
export function syncChatboxBootstrapHash(slug: string): void {
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
