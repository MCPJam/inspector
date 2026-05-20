import { useState } from "react";
import { Input } from "@mcpjam/design-system/input";
import { Switch } from "@mcpjam/design-system/switch";

/**
 * Per-server connection override. Mirrors the shape persisted in
 * `projectServerRefs` (and the legacy per-host `hostConfigServerRefs`):
 * headers map + numeric timeout in ms. `undefined` for the whole entry
 * means "use the host/project connection defaults"; a row with an
 * `authorization` header is forbidden and silently stripped.
 */
export type ServerConnectionOverride = {
  headersOverride?: Record<string, string>;
  requestTimeoutOverride?: number;
};

interface ServerOverrideEditorProps {
  override: ServerConnectionOverride | undefined;
  /**
   * `null` collapses the override entirely (caller deletes the row).
   * An object replaces it. Callers should treat the two as different
   * outcomes — null means "no overrides for this server."
   */
  onChange: (next: ServerConnectionOverride | null) => void;
  /**
   * When true, all interactive controls are disabled and the toggle is
   * inert. Used by the Project Settings section when the viewer lacks
   * `canManageProjectSettings` so they see the data without being able
   * to mutate it.
   */
  disabled?: boolean;
}

/**
 * Renders the per-server override switch + headers/timeout editor used
 * by the project Servers section. Lifted out of the now-removed
 * per-host `clients/redesigned/focus/ServersTab.tsx` so the project-
 * scoped server config UI (P5) can reuse it verbatim.
 *
 * Behavior contract:
 *   - "Overrides" switch off (`override === undefined`) → emit `null`.
 *   - "Overrides" switch on → emit `{ headersOverride: {} }` so the
 *     subsequent UI has a non-undefined object to mutate.
 *   - Empty header map + undefined timeout collapses back to `null` so
 *     no-content rows don't persist.
 *   - `authorization` header is dropped at edit time (case-insensitive)
 *     before the change reaches the backend. The mutation strips it
 *     server-side too — this is defense in depth, not the only barrier.
 */
export function ServerOverrideEditor({
  override,
  onChange,
  disabled = false,
}: ServerOverrideEditorProps) {
  const hasOverride = override !== undefined;
  const headers = override?.headersOverride ?? {};
  const timeout = override?.requestTimeoutOverride;

  const [addingHeader, setAddingHeader] = useState(false);
  const [draftKey, setDraftKey] = useState("");
  const [draftValue, setDraftValue] = useState("");

  const writeHeaders = (next: Record<string, string>) => {
    const cleaned: Record<string, string> = {};
    for (const [k, v] of Object.entries(next)) {
      if (k.trim() === "" || k.toLowerCase() === "authorization") continue;
      cleaned[k] = v;
    }
    const hasHeaders = Object.keys(cleaned).length > 0;
    const hasTimeout = timeout !== undefined;
    if (!hasHeaders && !hasTimeout) {
      onChange(null);
      return;
    }
    onChange({
      ...(hasHeaders ? { headersOverride: cleaned } : {}),
      ...(hasTimeout ? { requestTimeoutOverride: timeout } : {}),
    });
  };

  return (
    <div className="border-t border-border/50 px-3 py-3">
      <div className="flex flex-col gap-3">
        <div className="flex items-center justify-between gap-2">
          <span className="text-[12px] font-medium">Overrides</span>
          <Switch
            checked={hasOverride}
            disabled={disabled}
            onCheckedChange={(c) =>
              onChange(c ? { headersOverride: {} } : null)
            }
            aria-label="Enable overrides"
          />
        </div>

        {hasOverride ? (
          <>
            <div className="flex flex-col gap-1">
              <span className="text-[12px] font-medium">Timeout override</span>
              <div className="flex items-center gap-1.5">
                <Input
                  type="number"
                  min={1}
                  step={500}
                  disabled={disabled}
                  value={timeout ?? ""}
                  placeholder="(client default)"
                  onChange={(e) => {
                    const v = e.target.value;
                    const parsed = v === "" ? undefined : Number(v);
                    // Reject non-positive values the same way we reject
                    // empty/NaN — a 0 or negative connection timeout is
                    // meaningless and the connector validator rejects it.
                    const nextTimeout =
                      parsed === undefined ||
                      !Number.isFinite(parsed) ||
                      parsed <= 0
                        ? undefined
                        : parsed;
                    const hasHeaders = Object.keys(headers).length > 0;
                    if (nextTimeout === undefined && !hasHeaders) {
                      onChange(null);
                      return;
                    }
                    onChange({
                      ...(hasHeaders ? { headersOverride: headers } : {}),
                      ...(nextTimeout !== undefined
                        ? { requestTimeoutOverride: nextTimeout }
                        : {}),
                    });
                  }}
                  className="h-8 w-32 font-mono text-[11px]"
                />
                <span className="font-mono text-[11px] text-muted-foreground">
                  ms
                </span>
              </div>
            </div>

            <div className="flex flex-col gap-1">
              <span className="text-[12px] font-medium">Headers</span>
              {Object.keys(headers).length === 0 && !addingHeader ? (
                <p className="text-[11px] text-muted-foreground">
                  None — host defaults will apply.
                </p>
              ) : null}
              {Object.entries(headers).map(([key, val]) => (
                <div key={key} className="flex items-center gap-2">
                  <Input
                    value={key}
                    disabled
                    className="h-7 w-40 font-mono text-[11px]"
                  />
                  <Input
                    value={val}
                    disabled={disabled}
                    onChange={(e) => {
                      const next = { ...headers, [key]: e.target.value };
                      writeHeaders(next);
                    }}
                    className="h-7 flex-1 font-mono text-[11px]"
                  />
                  <button
                    type="button"
                    disabled={disabled}
                    onClick={() => {
                      const next = { ...headers };
                      delete next[key];
                      writeHeaders(next);
                    }}
                    className="text-[10.5px] text-muted-foreground underline-offset-2 hover:underline disabled:opacity-50"
                  >
                    remove
                  </button>
                </div>
              ))}
              {addingHeader ? (
                <div className="flex items-center gap-2">
                  <Input
                    autoFocus
                    placeholder="X-Header"
                    value={draftKey}
                    onChange={(e) => setDraftKey(e.target.value)}
                    className="h-7 w-40 font-mono text-[11px]"
                  />
                  <Input
                    placeholder="value"
                    value={draftValue}
                    onChange={(e) => setDraftValue(e.target.value)}
                    className="h-7 flex-1 font-mono text-[11px]"
                  />
                  <button
                    type="button"
                    onClick={() => {
                      const k = draftKey.trim();
                      if (k === "" || k.toLowerCase() === "authorization")
                        return;
                      writeHeaders({ ...headers, [k]: draftValue });
                      setDraftKey("");
                      setDraftValue("");
                      setAddingHeader(false);
                    }}
                    className="text-[10.5px] underline-offset-2 hover:underline"
                  >
                    add
                  </button>
                  <button
                    type="button"
                    onClick={() => {
                      setDraftKey("");
                      setDraftValue("");
                      setAddingHeader(false);
                    }}
                    className="text-[10.5px] text-muted-foreground underline-offset-2 hover:underline"
                  >
                    cancel
                  </button>
                </div>
              ) : (
                <button
                  type="button"
                  disabled={disabled}
                  onClick={() => setAddingHeader(true)}
                  className="inline-flex w-fit items-center gap-1 rounded-full border border-dashed border-border/70 px-2.5 py-0.5 text-[11px] text-muted-foreground hover:border-foreground/40 hover:text-foreground disabled:cursor-not-allowed disabled:opacity-50 disabled:hover:border-border/70 disabled:hover:text-muted-foreground"
                >
                  + Add header
                </button>
              )}
            </div>
          </>
        ) : null}
      </div>
    </div>
  );
}
