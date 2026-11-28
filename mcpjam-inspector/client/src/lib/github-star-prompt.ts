import { useEffect, useSyncExternalStore } from "react";

/** One ask per browser, whichever flow triggers it first. */
export const GITHUB_STAR_PROMPT_STORAGE_KEY =
  "mcpjam:github-star-prompt:status";
const FIRST_USE_KEY_PREFIX = "mcpjam:github-star-prompt:first-use:";

export type GitHubStarPromptFeature = "oauth" | "xaa";

export type GitHubStarPromptRequest =
  | { trigger: "conformance"; reason: "completed"; hasAdvice: boolean }
  | {
      trigger: GitHubStarPromptFeature;
      reason: "completed" | "return_visit";
    };

let pending: GitHubStarPromptRequest | null = null;
const listeners = new Set<() => void>();

function setPending(next: GitHubStarPromptRequest | null): void {
  pending = next;
  for (const listener of listeners) listener();
}

function alreadyAsked(): boolean {
  try {
    return localStorage.getItem(GITHUB_STAR_PROMPT_STORAGE_KEY) !== null;
  } catch {
    // Without storage the ask can't be remembered and would repeat every run.
    return true;
  }
}

/** Asks the header Star button to show its prompt, unless this browser was asked before. */
export function requestGitHubStarPrompt(
  request: GitHubStarPromptRequest,
): void {
  if (pending || alreadyAsked()) return;
  setPending(request);
}

/** Remembers the ask, so it never shows again here. */
export function rememberGitHubStarPrompt(): void {
  try {
    localStorage.setItem(GITHUB_STAR_PROMPT_STORAGE_KEY, "asked");
  } catch {
    // Full storage: this prompt still closes; a later run may ask again.
  }
}

export function closeGitHubStarPrompt(): void {
  rememberGitHubStarPrompt();
  if (pending) setPending(null);
}

function localDay(): string {
  return new Date().toLocaleDateString("en-CA");
}

/** Notes the first day this browser used a debugger, for the return-visit ask. */
export function recordGitHubStarPromptUse(
  feature: GitHubStarPromptFeature,
): void {
  try {
    const key = FIRST_USE_KEY_PREFIX + feature;
    if (localStorage.getItem(key) === null)
      localStorage.setItem(key, localDay());
  } catch {
    // No storage: this browser never gets the return-visit ask.
  }
}

/** Asks when a debugger opens on a later day than the one it was first used. */
export function useGitHubStarPromptOnReturn(
  feature: GitHubStarPromptFeature,
): void {
  useEffect(() => {
    let firstUse: string | null = null;
    try {
      firstUse = localStorage.getItem(FIRST_USE_KEY_PREFIX + feature);
    } catch {
      return;
    }
    if (firstUse !== null && firstUse < localDay()) {
      requestGitHubStarPrompt({ trigger: feature, reason: "return_visit" });
    }
  }, [feature]);
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function useGitHubStarPrompt(): GitHubStarPromptRequest | null {
  return useSyncExternalStore(
    subscribe,
    () => pending,
    () => null,
  );
}
