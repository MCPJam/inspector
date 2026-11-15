const eventName = "mcpjam:task-bookmarks-changed";

export function notifyTaskBookmarksChanged(): void {
  if (typeof window !== "undefined") window.dispatchEvent(new Event(eventName));
}

export function subscribeTaskBookmarks(listener: () => void): () => void {
  window.addEventListener(eventName, listener);
  window.addEventListener("storage", listener);
  return () => {
    window.removeEventListener(eventName, listener);
    window.removeEventListener("storage", listener);
  };
}
