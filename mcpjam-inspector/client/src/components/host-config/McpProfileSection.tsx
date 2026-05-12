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

import { useState } from "react";
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

  // Aggregated error reporting — currently only the raw-JSON
  // extensions field can be invalid (structured controls validate on
  // commit). Subsection helpers don't surface their own errors yet.
  const hasError = extensionsError !== null;

  // Notify parent on error-state transitions.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useStateEffect(() => onErrorChange?.(hasError), [hasError]);

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
            if (versions === undefined) {
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
  const name = typeof clientInfo?.name === "string" ? clientInfo.name : "";
  const version =
    typeof clientInfo?.version === "string" ? clientInfo.version : "";
  const title =
    typeof clientInfo?.title === "string" ? clientInfo.title : "";

  const commit = (next: { name: string; version: string; title: string }) => {
    // Backend soft-validates: when clientInfo is set, both name and
    // version must be non-empty. If the user clears both, fold the
    // whole subsection back to undefined so we don't persist a
    // half-typed identity that would fail canonicalization on save.
    if (next.name.trim() === "" && next.version.trim() === "") {
      onChange(undefined);
      return;
    }
    const out: Record<string, unknown> = {};
    if (next.name.trim() !== "") out.name = next.name.trim();
    if (next.version.trim() !== "") out.version = next.version.trim();
    if (next.title.trim() !== "") out.title = next.title.trim();
    // Preserve any extra fields the user might have round-tripped
    // through the API (future spec additions). Drop our three
    // known ones first so we don't double-write.
    if (clientInfo) {
      for (const [k, v] of Object.entries(clientInfo)) {
        if (k === "name" || k === "version" || k === "title") continue;
        out[k] = v;
      }
    }
    onChange(out);
  };

  return (
    <div className="grid gap-2">
      <Label className="text-xs font-medium">
        Client identity (sent in <code>initialize.clientInfo</code>)
      </Label>
      <div className="grid grid-cols-3 gap-2">
        <Input
          aria-label="Client name"
          placeholder="name (e.g. chatgpt)"
          value={name}
          onChange={(e) => commit({ name: e.target.value, version, title })}
        />
        <Input
          aria-label="Client version"
          placeholder="version (e.g. 1.0)"
          value={version}
          onChange={(e) =>
            commit({ name, version: e.target.value, title })
          }
        />
        <Input
          aria-label="Client title (optional)"
          placeholder="title (optional)"
          value={title}
          onChange={(e) => commit({ name, version, title: e.target.value })}
        />
      </div>
      {clientInfo !== undefined ? (
        <Button
          type="button"
          variant="link"
          size="sm"
          className="-ml-3 justify-start text-xs"
          onClick={() => onChange(undefined)}
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
  // Editing is a single textarea — one version per line. Order is
  // semantic (first = proposed in initialize), so we render rows in
  // file order and use up/down arrows to reorder. A textarea is good
  // enough for v1; a richer reorder UI is a v2 polish.
  const rows = versions ?? [];

  return (
    <div className="grid gap-2">
      <Label className="text-xs font-medium">
        Supported protocol versions (ordered — first is proposed)
      </Label>
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
                  onChange(next);
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
                  onChange(next);
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
                  onChange(next);
                }}
              >
                ↓
              </Button>
              <Button
                type="button"
                variant="ghost"
                size="sm"
                onClick={() => {
                  const next = rows.filter((_, j) => j !== i);
                  onChange(next.length === 0 ? undefined : next);
                }}
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
        onClick={() => onChange([...rows, ""])}
      >
        + Add version
      </Button>
      {rows.length > 0 ? (
        <Button
          type="button"
          variant="link"
          size="sm"
          className="-ml-3 w-fit justify-start text-xs"
          onClick={() => onChange(undefined)}
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
        <Input
          value={deny.join(", ")}
          placeholder="e.g. camera, microphone"
          onChange={(e) => {
            const next = e.target.value
              .split(",")
              .map((s) => s.trim())
              .filter((s) => s !== "");
            update((draft) => {
              if (next.length === 0) delete draft.deny;
              else draft.deny = next;
              return draft;
            });
          }}
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
            <Input
              key={key}
              aria-label={`CSP ${key}`}
              value={list.join(", ")}
              placeholder={placeholder}
              onChange={(e) => {
                const next = e.target.value
                  .split(",")
                  .map((s) => s.trim())
                  .filter((s) => s !== "");
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

// Tiny `useEffect`-shaped helper that avoids the import surface for
// React's `useEffect`. Mirrors useEffect semantics for a single-deps
// case. Kept inline to avoid a one-line wrapper hop.
import { useEffect as useStateEffect } from "react";
