/**
 * Shared HostConfigEditor.
 *
 * Used by:
 *  - Project Settings → edits projects.defaultHostConfigId. Copy makes
 *    clear that this seeds new chatboxes, eval suites, and direct chat
 *    tabs only — editing it does NOT propagate to existing children.
 *  - Chatbox Editor / Builder → edits the chatbox-owned hostConfigId.
 *  - Eval Suite Settings → edits the suite-owned hostConfigId.
 *  - Connection Settings (legacy) → edits the project default's connection
 *    portion only via a compat wrapper. That tab continues to render its
 *    own connection-only UI rather than embedding this whole editor.
 *
 * Phase 1: this is a controlled component that reflects a v2 input value
 * and emits changes. Concrete editors wire it up to the relevant Convex
 * mutation. The fancier sub-controls (server picker, capability JSON
 * editor) are imported from existing components in subsequent PRs; for
 * Phase 1 we expose minimal text/number/JSON inputs so the shape is
 * fully editable end-to-end.
 */

import {
  useCallback,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
} from "react";
import { Label } from "@mcpjam/design-system/label";
import { Input } from "@mcpjam/design-system/input";
import { Textarea } from "@mcpjam/design-system/textarea";
import { Switch } from "@mcpjam/design-system/switch";
import { Slider } from "@mcpjam/design-system/slider";
import { Separator } from "@mcpjam/design-system/separator";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@mcpjam/design-system/select";
import { Button } from "@mcpjam/design-system/button";
import {
  type HostConfigInputV2,
  type HostConfigMcpProfileV1,
  type HostStyleId,
  DEFAULT_TEMPERATURE_V2,
} from "@/lib/host-config-v2";
import {
  getHostCapabilitiesForStyle,
  listHostStyles,
} from "@/lib/host-styles";

export type HostConfigEditorOwner =
  | "project-default"
  | "chatbox"
  | "eval-suite"
  | "connection-only";

export interface HostConfigEditorProps {
  value: HostConfigInputV2;
  onChange: (next: HostConfigInputV2) => void;
  /**
   * Disable subsections that don't apply to a given owner. For example
   * Connection Settings only edits the connection portion.
   */
  owner?: HostConfigEditorOwner;
  /**
   * Pool of project servers the user may select. Each entry is `{ id, name }`.
   * Server selection UI is rendered as a simple multi-checkbox list for
   * Phase 1. The full builder picker is wired in later phases.
   */
  availableServers?: ReadonlyArray<{ id: string; name: string }>;
  /** Show a one-line caption above the editor (e.g. seed-only copy). */
  caption?: string;
  /** Optional className for the outer wrapper. */
  className?: string;
  /**
   * Aggregated validity signal. Called with `true` whenever any
   * subsection (currently the JSON record editors) is in an error
   * state. Parent forms should disable Save while invalid.
   */
  onValidityChange?: (hasError: boolean) => void;
}

export function HostConfigEditor({
  value,
  onChange,
  owner = "chatbox",
  availableServers,
  caption,
  className,
  onValidityChange,
}: HostConfigEditorProps) {
  const reactId = useId();

  // Track per-section JSON parse errors. Aggregate into a single boolean
  // and notify the parent whenever it changes so the form can gate Save.
  const [headersError, setHeadersError] = useState<string | null>(null);
  const [capsError, setCapsError] = useState<string | null>(null);
  const [hostCtxError, setHostCtxError] = useState<string | null>(null);
  const [hostCapsOverrideError, setHostCapsOverrideError] = useState<
    string | null
  >(null);
  const hasError =
    headersError != null ||
    capsError != null ||
    hostCtxError != null ||
    hostCapsOverrideError != null;
  useEffect(() => {
    onValidityChange?.(hasError);
  }, [hasError, onValidityChange]);

  const update = useCallback(
    (patch: Partial<HostConfigInputV2>) => {
      onChange({ ...value, ...patch });
    },
    [value, onChange],
  );

  const updateConnection = useCallback(
    (patch: Partial<HostConfigInputV2["connectionDefaults"]>) => {
      onChange({
        ...value,
        connectionDefaults: { ...value.connectionDefaults, ...patch },
      });
    },
    [value, onChange],
  );

  const showExecutionSection = owner !== "connection-only";
  // Eval suites own server selection through `suite.environment` —
  // `setSuiteConfig` rejects non-empty serverIds, and the iteration
  // materializer pulls server ids from the suite environment. The
  // editor surface for owner="eval-suite" therefore hides the server
  // picker entirely (and ignores `availableServers`) so users can't
  // type changes the backend would reject.
  const showServersSection =
    owner !== "connection-only" && owner !== "eval-suite";

  const hostStyleOptions = useMemo(() => listHostStyles(), []);

  return (
    <div className={className}>
      {caption ? (
        <p className="text-xs text-muted-foreground mb-3">{caption}</p>
      ) : null}

      {showExecutionSection ? (
        <>
          <section className="space-y-4">
            <div className="grid gap-2">
              <Label htmlFor={`${reactId}-modelId`}>Model</Label>
              <Input
                id={`${reactId}-modelId`}
                value={value.modelId}
                onChange={(e) => update({ modelId: e.target.value })}
                placeholder="claude-sonnet-4-5"
              />
            </div>

            <div className="grid gap-2">
              <Label htmlFor={`${reactId}-systemPrompt`}>System prompt</Label>
              <Textarea
                id={`${reactId}-systemPrompt`}
                rows={6}
                value={value.systemPrompt}
                onChange={(e) => update({ systemPrompt: e.target.value })}
              />
            </div>

            <div className="grid gap-2">
              <div className="flex items-center justify-between">
                <Label>Temperature</Label>
                <span className="text-xs text-muted-foreground">
                  {value.temperature.toFixed(2)}
                </span>
              </div>
              <Slider
                value={[value.temperature]}
                min={0}
                max={2}
                step={0.05}
                onValueChange={(values) =>
                  update({
                    temperature: values[0] ?? DEFAULT_TEMPERATURE_V2,
                  })
                }
              />
            </div>

            <div className="flex items-center justify-between">
              <Label htmlFor={`${reactId}-toolApproval`}>
                Require tool approval
              </Label>
              <Switch
                id={`${reactId}-toolApproval`}
                checked={value.requireToolApproval}
                onCheckedChange={(checked) =>
                  update({ requireToolApproval: checked })
                }
              />
            </div>

            <div className="grid gap-2">
              <Label htmlFor={`${reactId}-hostStyle`}>Host style</Label>
              <Select
                value={value.hostStyle}
                onValueChange={(next) =>
                  update({ hostStyle: next as HostStyleId })
                }
              >
                <SelectTrigger id={`${reactId}-hostStyle`}>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {hostStyleOptions.map((style) => (
                    <SelectItem key={style.id} value={style.id}>
                      {style.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          </section>

          <Separator className="my-6" />
        </>
      ) : null}

      {showServersSection ? (
        <>
          <section className="space-y-4">
            <ServerCheckboxList
              label="Required servers"
              selected={value.serverIds}
              available={availableServers ?? []}
              onChange={(serverIds) => {
                // Maintain the invariant the chatbox save path relies on:
                // optionalServerIds is a subset of serverIds. When a
                // server is unchecked from the required list, it must
                // also leave the optional list — otherwise the saved
                // config would describe an "optional server" that isn't
                // even selected.
                const requiredSet = new Set(serverIds);
                update({
                  serverIds,
                  optionalServerIds: value.optionalServerIds.filter((id) =>
                    requiredSet.has(id),
                  ),
                });
              }}
            />
            <ServerCheckboxList
              label="Optional servers"
              selected={value.optionalServerIds}
              available={(availableServers ?? []).filter((srv) =>
                value.serverIds.includes(srv.id),
              )}
              onChange={(optionalServerIds) => {
                // Editing the optional list should never add a server
                // that isn't in serverIds. The available pool above
                // already filters to selected required servers, but
                // belt-and-suspenders: re-clamp here too.
                const requiredSet = new Set(value.serverIds);
                update({
                  optionalServerIds: optionalServerIds.filter((id) =>
                    requiredSet.has(id),
                  ),
                });
              }}
            />
          </section>

          <Separator className="my-6" />
        </>
      ) : null}

      <section className="space-y-4">
        <div className="grid gap-2">
          <Label htmlFor={`${reactId}-timeout`}>Request timeout (ms)</Label>
          <Input
            id={`${reactId}-timeout`}
            type="number"
            min={1}
            value={value.connectionDefaults.requestTimeout}
            onChange={(e) => {
              // Preserve the positive-timeout invariant. The legacy
              // connection-settings parser rejects non-positive values and
              // a 0 here would persist an immediate-timeout config. Keep
              // the prior value when the field is cleared or non-positive.
              const parsed = Number(e.target.value);
              if (Number.isFinite(parsed) && parsed > 0) {
                updateConnection({ requestTimeout: parsed });
              }
            }}
          />
        </div>

        <div className="grid gap-2">
          <Label>Connection headers (JSON)</Label>
          <JsonRecordEditor
            value={value.connectionDefaults.headers}
            onChange={(headers) =>
              updateConnection({
                headers: coerceHeadersToStringRecord(headers),
              })
            }
            onErrorChange={setHeadersError}
            placeholder='{"X-Header":"value"}'
          />
        </div>

        <div className="grid gap-2">
          <Label>Client capabilities (JSON)</Label>
          <JsonRecordEditor
            value={value.clientCapabilities}
            onChange={(clientCapabilities) =>
              update({ clientCapabilities })
            }
            onErrorChange={setCapsError}
            placeholder="{}"
          />
        </div>

        {owner !== "connection-only" ? (
          <div className="grid gap-2">
            <Label>Host context (JSON)</Label>
            <JsonRecordEditor
              value={value.hostContext}
              onChange={(hostContext) => update({ hostContext })}
              onErrorChange={setHostCtxError}
              placeholder="{}"
            />
          </div>
        ) : null}

        {owner !== "connection-only" ? (
          <HostCapabilitiesOverrideSection
            hostStyle={value.hostStyle}
            override={value.hostCapabilitiesOverride}
            onChange={(hostCapabilitiesOverride) =>
              update({ hostCapabilitiesOverride })
            }
            onErrorChange={setHostCapsOverrideError}
          />
        ) : null}

        {owner !== "connection-only" ? (
          <McpProfileSection
            profile={value.mcpProfile}
            onChange={(mcpProfile) => update({ mcpProfile })}
          />
        ) : null}
      </section>
    </div>
  );
}

/**
 * Editor for the optional `mcpProfile` envelope on a host config.
 *
 * Minimal v1 surface (per the inspector PR plan): structured controls for
 * the spec-stable fields (`clientInfo.{name,version,title}`,
 * `supportedProtocolVersions`, CSP/permissions `mode`) plus raw-JSON
 * editors for the freeform CSP/permissions allow/deny sets.
 *
 * `undefined` ↔ `{ profileVersion: 1 }` distinction is preserved
 * verbatim: the section starts hidden (`undefined`), "Enable" stamps a
 * fresh `{ profileVersion: 1 }`, and "Reset to SDK defaults" snaps it
 * back to `undefined`. The backend hashes those two states distinctly
 * (PR #269 test) so the "user opted in" signal survives a reload-save
 * cycle.
 *
 * Per-`hostStyle` defaults (auto-populating clientInfo on host-style
 * change) are intentionally deferred to v2 — they create surprising
 * "why did my profile change?" behavior on the picker and the
 * inspector PR plan flagged them as out-of-scope.
 */
function McpProfileSection({
  profile,
  onChange,
}: {
  profile: HostConfigMcpProfileV1 | undefined;
  onChange: (next: HostConfigMcpProfileV1 | undefined) => void;
}) {
  const [expanded, setExpanded] = useState<boolean>(profile !== undefined);
  const enabled = profile !== undefined;

  // Local draft buffer for the clientInfo fields. The persisted envelope
  // only accepts complete `{ name, version }` pairs (the backend validator
  // rejects partial state), but the editor must let users type one field
  // at a time. Storing the in-progress text here breaks the "input shows
  // empty value because hasRequired = false → persisted clientInfo →
  // undefined → controlled input rerenders empty" loop.
  //
  // Initialized from the persisted profile so reloads round-trip; flushed
  // to the persisted envelope only when both required fields are present.
  // Title is independent (optional per spec) and flushes whenever the
  // required pair is already complete.
  const persistedClientInfo = profile?.initialize?.clientInfo;
  const [clientInfoDraft, setClientInfoDraft] = useState<{
    name: string;
    version: string;
    title: string;
  }>(() => ({
    name: typeof persistedClientInfo?.name === "string" ? persistedClientInfo.name : "",
    version:
      typeof persistedClientInfo?.version === "string"
        ? persistedClientInfo.version
        : "",
    title:
      typeof persistedClientInfo?.title === "string"
        ? persistedClientInfo.title
        : "",
  }));

  // Ref mirror of the draft so the flush logic in `updateClientInfo` can
  // read the latest committed value WITHOUT firing the parent `onChange`
  // from inside a `setClientInfoDraft` updater callback (React state
  // updaters must be pure; double-firing under StrictMode + concurrent
  // mode would re-emit onChange for the same edit).
  const clientInfoDraftRef = useRef(clientInfoDraft);
  useEffect(() => {
    clientInfoDraftRef.current = clientInfoDraft;
  }, [clientInfoDraft]);

  // Sync the local draft from the persisted profile when the parent
  // overwrites it externally. Three scenarios this handles:
  //
  //   1. "Reset to SDK defaults" — `onChange(undefined)` clears the
  //      envelope; without this effect the draft stays populated and the
  //      NEXT keystroke flushes the stale values right back in.
  //   2. Parent DTO reload — switching projects or receiving a fresh DTO
  //      replaces `profile`; the draft would otherwise display stale
  //      identity from the previous config.
  //   3. Programmatic patches from elsewhere in the editor.
  //
  // The invariant we hold: if the value the current draft WOULD flush
  // equals the persisted clientInfo, persisted reflects our own write —
  // keep the draft as-is so an in-progress edit (e.g. user is typing
  // `title` after `name`/`version` are stable) isn't clobbered. Otherwise
  // persisted has diverged externally; mirror it into the draft.
  useEffect(() => {
    const persistedCi = profile?.initialize?.clientInfo;
    const draft = clientInfoDraftRef.current;
    const draftName = draft.name.trim();
    const draftVersion = draft.version.trim();
    const draftTitle = draft.title.trim();
    const draftWouldFlush = draftName !== "" && draftVersion !== "";

    if (!persistedCi) {
      // Persisted is empty. If the draft also can't flush, we're already
      // in sync (partial edit in progress; flushed undefined; no work).
      if (!draftWouldFlush) return;
      // Otherwise persisted was cleared externally → mirror.
      setClientInfoDraft({ name: "", version: "", title: "" });
      return;
    }

    const persistedName =
      typeof persistedCi.name === "string" ? persistedCi.name : "";
    const persistedVersion =
      typeof persistedCi.version === "string" ? persistedCi.version : "";
    const persistedTitle =
      typeof persistedCi.title === "string" ? persistedCi.title : "";

    // Persisted reflects our own write iff every field the draft would
    // flush matches the persisted value. Title comparison is
    // asymmetric: an empty draft title shouldn't trip the divergence
    // check if persisted also has no title.
    if (
      draftWouldFlush &&
      persistedName === draftName &&
      persistedVersion === draftVersion &&
      (draftTitle === "" ? persistedTitle === "" : persistedTitle === draftTitle)
    ) {
      return;
    }

    // External divergence — mirror persisted into the draft.
    setClientInfoDraft({
      name: persistedName,
      version: persistedVersion,
      title: persistedTitle,
    });
  }, [profile]);

  const enable = useCallback(() => {
    setExpanded(true);
    if (!enabled) onChange({ profileVersion: 1 });
  }, [enabled, onChange]);

  const resetToDefault = useCallback(() => {
    // Snap back to `undefined` so the SDK falls back to its built-in
    // clientInfo + protocolVersion. Distinct from `{ profileVersion: 1 }`
    // on the wire — that "empty envelope" hashes differently because the
    // user explicitly opted in. The draft-sync effect above will clear
    // the local draft on the next render so re-enabling doesn't surface
    // stale values.
    onChange(undefined);
  }, [onChange]);

  const updateInitialize = useCallback(
    (
      patch: Partial<NonNullable<HostConfigMcpProfileV1["initialize"]>>,
    ) => {
      const base: HostConfigMcpProfileV1 = profile ?? { profileVersion: 1 };
      const nextInitialize = {
        ...(base.initialize ?? {}),
        ...patch,
      };
      // Collapse to undefined when every subfield is empty so a half-
      // filled-then-cleared edit doesn't leave a vacuous `initialize: {}`
      // on the wire (which would still hash distinctly from absent).
      const hasInitFields =
        nextInitialize.clientInfo !== undefined ||
        (nextInitialize.supportedProtocolVersions &&
          nextInitialize.supportedProtocolVersions.length > 0);
      onChange({
        ...base,
        initialize: hasInitFields ? nextInitialize : undefined,
      });
    },
    [profile, onChange],
  );

  const updateClientInfo = useCallback(
    (patch: { name?: string; version?: string; title?: string }) => {
      // Compute the next draft from the ref-mirrored latest committed
      // value, then commit it to state with a PURE setter call and flush
      // to the parent envelope outside any state updater. The previous
      // shape called `updateInitialize` (which fires parent `onChange`)
      // from inside the `setClientInfoDraft` updater, which violates
      // React's purity rule and double-fires under StrictMode.
      const prev = clientInfoDraftRef.current;
      const next = { ...prev };
      if (patch.name !== undefined) next.name = patch.name;
      if (patch.version !== undefined) next.version = patch.version;
      if (patch.title !== undefined) next.title = patch.title;

      clientInfoDraftRef.current = next;
      setClientInfoDraft(next);

      const nameTrim = next.name.trim();
      const versionTrim = next.version.trim();
      const titleTrim = next.title.trim();
      const hasRequired = nameTrim !== "" && versionTrim !== "";

      // Preserve forward-compat extras (e.g. future spec fields the
      // backend round-trips verbatim) that the persisted envelope
      // already carries — we never route them through the draft, so
      // they'd otherwise be dropped on every flush.
      const preserved: Record<string, unknown> = {};
      const persisted = profile?.initialize?.clientInfo;
      if (persisted && typeof persisted === "object") {
        for (const [k, v] of Object.entries(persisted)) {
          if (k === "name" || k === "version" || k === "title") continue;
          preserved[k] = v;
        }
      }

      if (hasRequired) {
        const nextClientInfo: Record<string, unknown> = {
          ...preserved,
          name: nameTrim,
          version: versionTrim,
        };
        if (titleTrim !== "") nextClientInfo.title = titleTrim;
        updateInitialize({ clientInfo: nextClientInfo });
      } else {
        // Required pair incomplete — drop `clientInfo` from the envelope
        // so the backend doesn't reject the save. The draft survives so
        // the user can keep typing.
        updateInitialize({ clientInfo: undefined });
      }
    },
    [profile, updateInitialize],
  );

  const updateProtocolVersions = useCallback(
    (raw: string) => {
      const versions = raw
        .split(/\r?\n/)
        .map((line) => line.trim())
        .filter((line) => line !== "");
      updateInitialize({
        supportedProtocolVersions: versions.length > 0 ? versions : undefined,
      });
    },
    [updateInitialize],
  );

  if (!enabled) {
    return (
      <div className="grid gap-2">
        <div className="flex items-center justify-between gap-2">
          <Label>MCP profile (advanced)</Label>
          <Button type="button" size="sm" variant="ghost" onClick={enable}>
            Enable
          </Button>
        </div>
        <p className="text-xs text-muted-foreground">
          Pin the `clientInfo`, supported protocol versions, and sandbox
          policy this host config advertises in MCP `initialize`. Leave
          disabled to use SDK defaults — recommended for normal use.
        </p>
      </div>
    );
  }

  // Inputs read from the local draft (which always reflects what the user
  // typed); the persisted envelope only sees complete combos. See the
  // `clientInfoDraft` state declaration above for rationale.
  const clientInfo = clientInfoDraft;
  const protocolVersionsText = (
    profile?.initialize?.supportedProtocolVersions ?? []
  ).join("\n");

  return (
    <div className="grid gap-3 rounded-md border border-border/50 p-3">
      <div className="flex items-center justify-between gap-2">
        <Label>MCP profile</Label>
        <div className="flex items-center gap-1">
          <Button
            type="button"
            size="sm"
            variant="ghost"
            onClick={() => setExpanded((e) => !e)}
          >
            {expanded ? "Collapse" : "Expand"}
          </Button>
          <Button
            type="button"
            size="sm"
            variant="ghost"
            onClick={resetToDefault}
          >
            Reset to SDK defaults
          </Button>
        </div>
      </div>

      {expanded ? (
        <>
          <div className="grid gap-2">
            <Label className="text-xs font-medium" htmlFor="mcp-profile-client-name">
              Client identity
            </Label>
            <div className="grid grid-cols-2 gap-2">
              <Input
                id="mcp-profile-client-name"
                aria-label="Client name"
                placeholder="name (e.g. chatgpt)"
                value={clientInfo.name}
                onChange={(e) => updateClientInfo({ name: e.target.value })}
              />
              <Input
                aria-label="Client version"
                placeholder="version (e.g. 1.0.0)"
                value={clientInfo.version}
                onChange={(e) => updateClientInfo({ version: e.target.value })}
              />
            </div>
            <Input
              aria-label="Client title (optional)"
              placeholder="title (optional, e.g. ChatGPT Desktop)"
              value={clientInfo.title}
              onChange={(e) => updateClientInfo({ title: e.target.value })}
            />
            <p className="text-xs text-muted-foreground">
              Both name and version are required when client identity is
              set. Saved verbatim to MCP `initialize.params.clientInfo`.
            </p>
          </div>

          <div className="grid gap-2">
            <Label className="text-xs font-medium">
              Supported protocol versions (one per line, first = proposed)
            </Label>
            <Textarea
              rows={3}
              placeholder={"2025-11-25\n2025-06-18"}
              value={protocolVersionsText}
              onChange={(e) => updateProtocolVersions(e.target.value)}
              className="font-mono text-xs"
            />
            <p className="text-xs text-muted-foreground">
              First entry is proposed in `initialize.params.protocolVersion`;
              the full list is the accept-set. Order is semantic — do not
              shuffle.
            </p>
          </div>

          <McpProfileSandboxEditor
            profile={profile}
            onChange={onChange}
          />
        </>
      ) : null}
    </div>
  );
}

/**
 * Sandbox subsection — CSP and permissions. Uses structured mode
 * dropdowns + raw-JSON for the more complex allow/deny shapes. v1 keeps
 * the JSON editors lean rather than building four-domain-list
 * widgets per directive; the editor evolves once usage patterns settle.
 */
function McpProfileSandboxEditor({
  profile,
  onChange,
}: {
  profile: HostConfigMcpProfileV1 | undefined;
  onChange: (next: HostConfigMcpProfileV1 | undefined) => void;
}) {
  const updateSandbox = useCallback(
    (
      patch: Partial<
        NonNullable<NonNullable<HostConfigMcpProfileV1["apps"]>["sandbox"]>
      >,
    ) => {
      const base: HostConfigMcpProfileV1 = profile ?? { profileVersion: 1 };
      const nextSandbox = {
        ...(base.apps?.sandbox ?? {}),
        ...patch,
      };
      const hasSandboxFields =
        nextSandbox.csp !== undefined ||
        nextSandbox.permissions !== undefined;
      onChange({
        ...base,
        apps: hasSandboxFields ? { sandbox: nextSandbox } : undefined,
      });
    },
    [profile, onChange],
  );

  const csp = profile?.apps?.sandbox?.csp;
  const permissions = profile?.apps?.sandbox?.permissions;

  return (
    <div className="grid gap-3 rounded-md border border-border/30 p-3">
      <Label className="text-xs font-medium">Sandbox (MCP Apps)</Label>

      <div className="grid gap-2">
        <Label className="text-xs">CSP mode</Label>
        <Select
          value={csp?.mode ?? "declared"}
          onValueChange={(v) =>
            updateSandbox({
              csp: {
                ...(csp ?? {}),
                mode: v as "host-default" | "declared" | "relaxed",
              },
            })
          }
        >
          <SelectTrigger>
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="declared">
              Declared (use resource's CSP)
            </SelectItem>
            <SelectItem value="host-default">
              Host default (inspector's baseline)
            </SelectItem>
            <SelectItem value="relaxed">Relaxed (dev only)</SelectItem>
          </SelectContent>
        </Select>
        <p className="text-xs text-muted-foreground">
          restrictTo intersects with the baseline; deny always wins. Below
          take effect in every mode.
        </p>
      </div>

      <McpProfileCspDomainSetEditor
        label="restrictTo (intersect with baseline)"
        value={csp?.restrictTo}
        onChange={(restrictTo) =>
          updateSandbox({ csp: { ...(csp ?? {}), restrictTo } })
        }
      />
      <McpProfileCspDomainSetEditor
        label="deny (always blocked)"
        value={csp?.deny}
        onChange={(deny) =>
          updateSandbox({ csp: { ...(csp ?? {}), deny } })
        }
      />

      <Separator />

      <div className="grid gap-2">
        <Label className="text-xs">Permissions mode</Label>
        <Select
          value={permissions?.mode ?? "resource-declared"}
          onValueChange={(v) =>
            updateSandbox({
              permissions: {
                ...(permissions ?? {}),
                mode: v as "resource-declared" | "deny-all" | "custom",
              },
            })
          }
        >
          <SelectTrigger>
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="resource-declared">
              Resource-declared (default)
            </SelectItem>
            <SelectItem value="deny-all">Deny all</SelectItem>
            <SelectItem value="custom">Custom allow/deny</SelectItem>
          </SelectContent>
        </Select>
        <p className="text-xs text-muted-foreground">
          Resource declaration is the ceiling — host can never grant a
          permission the resource didn't request.
        </p>
      </div>
    </div>
  );
}

/**
 * Single editor for one CspDomainSet (four parallel directive lists).
 * One textarea per directive — JSON-array style — keeps the surface lean
 * while exposing all four directives the spec defines.
 */
function McpProfileCspDomainSetEditor({
  label,
  value,
  onChange,
}: {
  label: string;
  value: { connectDomains?: string[]; resourceDomains?: string[]; frameDomains?: string[]; baseUriDomains?: string[] } | undefined;
  onChange: (
    next:
      | {
          connectDomains?: string[];
          resourceDomains?: string[];
          frameDomains?: string[];
          baseUriDomains?: string[];
        }
      | undefined,
  ) => void;
}) {
  const directives: Array<{
    key: "connectDomains" | "resourceDomains" | "frameDomains" | "baseUriDomains";
    placeholder: string;
    /** Human-readable label used for the directive's accessible name. */
    directiveLabel: string;
  }> = [
    {
      key: "connectDomains",
      placeholder: "https://api.example.com",
      directiveLabel: "connect-src",
    },
    {
      key: "resourceDomains",
      placeholder: "https://cdn.example.com",
      directiveLabel: "resource (img/script/style/font/media)",
    },
    {
      key: "frameDomains",
      placeholder: "https://player.example.com",
      directiveLabel: "frame-src",
    },
    {
      key: "baseUriDomains",
      placeholder: "https://example.com",
      directiveLabel: "base-uri",
    },
  ];

  const updateDirective = (
    key: typeof directives[number]["key"],
    raw: string,
  ) => {
    const items = raw
      .split(/\r?\n/)
      .map((s) => s.trim())
      .filter((s) => s !== "");
    const nextValue = { ...(value ?? {}) };
    if (items.length === 0) {
      delete nextValue[key];
    } else {
      nextValue[key] = items;
    }
    // Drop the whole set when every directive is empty so undefined
    // round-trips cleanly through the backend canonicalizer (it
    // distinguishes undefined from `{}` for hash purposes).
    const hasAny = directives.some((d) => {
      const list = nextValue[d.key];
      return Array.isArray(list) && list.length > 0;
    });
    onChange(hasAny ? nextValue : undefined);
  };

  return (
    <div className="grid gap-2" role="group" aria-label={label}>
      <Label className="text-xs">{label}</Label>
      {directives.map((d) => (
        <div key={d.key} className="grid gap-1">
          {/* Per-directive label is a real DOM <label> for screen readers.
              The placeholder is illustrative, not the accessible name —
              relying on placeholder text alone fails WCAG 1.3.1 / 4.1.2. */}
          <Label
            htmlFor={`mcp-profile-csp-${label}-${d.key}`}
            className="text-[10px] font-mono uppercase text-muted-foreground"
          >
            {d.directiveLabel}
          </Label>
          <Textarea
            id={`mcp-profile-csp-${label}-${d.key}`}
            aria-label={`${label} ${d.directiveLabel}`}
            rows={2}
            className="font-mono text-xs"
            placeholder={d.placeholder}
            value={(value?.[d.key] ?? []).join("\n")}
            onChange={(e) => updateDirective(d.key, e.target.value)}
          />
        </div>
      ))}
    </div>
  );
}

/**
 * Editor for the optional MCP Apps `hostCapabilities` override (advertised in
 * `ui/initialize`). When the override is undefined, the renderer falls back
 * to the active host style's preset; this section shows that preset as the
 * placeholder so users can see what they'd be overriding. Resetting writes
 * `undefined`, which snaps back to the preset.
 *
 * CONFORMANCE GAP: this configures the *advertised* blob. Behavior gating
 * inside request handlers is a separate, deferred step (see
 * registerBridgeHandlers in mcp-apps-renderer.tsx).
 */
function HostCapabilitiesOverrideSection({
  hostStyle,
  override,
  onChange,
  onErrorChange,
}: {
  hostStyle: HostStyleId;
  override: Record<string, unknown> | undefined;
  onChange: (next: Record<string, unknown> | undefined) => void;
  onErrorChange: (error: string | null) => void;
}) {
  const profilePreset = useMemo(
    () => getHostCapabilitiesForStyle(hostStyle),
    [hostStyle],
  );
  const profilePresetJson = useMemo(
    () => JSON.stringify(profilePreset, null, 2),
    [profilePreset],
  );
  const isOverriding = override !== undefined;
  // When the user hasn't set an override, seed the editor with the profile
  // preset (writeable copy) so they have a visible starting point for edits.
  const editorValue = isOverriding ? override : (profilePreset as Record<string, unknown>);

  return (
    <div className="grid gap-2">
      <div className="flex items-center justify-between gap-2">
        <Label>Host capabilities override (JSON)</Label>
        {isOverriding ? (
          <Button
            type="button"
            size="sm"
            variant="ghost"
            onClick={() => onChange(undefined)}
          >
            Reset to {hostStyle} preset
          </Button>
        ) : (
          <span className="text-xs text-muted-foreground">
            Using {hostStyle} preset
          </span>
        )}
      </div>
      <p className="text-xs text-muted-foreground">
        Advertised in <code>ui/initialize</code>. Leave at the preset to match
        the vendor; override to mock specific capability combinations.
      </p>
      <JsonRecordEditor
        value={editorValue}
        onChange={(next) => onChange(next)}
        onErrorChange={onErrorChange}
        placeholder={profilePresetJson}
      />
    </div>
  );
}

/**
 * Coerce a parsed JSON object into a `Record<string, string>` suitable for
 * HTTP headers. Non-string values are converted via `String(...)`; nested
 * objects/arrays/null are dropped. The JsonRecordEditor only validates the
 * outer shape (non-array object), so values can be anything.
 *
 * Drops:
 *   - empty / whitespace-only keys (the legacy project-default
 *     normalizer also filters these; an empty header name would later
 *     fail when merged into requestInit.headers).
 *   - `Authorization` (case-insensitive) — the existing connection-
 *     settings parser rejects it and the project-default normalizer
 *     strips it, so accepting it would either fail later validation or
 *     persist a credential-bearing default.
 */
function coerceHeadersToStringRecord(
  raw: Record<string, unknown>,
): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, val] of Object.entries(raw)) {
    if (k.trim() === "") continue;
    if (k.toLowerCase() === "authorization") continue;
    if (val == null) continue;
    if (typeof val === "object") continue;
    out[k] = String(val);
  }
  return out;
}

function ServerCheckboxList({
  label,
  selected,
  available,
  onChange,
}: {
  label: string;
  selected: string[];
  available: ReadonlyArray<{ id: string; name: string }>;
  onChange: (ids: string[]) => void;
}) {
  const selectedSet = useMemo(() => new Set(selected), [selected]);
  const toggle = useCallback(
    (id: string) => {
      const next = new Set(selectedSet);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      onChange(Array.from(next));
    },
    [selectedSet, onChange],
  );

  if (available.length === 0) {
    return (
      <div>
        <Label>{label}</Label>
        <p className="text-xs text-muted-foreground mt-1">
          No servers available in this project.
        </p>
      </div>
    );
  }

  return (
    <div className="grid gap-2">
      <Label>{label}</Label>
      <div className="grid gap-1 max-h-40 overflow-y-auto rounded border px-2 py-2">
        {available.map((srv) => (
          <label
            key={srv.id}
            className="flex items-center gap-2 text-sm cursor-pointer"
          >
            <input
              type="checkbox"
              checked={selectedSet.has(srv.id)}
              onChange={() => toggle(srv.id)}
            />
            <span>{srv.name}</span>
          </label>
        ))}
      </div>
    </div>
  );
}

/**
 * Minimal JSON-record editor: textarea backed by JSON.parse on blur.
 * Phase 1 uses this to keep the editor self-contained. Real builders for
 * client capabilities (already exists in the codebase) replace this in
 * later phases.
 *
 * Exposes parse errors via `onErrorChange` so the parent form can disable
 * its Save button while any field is invalid. Errors are cleared as soon
 * as the user enters valid JSON or the parent value changes.
 */
function JsonRecordEditor({
  value,
  onChange,
  onErrorChange,
  placeholder,
}: {
  value: Record<string, unknown>;
  onChange: (next: Record<string, unknown>) => void;
  onErrorChange?: (error: string | null) => void;
  placeholder?: string;
}) {
  const stringified = useMemo(() => JSON.stringify(value, null, 2), [value]);
  const [raw, setRaw] = useState(stringified);
  const [error, setErrorState] = useState<string | null>(null);
  // Tracks the stringified form we most recently emitted up via
  // onChange. The resync effect compares `stringified` against this;
  // matches mean the re-render is a self-edit echo and we leave the
  // textarea alone (avoids prettifying the user's input mid-keystroke
  // and wiping cursor position).
  const lastEmittedRef = useRef(stringified);
  // Tracks the most recent parent `value` reference we observed, so we
  // can detect a controlled reset (a new parent reference whose
  // serialized form happens to match the last emitted one). Without
  // this we'd miss the case where the user typed invalid JSON, the
  // parent then resets/loads a config that serializes identically to
  // the last valid value, and our textarea+error stay stuck.
  const lastValueRef = useRef(value);

  const setError = useCallback(
    (next: string | null) => {
      setErrorState(next);
      onErrorChange?.(next);
    },
    [onErrorChange],
  );

  // Re-sync local text whenever:
  //  - the parent's serialized form differs from our last emit
  //    (genuine external change), OR
  //  - the parent passed a new `value` reference while we are showing
  //    a parse error (controlled reset path: invalid drafts must clear
  //    even when the new value happens to canonicalize to the same
  //    string we last emitted).
  useEffect(() => {
    const referenceChanged = value !== lastValueRef.current;
    const stringifiedChanged = stringified !== lastEmittedRef.current;
    if (stringifiedChanged || (referenceChanged && error != null)) {
      setRaw(stringified);
      lastEmittedRef.current = stringified;
      setError(null);
    }
    lastValueRef.current = value;
  }, [value, stringified, error, setError]);

  // Clear the error signal when this editor unmounts (e.g. owner
  // switched to a mode that hides this section). Without this, the
  // parent's aggregated hasError signal would stay stuck on a stale
  // error from a section the user can no longer see, keeping Save
  // disabled with no visible cause to fix.
  useEffect(() => {
    return () => {
      onErrorChange?.(null);
    };
    // We intentionally don't depend on onErrorChange — only fire on unmount.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Parse on every keystroke so errors clear as soon as the user fixes
  // them and the parent's `onChange`/`onErrorChange` signals stay live.
  // We still only call `onChange` (committing the parsed value) on
  // successful parses; partial drafts don't propagate.
  const tryParse = useCallback(
    (next: string) => {
      try {
        const parsed = JSON.parse(next || "{}");
        if (
          !parsed ||
          typeof parsed !== "object" ||
          Array.isArray(parsed)
        ) {
          setError("Must be a JSON object");
          return;
        }
        setError(null);
        // Compute the post-onChange canonical form (what the parent
        // will serialize) and capture it so the resync effect treats
        // the upcoming re-render as a self-edit.
        lastEmittedRef.current = JSON.stringify(
          parsed as Record<string, unknown>,
          null,
          2,
        );
        onChange(parsed as Record<string, unknown>);
      } catch (err) {
        setError(err instanceof Error ? err.message : "Invalid JSON");
      }
    },
    [onChange, setError],
  );

  return (
    <div className="grid gap-1">
      <Textarea
        rows={4}
        value={raw}
        onChange={(e) => {
          const next = e.target.value;
          setRaw(next);
          tryParse(next);
        }}
        placeholder={placeholder}
      />
      {error ? (
        <p className="text-xs text-destructive">{error}</p>
      ) : null}
    </div>
  );
}
