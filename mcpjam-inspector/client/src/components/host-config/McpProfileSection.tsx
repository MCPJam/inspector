/**
 * Minimal editor for the optional `mcpProfile` envelope on a v2
 * hostConfig.
 *
 * Surfaces four nested sections, all collapsed by default behind a
 * single "Advanced — MCP profile" disclosure:
 *   1. Client identity        (initialize.clientInfo: name, version, title)
 *   2. Protocol versions      (initialize.supportedProtocolVersions, ordered)
 *   3. MCP Apps sandbox CSP   (apps.sandbox.csp: mode, restrictTo, deny)
 *   4. MCP Apps permissions   (apps.sandbox.permissions: mode, allow, deny)
 *
 * Plus a raw-JSON escape hatch scoped to the `extensions` slot only —
 * never the whole envelope. Letting users hand-edit the top-level
 * shape would defeat the structured validation the canonicalizer
 * performs (typoed `csp.mode`, blank protocol-version strings).
 *
 * **`undefined`-preservation contract.** "Reset to defaults" writes
 * `undefined` for that subsection, NOT an empty object. The backend
 * treats `undefined` / `{ profileVersion: 1 }` / `{ initialize: {} }`
 * as distinct canonical hashes (PR #269); we must NOT collapse them
 * by accidentally synthesizing an empty container on save.
 */

import { useEffect, useMemo, useRef, useState } from "react";
import { Button } from "@mcpjam/design-system/button";
import { Input } from "@mcpjam/design-system/input";
import { Label } from "@mcpjam/design-system/label";
import { Textarea } from "@mcpjam/design-system/textarea";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@mcpjam/design-system/select";
import type {
  CspDomainSet,
  HostConfigMcpProfileV1,
} from "@/lib/host-config-v2";

export interface McpProfileSectionProps {
  value: HostConfigMcpProfileV1 | undefined;
  onChange: (next: HostConfigMcpProfileV1 | undefined) => void;
  /**
   * Aggregated invalid signal — currently fires when the
   * `extensions` raw-JSON textareas hold un-parseable JSON. Parent
   * forms should disable Save while true.
   */
  onErrorChange?: (hasError: boolean) => void;
}

export function McpProfileSection({
  value,
  onChange,
  onErrorChange,
}: McpProfileSectionProps) {
  const [expanded, setExpanded] = useState<boolean>(value !== undefined);
  const [extensionsRaw, setExtensionsRaw] = useState<string>(() =>
    value?.extensions ? JSON.stringify(value.extensions, null, 2) : "",
  );
  const [extensionsError, setExtensionsError] = useState<string | null>(null);

  // External-change resync for the extensions textarea, mirroring
  // the ClientIdentitySubsection / ProtocolVersionsSubsection /
  // CommaListInput pattern. Without this, a backend save returning
  // canonicalized data (e.g. key-sorted JSON) or a parent-driven
  // value change (other than the explicit "Reset entire profile"
  // button, which clears local state directly) leaves the textarea
  // showing stale content while the actual profile holds different
  // extensions data. Compare by stable-stringified content so cosmetic
  // re-renders carrying the same data don't fight the user's
  // in-progress edit.
  const extensionsCanonicalKey = useMemo(
    () => (value?.extensions ? JSON.stringify(value.extensions) : ""),
    [value?.extensions],
  );
  const lastSyncedExtensionsRef = useRef<string>(extensionsCanonicalKey);
  useEffect(() => {
    if (extensionsCanonicalKey !== lastSyncedExtensionsRef.current) {
      lastSyncedExtensionsRef.current = extensionsCanonicalKey;
      setExtensionsRaw(
        value?.extensions ? JSON.stringify(value.extensions, null, 2) : "",
      );
      setExtensionsError(null);
    }
  }, [extensionsCanonicalKey, value?.extensions]);

  // Aggregated error reporting — currently only the raw-JSON
  // extensions field can be invalid (structured controls validate on
  // commit). Subsection helpers don't surface their own errors yet.
  const hasError = extensionsError !== null;

  // Notify parent on error-state transitions. `onErrorChange` is
  // intentionally omitted from deps — parent callers tend to pass
  // inline lambdas (fresh identity per render) which would cause
  // this effect to run on every render and flood with no-op
  // notifications. `hasError` is the signal that matters.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => onErrorChange?.(hasError), [hasError]);

  const profile = value;
  const updateProfile = (
    mutator: (draft: HostConfigMcpProfileV1) => HostConfigMcpProfileV1 | null,
  ) => {
    const base: HostConfigMcpProfileV1 = profile ?? { profileVersion: 1 };
    const next = mutator(cloneProfile(base));
    if (next === null) {
      // Subsection requested "reset whole envelope to undefined".
      onChange(undefined);
      return;
    }
    // If every subsection is now empty, fold the whole envelope back
    // to undefined so we never persist `{ profileVersion: 1 }` as
    // dead state — that hashes distinctly from `undefined` on the
    // backend and would look like "user opted in" forever.
    if (isEnvelopeEmpty(next)) {
      onChange(undefined);
      return;
    }
    onChange(next);
  };

  if (!expanded && profile === undefined) {
    return (
      <div className="grid gap-2">
        <Button
          type="button"
          variant="outline"
          size="sm"
          onClick={() => setExpanded(true)}
        >
          Advanced — MCP profile (client identity, protocol versions, sandbox
          policy)
        </Button>
      </div>
    );
  }

  return (
    <div className="grid gap-4 rounded-md border border-border/60 p-4">
      <div className="flex items-center justify-between">
        <div>
          <Label className="text-sm font-semibold">MCP profile (advanced)</Label>
          <p className="text-xs text-muted-foreground">
            Override the SDK&apos;s default <code>clientInfo</code>, supported
            protocol versions, and MCP Apps sandbox policy. Leave a section
            empty to fall back to the SDK / inspector default.
          </p>
        </div>
        {profile !== undefined ? (
          <Button
            type="button"
            variant="ghost"
            size="sm"
            onClick={() => {
              setExtensionsRaw("");
              setExtensionsError(null);
              // Pre-sync the resync ref so the upcoming external
              // value-change (profile → undefined) doesn't refire
              // the resync effect against this manual clear.
              lastSyncedExtensionsRef.current = "";
              onChange(undefined);
            }}
          >
            Reset entire profile
          </Button>
        ) : (
          <Button
            type="button"
            variant="ghost"
            size="sm"
            onClick={() => setExpanded(false)}
          >
            Hide
          </Button>
        )}
      </div>

      <ClientIdentitySubsection
        clientInfo={profile?.initialize?.clientInfo}
        onChange={(clientInfo) =>
          updateProfile((draft) => {
            const initialize = draft.initialize ?? {};
            if (clientInfo === undefined) {
              delete initialize.clientInfo;
            } else {
              initialize.clientInfo = clientInfo;
            }
            if (Object.keys(initialize).length === 0) {
              delete draft.initialize;
            } else {
              draft.initialize = initialize;
            }
            return draft;
          })
        }
      />

      <ProtocolVersionsSubsection
        versions={profile?.initialize?.supportedProtocolVersions}
        onChange={(versions) =>
          updateProfile((draft) => {
            const initialize = draft.initialize ?? {};
            // The subsection has already trimmed + filtered empties
            // (the parent of the subsection's local draft state is
            // what receives this call). `undefined` here means "no
            // versions persisted" — DON'T re-normalize and DON'T
            // store an empty array.
            if (versions === undefined || versions.length === 0) {
              delete initialize.supportedProtocolVersions;
            } else {
              initialize.supportedProtocolVersions = versions;
            }
            if (Object.keys(initialize).length === 0) {
              delete draft.initialize;
            } else {
              draft.initialize = initialize;
            }
            return draft;
          })
        }
      />

      <SandboxCspSubsection
        csp={profile?.apps?.sandbox?.csp}
        onChange={(csp) =>
          updateProfile((draft) => {
            const apps = draft.apps ?? {};
            const sandbox = apps.sandbox ?? {};
            if (csp === undefined) {
              delete sandbox.csp;
            } else {
              sandbox.csp = csp;
            }
            if (Object.keys(sandbox).length === 0) {
              delete apps.sandbox;
            } else {
              apps.sandbox = sandbox;
            }
            if (Object.keys(apps).length === 0) {
              delete draft.apps;
            } else {
              draft.apps = apps;
            }
            return draft;
          })
        }
      />

      <SandboxPermissionsSubsection
        permissions={profile?.apps?.sandbox?.permissions}
        onChange={(permissions) =>
          updateProfile((draft) => {
            const apps = draft.apps ?? {};
            const sandbox = apps.sandbox ?? {};
            if (permissions === undefined) {
              delete sandbox.permissions;
            } else {
              sandbox.permissions = permissions;
            }
            if (Object.keys(sandbox).length === 0) {
              delete apps.sandbox;
            } else {
              apps.sandbox = sandbox;
            }
            if (Object.keys(apps).length === 0) {
              delete draft.apps;
            } else {
              draft.apps = apps;
            }
            return draft;
          })
        }
      />

      <div className="grid gap-2">
        <Label className="text-xs font-medium">
          Extensions (raw JSON — for future-spec fields only)
        </Label>
        <Textarea
          value={extensionsRaw}
          placeholder="{}"
          rows={3}
          onChange={(e) => {
            const next = e.target.value;
            setExtensionsRaw(next);
            if (next.trim() === "") {
              setExtensionsError(null);
              // Pre-sync the resync ref to match the about-to-be-
              // published canonical content. The parent's
              // updateProfile call may re-render this component with
              // an externally-canonicalized JSON; without this
              // pre-sync the resync effect would race the user's
              // typing.
              lastSyncedExtensionsRef.current = "";
              updateProfile((draft) => {
                delete draft.extensions;
                return draft;
              });
              return;
            }
            try {
              const parsed = JSON.parse(next);
              if (
                parsed === null ||
                typeof parsed !== "object" ||
                Array.isArray(parsed)
              ) {
                setExtensionsError("Must be a JSON object");
                return;
              }
              setExtensionsError(null);
              lastSyncedExtensionsRef.current = JSON.stringify(parsed);
              updateProfile((draft) => {
                draft.extensions = parsed as Record<string, unknown>;
                return draft;
              });
            } catch (err) {
              setExtensionsError(
                err instanceof Error ? err.message : "Invalid JSON",
              );
            }
          }}
        />
        {extensionsError ? (
          <p className="text-xs text-destructive">{extensionsError}</p>
        ) : null}
      </div>
    </div>
  );
}

// -----------------------------------------------------------------------------
// Subsections
// -----------------------------------------------------------------------------

function ClientIdentitySubsection({
  clientInfo,
  onChange,
}: {
  clientInfo: Record<string, unknown> | undefined;
  onChange: (next: Record<string, unknown> | undefined) => void;
}) {
  // Local draft state, NOT derived directly from props.
  //
  // Why this matters: with controlled inputs reading `clientInfo?.name`
  // directly, the "swallow keystroke" pattern (return early when only
  // one of name/version is non-empty) is impossible — React always
  // re-renders the input with the prop value, so a user typing the
  // first character of `name` on a brand-new profile would see their
  // keystroke vanish before they can type the second field. The local
  // draft preserves what the user typed; we only call `onChange`
  // upstream when the validity gate (both name+version non-empty)
  // is satisfied or when both fields are cleared.
  const initialDraft = useMemo(
    () => ({
      name: typeof clientInfo?.name === "string" ? clientInfo.name : "",
      version:
        typeof clientInfo?.version === "string" ? clientInfo.version : "",
      title: typeof clientInfo?.title === "string" ? clientInfo.title : "",
    }),
    // We only want to re-seed when the persisted identity actually
    // changes — not on every parent re-render. JSON serialization is
    // the cheapest stable key for these three string fields.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [
      typeof clientInfo?.name === "string" ? clientInfo.name : null,
      typeof clientInfo?.version === "string" ? clientInfo.version : null,
      typeof clientInfo?.title === "string" ? clientInfo.title : null,
    ],
  );
  const [draft, setDraft] = useState(initialDraft);
  // Re-sync local draft when the persisted identity changes from the
  // outside (e.g. "Reset entire profile" button, or external save
  // round-trip with different values).
  const lastSyncedRef = useRef(initialDraft);
  useEffect(() => {
    if (
      initialDraft.name !== lastSyncedRef.current.name ||
      initialDraft.version !== lastSyncedRef.current.version ||
      initialDraft.title !== lastSyncedRef.current.title
    ) {
      lastSyncedRef.current = initialDraft;
      setDraft(initialDraft);
    }
  }, [initialDraft]);

  const commit = (next: { name: string; version: string; title: string }) => {
    // Update local draft FIRST so the controlled inputs render the
    // user's typed characters even when we don't persist upstream.
    setDraft(next);
    // Backend soft-validates: when clientInfo is set, BOTH name and
    // version must be non-empty (PR #269 canonicalizer rejects
    // half-typed identities at write time). Mirror that here:
    //   - both empty   → fold the subsection back to `undefined`.
    //   - one empty    → hold local draft, DON'T call upstream onChange
    //                    (the previous valid value stays persisted; the
    //                    user sees their typing in the inputs).
    //   - both filled  → commit { name, version, title?, ...extras }.
    const trimmedName = next.name.trim();
    const trimmedVersion = next.version.trim();
    if (trimmedName === "" && trimmedVersion === "") {
      lastSyncedRef.current = next;
      onChange(undefined);
      return;
    }
    if (trimmedName === "" || trimmedVersion === "") {
      // Partial state: visible in local draft, not yet persisted.
      return;
    }
    const out: Record<string, unknown> = {
      name: trimmedName,
      version: trimmedVersion,
    };
    if (next.title.trim() !== "") out.title = next.title.trim();
    // Preserve extra fields the user might have round-tripped through
    // the API (future spec additions). Drop our three known ones
    // first so we don't double-write.
    if (clientInfo) {
      for (const [k, v] of Object.entries(clientInfo)) {
        if (k === "name" || k === "version" || k === "title") continue;
        out[k] = v;
      }
    }
    lastSyncedRef.current = next;
    onChange(out);
  };

  return (
    <div className="grid gap-2">
      <Label className="text-xs font-medium">
        Client identity (sent in <code>initialize.clientInfo</code>)
      </Label>
      <p className="text-xs text-amber-600 dark:text-amber-400">
        Saved to your hostConfig but not yet applied at the MCP wire —
        per-request <code>MCPClientManager</code> threading lands in a
        follow-up PR. Servers will continue to see the inspector
        default identity until then.
      </p>
      <div className="grid grid-cols-3 gap-2">
        <Input
          aria-label="Client name"
          placeholder="name (e.g. chatgpt)"
          value={draft.name}
          onChange={(e) =>
            commit({
              name: e.target.value,
              version: draft.version,
              title: draft.title,
            })
          }
        />
        <Input
          aria-label="Client version"
          placeholder="version (e.g. 1.0)"
          value={draft.version}
          onChange={(e) =>
            commit({
              name: draft.name,
              version: e.target.value,
              title: draft.title,
            })
          }
        />
        <Input
          aria-label="Client title (optional)"
          placeholder="title (optional)"
          value={draft.title}
          onChange={(e) =>
            commit({
              name: draft.name,
              version: draft.version,
              title: e.target.value,
            })
          }
        />
      </div>
      {(draft.name.trim() !== "" && draft.version.trim() === "") ||
      (draft.name.trim() === "" && draft.version.trim() !== "") ? (
        <p className="text-xs text-amber-600 dark:text-amber-400">
          Both <code>name</code> and <code>version</code> are required when
          setting <code>clientInfo</code> — keep typing to save.
        </p>
      ) : null}
      {clientInfo !== undefined ? (
        <Button
          type="button"
          variant="link"
          size="sm"
          className="-ml-3 justify-start text-xs"
          onClick={() => {
            setDraft({ name: "", version: "", title: "" });
            lastSyncedRef.current = { name: "", version: "", title: "" };
            onChange(undefined);
          }}
        >
          Reset to inspector default
        </Button>
      ) : (
        <p className="text-xs text-muted-foreground">
          Using SDK default (
          <code>mcpjam-inspector</code> at the inspector&apos;s build version).
        </p>
      )}
    </div>
  );
}

function ProtocolVersionsSubsection({
  versions,
  onChange,
}: {
  versions: string[] | undefined;
  onChange: (next: string[] | undefined) => void;
}) {
  // Local draft state so an "Add version" click can render an empty
  // row before the user types into it. If we routed every change
  // through the parent's onChange (which trims + filters empties for
  // canonicalizer compliance), the empty row would be stripped
  // immediately and the user could never start a new entry. Local
  // state preserves the in-progress UI; we only publish the cleaned
  // list upstream when it would actually persist meaningfully.
  const [rows, setRows] = useState<string[]>(() => versions ?? []);

  // Re-sync when the persisted versions change from outside (e.g.
  // "Reset entire profile"). Compare by canonical content so we
  // don't re-seed on parent re-renders carrying the same array
  // reference rewrap.
  const persistedJson = useMemo(
    () => JSON.stringify(versions ?? null),
    [versions],
  );
  const lastSyncedJsonRef = useRef<string>(persistedJson);
  useEffect(() => {
    if (persistedJson !== lastSyncedJsonRef.current) {
      lastSyncedJsonRef.current = persistedJson;
      setRows(versions ?? []);
    }
  }, [persistedJson, versions]);

  const commit = (next: string[]) => {
    setRows(next);
    // Persist the canonicalizer-safe subset (trim + drop empties).
    // The local UI keeps in-progress empties; the upstream parent
    // only ever sees clean entries, matching the backend's
    // non-empty / non-blank invariant.
    const cleaned = next.map((v) => v.trim()).filter((v) => v.length > 0);
    const out = cleaned.length === 0 ? undefined : cleaned;
    // Pre-sync the ref to the value we're about to send so the
    // resync effect doesn't fire and clobber local in-progress
    // empty rows when the parent re-renders with the cleaned subset.
    lastSyncedJsonRef.current = JSON.stringify(out ?? null);
    onChange(out);
  };

  return (
    <div className="grid gap-2">
      <Label className="text-xs font-medium">
        Supported protocol versions (ordered — first is proposed)
      </Label>
      <p className="text-xs text-amber-600 dark:text-amber-400">
        Saved to your hostConfig but not yet applied at the MCP wire —
        per-request <code>MCPClientManager</code> threading lands in a
        follow-up PR. Initialize negotiation will continue to use the
        SDK&apos;s defaults until then.
      </p>
      {rows.length > 0 ? (
        <div className="grid gap-1">
          {rows.map((v, i) => (
            <div key={i} className="flex items-center gap-2">
              <span className="w-8 text-xs text-muted-foreground">
                {i === 0 ? "(proposed)" : `#${i + 1}`}
              </span>
              <Input
                value={v}
                aria-label={`Protocol version ${i + 1}`}
                onChange={(e) => {
                  const next = [...rows];
                  next[i] = e.target.value;
                  commit(next);
                }}
              />
              <Button
                type="button"
                variant="ghost"
                size="sm"
                disabled={i === 0}
                onClick={() => {
                  const next = [...rows];
                  [next[i - 1], next[i]] = [next[i]!, next[i - 1]!];
                  commit(next);
                }}
              >
                ↑
              </Button>
              <Button
                type="button"
                variant="ghost"
                size="sm"
                disabled={i === rows.length - 1}
                onClick={() => {
                  const next = [...rows];
                  [next[i + 1], next[i]] = [next[i]!, next[i + 1]!];
                  commit(next);
                }}
              >
                ↓
              </Button>
              <Button
                type="button"
                variant="ghost"
                size="sm"
                onClick={() => commit(rows.filter((_, j) => j !== i))}
              >
                Remove
              </Button>
            </div>
          ))}
        </div>
      ) : (
        <p className="text-xs text-muted-foreground">
          Using SDK default (latest supported version).
        </p>
      )}
      <Button
        type="button"
        variant="outline"
        size="sm"
        className="w-fit"
        // Local-state-only push of an empty row. The commit() call
        // would strip the empty before persisting it upstream, so
        // we skip commit() here and just grow the local rows array.
        // The first typed character in the new row will route
        // through the Input's onChange → commit() and persist.
        onClick={() => setRows([...rows, ""])}
      >
        + Add version
      </Button>
      {rows.length > 0 ? (
        <Button
          type="button"
          variant="link"
          size="sm"
          className="-ml-3 w-fit justify-start text-xs"
          onClick={() => {
            // Clear local rows AND publish undefined. If the user
            // had only local-only empty rows (added via "+ Add
            // version" without typing anything), the parent prop is
            // already undefined — calling onChange alone wouldn't
            // change the prop, the resync effect wouldn't fire, and
            // the stale empty rows would stay visible. Setting local
            // state and pre-syncing the ref to the new "no
            // versions" state covers both cases.
            setRows([]);
            lastSyncedJsonRef.current = JSON.stringify(null);
            onChange(undefined);
          }}
        >
          Reset to inspector default
        </Button>
      ) : null}
    </div>
  );
}

type SandboxCsp = NonNullable<
  NonNullable<HostConfigMcpProfileV1["apps"]>["sandbox"]
>["csp"];

function SandboxCspSubsection({
  csp,
  onChange,
}: {
  csp: SandboxCsp;
  onChange: (next: SandboxCsp) => void;
}) {
  const mode = csp?.mode;

  // `draft` is always a fresh non-undefined object; the mutator may
  // assign/clear sub-fields on it. We collapse to `undefined` at the
  // end when the result is functionally empty so we don't persist
  // `{}` (which would hash distinctly from "field absent" on the
  // backend and look like "user opted in to a CSP block" forever).
  const update = (
    mutator: (draft: NonNullable<SandboxCsp>) => NonNullable<SandboxCsp>,
  ) => {
    const draft: NonNullable<SandboxCsp> = csp
      ? (JSON.parse(JSON.stringify(csp)) as NonNullable<SandboxCsp>)
      : {};
    const next = mutator(draft);
    if (
      next.mode === undefined &&
      isCspDomainSetEmpty(next.restrictTo) &&
      isCspDomainSetEmpty(next.deny) &&
      next.extensions === undefined
    ) {
      onChange(undefined);
      return;
    }
    onChange(next);
  };

  return (
    <div className="grid gap-2">
      <Label className="text-xs font-medium">
        MCP Apps sandbox CSP (intersect / subtract on top of declared)
      </Label>
      <div className="flex items-center gap-2">
        <span className="text-xs text-muted-foreground">Mode:</span>
        <Select
          value={mode ?? "__default__"}
          onValueChange={(v) =>
            update((draft) => {
              if (v === "__default__") delete draft.mode;
              else draft.mode = v as "host-default" | "declared" | "relaxed";
              return draft;
            })
          }
        >
          <SelectTrigger className="h-8 w-fit min-w-[160px]">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="__default__">(default: declared)</SelectItem>
            <SelectItem value="declared">declared</SelectItem>
            <SelectItem value="host-default">host-default</SelectItem>
            <SelectItem value="relaxed">relaxed</SelectItem>
          </SelectContent>
        </Select>
      </div>
      <DomainSetEditor
        label="restrictTo — intersection, never adds undeclared domains"
        value={csp?.restrictTo}
        onChange={(next) =>
          update((draft) => {
            if (!next || isCspDomainSetEmpty(next)) delete draft.restrictTo;
            else draft.restrictTo = next;
            return draft;
          })
        }
      />
      <DomainSetEditor
        label="deny — subtraction, always wins"
        value={csp?.deny}
        onChange={(next) =>
          update((draft) => {
            if (!next || isCspDomainSetEmpty(next)) delete draft.deny;
            else draft.deny = next;
            return draft;
          })
        }
      />
    </div>
  );
}

type SandboxPermissions = NonNullable<
  NonNullable<HostConfigMcpProfileV1["apps"]>["sandbox"]
>["permissions"];

function SandboxPermissionsSubsection({
  permissions,
  onChange,
}: {
  permissions: SandboxPermissions;
  onChange: (next: SandboxPermissions) => void;
}) {
  const mode = permissions?.mode;
  const allow = permissions?.allow ?? {};
  const deny = permissions?.deny ?? [];

  const update = (
    mutator: (
      draft: NonNullable<SandboxPermissions>,
    ) => NonNullable<SandboxPermissions>,
  ) => {
    const draft: NonNullable<SandboxPermissions> = permissions
      ? (JSON.parse(JSON.stringify(permissions)) as NonNullable<SandboxPermissions>)
      : {};
    const next = mutator(draft);
    const empty =
      next.mode === undefined &&
      (next.allow === undefined || Object.keys(next.allow).length === 0) &&
      (next.deny === undefined || next.deny.length === 0) &&
      next.extensions === undefined;
    if (empty) {
      onChange(undefined);
      return;
    }
    onChange(next);
  };

  const knownPermissions = ["camera", "microphone", "geolocation", "clipboardWrite"];

  return (
    <div className="grid gap-2">
      <Label className="text-xs font-medium">
        MCP Apps sandbox permissions (resource declaration is the ceiling)
      </Label>
      <div className="flex items-center gap-2">
        <span className="text-xs text-muted-foreground">Mode:</span>
        <Select
          value={mode ?? "__default__"}
          onValueChange={(v) =>
            update((draft) => {
              if (v === "__default__") delete draft.mode;
              else
                draft.mode = v as
                  | "resource-declared"
                  | "deny-all"
                  | "custom";
              return draft;
            })
          }
        >
          <SelectTrigger className="h-8 w-fit min-w-[180px]">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="__default__">
              (default: resource-declared)
            </SelectItem>
            <SelectItem value="resource-declared">resource-declared</SelectItem>
            <SelectItem value="deny-all">deny-all</SelectItem>
            <SelectItem value="custom">custom</SelectItem>
          </SelectContent>
        </Select>
      </div>
      <div className="grid gap-1">
        <span className="text-xs text-muted-foreground">
          allow (used in <code>custom</code> mode):
        </span>
        {knownPermissions.map((p) => (
          <label key={p} className="flex items-center gap-2 text-xs">
            <input
              type="checkbox"
              checked={allow[p] === true}
              onChange={(e) =>
                update((draft) => {
                  const a = { ...(draft.allow ?? {}) };
                  if (e.target.checked) a[p] = true;
                  else delete a[p];
                  if (Object.keys(a).length === 0) delete draft.allow;
                  else draft.allow = a;
                  return draft;
                })
              }
            />
            {p}
          </label>
        ))}
      </div>
      <div className="grid gap-1">
        <span className="text-xs text-muted-foreground">
          deny (comma-separated permission names — always wins):
        </span>
        <CommaListInput
          ariaLabel="Permissions deny list"
          placeholder="e.g. camera, microphone"
          value={deny}
          onCommit={(next) =>
            update((draft) => {
              if (next.length === 0) delete draft.deny;
              else draft.deny = next;
              return draft;
            })
          }
        />
      </div>
    </div>
  );
}

function DomainSetEditor({
  label,
  value,
  onChange,
}: {
  label: string;
  value: CspDomainSet | undefined;
  onChange: (next: CspDomainSet | undefined) => void;
}) {
  const directives: Array<{ key: keyof CspDomainSet; placeholder: string }> = [
    { key: "connectDomains", placeholder: "connect-src (e.g. api.example.com)" },
    {
      key: "resourceDomains",
      placeholder: "img/script/style/font-src",
    },
    { key: "frameDomains", placeholder: "frame-src" },
    { key: "baseUriDomains", placeholder: "base-uri" },
  ];

  return (
    <div className="grid gap-1">
      <span className="text-xs text-muted-foreground">{label}</span>
      <div className="grid grid-cols-2 gap-2">
        {directives.map(({ key, placeholder }) => {
          const list = value?.[key] ?? [];
          return (
            <CommaListInput
              key={key}
              ariaLabel={`CSP ${key}`}
              placeholder={placeholder}
              value={list}
              onCommit={(next) => {
                const draft: CspDomainSet = { ...(value ?? {}) };
                if (next.length === 0) delete draft[key];
                else draft[key] = next;
                onChange(isCspDomainSetEmpty(draft) ? undefined : draft);
              }}
            />
          );
        })}
      </div>
    </div>
  );
}

/**
 * Single-line input bound to a comma-separated string list, with the
 * "swallowed comma" UX bug fixed. Routing every keystroke through a
 * `split → trim → filter` round-trip drops the trailing empty token
 * the instant the user types a comma, so the comma disappears under
 * the caret. Same shape of fix as `ProtocolVersionsSubsection` and
 * `ClientIdentitySubsection`: hold the raw typed string locally,
 * normalize and publish upstream only on blur (and when the
 * canonical content sourced from props changes).
 */
function CommaListInput({
  value,
  ariaLabel,
  placeholder,
  onCommit,
}: {
  /** Canonical list from upstream (normalized — no empty strings). */
  value: string[];
  ariaLabel: string;
  placeholder?: string;
  /** Receives the normalized list. Empty array means "no entries." */
  onCommit: (next: string[]) => void;
}) {
  // Local raw text — what the user sees while typing.
  const [draft, setDraft] = useState<string>(() => value.join(", "));
  // Re-seed when the canonical content actually changes (e.g. an
  // external reset or a sibling save that mutated the list). The
  // sort prevents a cosmetic reorder from triggering re-sync.
  const persistedKey = useMemo(() => [...value].sort().join("\n"), [value]);
  const lastSyncedRef = useRef<string>(persistedKey);
  useEffect(() => {
    if (persistedKey !== lastSyncedRef.current) {
      lastSyncedRef.current = persistedKey;
      setDraft(value.join(", "));
    }
  }, [persistedKey, value]);

  const commit = () => {
    const next = draft
      .split(",")
      .map((s) => s.trim())
      .filter((s) => s !== "");
    // Pre-sync the ref to the value we're publishing so the resync
    // effect doesn't fire on the parent's re-render and overwrite
    // the user's input field with the joined-and-resorted output.
    lastSyncedRef.current = [...next].sort().join("\n");
    onCommit(next);
  };

  return (
    <Input
      aria-label={ariaLabel}
      placeholder={placeholder}
      value={draft}
      onChange={(e) => setDraft(e.target.value)}
      onBlur={commit}
    />
  );
}

// -----------------------------------------------------------------------------
// Helpers
// -----------------------------------------------------------------------------

function cloneProfile(p: HostConfigMcpProfileV1): HostConfigMcpProfileV1 {
  // structuredClone has wider runtime support than this PR targets;
  // JSON cloning is safe — the profile is a finite JSON-serializable
  // envelope by construction.
  return JSON.parse(JSON.stringify(p)) as HostConfigMcpProfileV1;
}

function isEnvelopeEmpty(p: HostConfigMcpProfileV1): boolean {
  if (p.initialize !== undefined && Object.keys(p.initialize).length > 0) {
    return false;
  }
  if (p.apps !== undefined && p.apps.sandbox !== undefined) {
    const sandbox = p.apps.sandbox;
    if (sandbox.csp !== undefined || sandbox.permissions !== undefined) {
      return false;
    }
  }
  if (p.extensions !== undefined) return false;
  return true;
}

function isCspDomainSetEmpty(set: CspDomainSet | undefined): boolean {
  if (!set) return true;
  return (
    (set.connectDomains?.length ?? 0) === 0 &&
    (set.resourceDomains?.length ?? 0) === 0 &&
    (set.frameDomains?.length ?? 0) === 0 &&
    (set.baseUriDomains?.length ?? 0) === 0
  );
}

