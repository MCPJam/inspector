import { useEffect, useRef, useState } from "react";
import type { HostConfigInputV2 } from "@/lib/host-config-v2";

interface UseJsonDraftBufferOptions {
  draft: HostConfigInputV2;
  serialize: (draft: HostConfigInputV2) => unknown;
  applyParsedToDraft: (
    parsed: unknown,
    prev: HostConfigInputV2,
  ) => HostConfigInputV2 | null;
  onDraftChange: (
    updater: (prev: HostConfigInputV2) => HostConfigInputV2,
  ) => void;
}

/**
 * Buffer-and-sync helper for tabs that present `draft` as raw JSON.
 *
 * Initializes the editor text from the draft, and re-seeds when the parent
 * pushes a new draft — but only when the buffer hasn't been edited away
 * from what we last seeded from. This handles two failure modes at once:
 *
 *  1. Stale content when the parent passes a different host's draft (e.g.
 *     focus panel opened before the host fetch resolved, or a host-switch
 *     re-render that races setDraftConfig). The first render after
 *     remount snapshots whatever draft was in scope; this sync detects the
 *     subsequent push and re-seeds.
 *  2. Stomping user edits during incidental re-renders (validation tick,
 *     sibling-tab edits). Buffer has diverged from the last seed → keep it.
 *
 * Semantic (canonical-JSON) comparison so the user's chosen formatting
 * doesn't fool the detection.
 */
export function useJsonDraftBuffer({
  draft,
  serialize,
  applyParsedToDraft,
  onDraftChange,
}: UseJsonDraftBufferOptions) {
  const [content, setContent] = useState(() =>
    JSON.stringify(serialize(draft), null, 2),
  );
  const lastSeededDraftRef = useRef(draft);

  useEffect(() => {
    if (draft === lastSeededDraftRef.current) return;

    const lastSer = JSON.stringify(serialize(lastSeededDraftRef.current));
    const freshSer = JSON.stringify(serialize(draft));
    if (freshSer === lastSer) {
      // Reference changed but no semantic difference — advance the ref and
      // bail so we don't churn the editor for nothing.
      lastSeededDraftRef.current = draft;
      return;
    }

    let contentCanon: string | null;
    try {
      contentCanon = JSON.stringify(JSON.parse(content));
    } catch {
      contentCanon = null;
    }

    if (contentCanon === lastSer) {
      // Buffer is in sync with what we last seeded from → safe to re-seed.
      lastSeededDraftRef.current = draft;
      setContent(JSON.stringify(serialize(draft), null, 2));
    }
    // else: buffer has diverged (user has edits, or buffer is invalid JSON
    // mid-type) — keep it and leave the ref anchored so a future change
    // that returns to that seed can still resync.
  }, [draft, content, serialize]);

  const onRawChange = (next: string) => {
    setContent(next);
    let parsed: unknown;
    try {
      parsed = JSON.parse(next);
    } catch {
      return;
    }
    onDraftChange((prev) => applyParsedToDraft(parsed, prev) ?? prev);
  };

  return { content, onRawChange };
}
