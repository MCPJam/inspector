/**
 * Shared ClientConfigEditor.
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
  ToggleGroup,
  ToggleGroupItem,
} from "@mcpjam/design-system/toggle-group";
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
  SEP_1865_PERMISSION_FEATURES,
} from "@/lib/client-config-v2";
import {
  getHostCapabilitiesForStyle,
  listHostStyles,
} from "@/lib/client-styles";
import { useBuiltInToolCatalog } from "@/hooks/useBuiltInToolCatalog";
import { BuiltInToolCheckboxList } from "./BuiltInToolCheckboxList";

export type HostConfigEditorOwner =
  | "project-default"
  | "chatbox"
  | "eval-suite"
  | "connection-only"
  | "host";

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

export function ClientConfigEditor({
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
    [value, onChange]
  );

  const updateConnection = useCallback(
    (patch: Partial<HostConfigInputV2["connectionDefaults"]>) => {
      onChange({
        ...value,
        connectionDefaults: { ...value.connectionDefaults, ...patch },
      });
    },
    [value, onChange]
  );

  const showExecutionSection = owner !== "connection-only";
  // Eval suites own server selection through `suite.environment` —
  // `setSuiteConfig` rejects non-empty serverIds, and the iteration
  // materializer pulls server ids from the suite environment. The
  // editor surface for owner="eval-suite" therefore hides the server
  // picker entirely (and ignores `availableServers`) so users can't
  // type changes the backend would reject.
  // For owner="host", server selection is managed via the canvas in
  // HostBuilderView — hiding it here prevents double-entry confusion.
  const showServersSection =
    owner !== "connection-only" && owner !== "eval-suite" && owner !== "host";

  // Built-in tools are an attach surface for every editor owner that drives a
  // model turn — project default, chatbox, eval suite, and the Connect host
  // editor. Unlike servers (which the host editor manages via the canvas),
  // built-ins have no canvas equivalent, so the in-editor list is the only
  // attach surface here. Hide entirely on deployments whose catalog is empty
  // (loading → undefined → hidden) so empty installs don't show a dead card.
  const builtInToolCatalog = useBuiltInToolCatalog();
  const showBuiltInToolsSection =
    owner !== "connection-only" && (builtInToolCatalog?.length ?? 0) > 0;
  // The personal-computer toggle only appears once the deployment exposes a
  // computer-backed tool in the catalog (the `bash` row ships disabled until
  // launch, so this stays hidden until then — no dead toggle pre-launch).
  const showComputerToggle =
    showBuiltInToolsSection &&
    (builtInToolCatalog ?? []).some((t) => t.requiresComputer);

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

            <div className="flex items-start justify-between gap-4">
              <div className="grid gap-1">
                <Label htmlFor={`${reactId}-progressiveTools`}>
                  Progressive tool discovery
                </Label>
                <p className="text-xs text-muted-foreground">
                  Expose <code>search_mcp_tools</code> and{" "}
                  <code>load_mcp_tools</code> meta-tools instead of sending
                  every MCP tool definition every turn. <strong>Auto</strong>{" "}
                  lets the orchestrator decide based on catalog size and context
                  budget; <strong>On</strong> forces it for this host;{" "}
                  <strong>Off</strong> opts out even on large catalogs.
                </p>
              </div>
              <ToggleGroup
                id={`${reactId}-progressiveTools`}
                type="single"
                size="sm"
                variant="outline"
                // Tri-state mirroring backend semantics: undefined ⇒ Auto
                // (orchestrator may still enable above thresholds), true
                // ⇒ forced On, false ⇒ forced Off. A 2-state Switch would
                // hide Auto and let progressive discovery fire while the
                // UI showed "off".
                value={
                  value.progressiveToolDiscovery === true
                    ? "on"
                    : value.progressiveToolDiscovery === false
                    ? "off"
                    : "auto"
                }
                onValueChange={(next) => {
                  if (!next) return;
                  update({
                    progressiveToolDiscovery:
                      next === "on" ? true : next === "off" ? false : undefined,
                  });
                }}
                aria-label="Progressive tool discovery mode"
              >
                <ToggleGroupItem value="auto" aria-label="Auto (default)">
                  Auto
                </ToggleGroupItem>
                <ToggleGroupItem value="on" aria-label="On">
                  On
                </ToggleGroupItem>
                <ToggleGroupItem value="off" aria-label="Off">
                  Off
                </ToggleGroupItem>
              </ToggleGroup>
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
                      {style.chatUi.label}
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
                    requiredSet.has(id)
                  ),
                });
              }}
            />
            <ServerCheckboxList
              label="Optional servers"
              selected={value.optionalServerIds}
              available={(availableServers ?? []).filter((srv) =>
                value.serverIds.includes(srv.id)
              )}
              onChange={(optionalServerIds) => {
                // Editing the optional list should never add a server
                // that isn't in serverIds. The available pool above
                // already filters to selected required servers, but
                // belt-and-suspenders: re-clamp here too.
                const requiredSet = new Set(value.serverIds);
                update({
                  optionalServerIds: optionalServerIds.filter((id) =>
                    requiredSet.has(id)
                  ),
                });
              }}
            />
          </section>

          <Separator className="my-6" />
        </>
      ) : null}

      {showBuiltInToolsSection ? (
        <>
          <section className="space-y-4">
            {showComputerToggle ? (
              <div className="flex items-start justify-between gap-4">
                <div className="grid gap-0.5">
                  <Label htmlFor={`${reactId}-computer`}>
                    Personal computer
                  </Label>
                  <p className="text-xs text-muted-foreground">
                    Attach a per-member cloud workstation (a persistent Linux
                    sandbox). Required by computer-backed tools like Bash.
                  </p>
                </div>
                <Switch
                  id={`${reactId}-computer`}
                  checked={value.computer !== undefined}
                  onCheckedChange={(checked) => {
                    if (checked) {
                      update({ computer: { kind: "personal" } });
                    } else {
                      // Detaching the resource must also drop any
                      // computer-backed ids, or the save would fail the
                      // backend's requiresComputer invariant.
                      const computerBacked = new Set(
                        (builtInToolCatalog ?? [])
                          .filter((t) => t.requiresComputer)
                          .map((t) => t.id)
                      );
                      update({
                        computer: undefined,
                        builtInToolIds: value.builtInToolIds.filter(
                          (id) => !computerBacked.has(id)
                        ),
                      });
                    }
                  }}
                />
              </div>
            ) : null}
            <BuiltInToolCheckboxList
              label="Built-in tools"
              selected={value.builtInToolIds}
              available={builtInToolCatalog ?? []}
              computerAttached={value.computer !== undefined}
              onChange={(builtInToolIds) => update({ builtInToolIds })}
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
            onChange={(clientCapabilities) => update({ clientCapabilities })}
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
 * editors for the freeform CSP restrictTo / permissions allow sets.
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
    name:
      typeof persistedClientInfo?.name === "string"
        ? persistedClientInfo.name
        : "",
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

  // Local draft buffer for the supported-protocol-versions textarea.
  // Same shape as `clientInfoDraft`: the persisted envelope holds a
  // filtered/trimmed array, but the textarea must accept raw
  // multi-line text including the trailing newline so the user can
  // type a second version after pressing Enter. The previous shape
  // recomputed the textarea value from the filtered array on every
  // render, so pressing Enter after `2025-11-25` immediately stored
  // `["2025-11-25"]` and re-rendered without the newline — making it
  // impossible to construct a multi-version accept-list by typing
  // (you'd have to paste all versions at once).
  const persistedProtocolVersionsText = (
    profile?.initialize?.supportedProtocolVersions ?? []
  ).join("\n");
  const [protocolVersionsDraft, setProtocolVersionsDraft] = useState<string>(
    persistedProtocolVersionsText
  );
  const protocolVersionsDraftRef = useRef(protocolVersionsDraft);
  useEffect(() => {
    protocolVersionsDraftRef.current = protocolVersionsDraft;
  }, [protocolVersionsDraft]);

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
      (draftTitle === ""
        ? persistedTitle === ""
        : persistedTitle === draftTitle)
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

  // Sync the protocol-versions draft on external profile changes. Same
  // invariant as the clientInfo sync: if the persisted array equals the
  // filtered/trimmed version of the current draft, persisted reflects
  // our own write — keep the draft (including any trailing newline the
  // user just typed). Otherwise mirror persisted into the draft.
  useEffect(() => {
    const persistedJoined = (
      profile?.initialize?.supportedProtocolVersions ?? []
    ).join("\n");
    const draft = protocolVersionsDraftRef.current;
    const draftFiltered = draft
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter((line) => line !== "")
      .join("\n");
    if (persistedJoined === draftFiltered) return;
    setProtocolVersionsDraft(persistedJoined);
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
    (patch: Partial<NonNullable<HostConfigMcpProfileV1["initialize"]>>) => {
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
    [profile, onChange]
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
    [profile, updateInitialize]
  );

  const updateProtocolVersions = useCallback(
    (raw: string) => {
      // Commit raw text to the local draft (preserves trailing newlines
      // and whitespace mid-edit) and flush the filtered/trimmed array to
      // the persisted envelope. The draft is the source of truth for the
      // textarea value; the persisted envelope is the source of truth
      // for the SDK wire shape.
      protocolVersionsDraftRef.current = raw;
      setProtocolVersionsDraft(raw);

      const versions = raw
        .split(/\r?\n/)
        .map((line) => line.trim())
        .filter((line) => line !== "");
      updateInitialize({
        supportedProtocolVersions: versions.length > 0 ? versions : undefined,
      });
    },
    [updateInitialize]
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
          Pin the `clientInfo`, supported protocol versions, and sandbox policy
          this host config advertises in MCP `initialize`. Leave disabled to use
          SDK defaults — recommended for normal use.
        </p>
      </div>
    );
  }

  // Inputs read from the local drafts (which always reflect what the
  // user typed); the persisted envelope only sees filtered/complete
  // values. See the `clientInfoDraft` and `protocolVersionsDraft`
  // declarations above for rationale.
  const clientInfo = clientInfoDraft;
  const protocolVersionsText = protocolVersionsDraft;

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
            <Label
              className="text-xs font-medium"
              htmlFor="mcp-profile-client-name"
            >
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
              Both name and version are required when client identity is set.
              Saved verbatim to MCP `initialize.params.clientInfo`.
            </p>
          </div>

          <div className="grid gap-2">
            <Label
              htmlFor="mcp-profile-supported-protocol-versions"
              className="text-xs font-medium"
            >
              Supported protocol versions (one per line, first = proposed)
            </Label>
            <Textarea
              id="mcp-profile-supported-protocol-versions"
              aria-label="Supported protocol versions"
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

          <McpProfileSandboxEditor profile={profile} onChange={onChange} />
        </>
      ) : null}
    </div>
  );
}

/**
 * Sandbox subsection — CSP and permissions. Uses structured mode
 * dropdowns + raw-JSON for the more complex allowlist shapes. v1 keeps
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
      >
    ) => {
      const base: HostConfigMcpProfileV1 = profile ?? { profileVersion: 1 };
      const nextSandbox = {
        ...(base.apps?.sandbox ?? {}),
        ...patch,
      };
      const hasSandboxFields =
        nextSandbox.csp !== undefined ||
        nextSandbox.permissions !== undefined ||
        nextSandbox.sandboxAttrs !== undefined ||
        nextSandbox.allowFeatures !== undefined;
      // Preserve sibling apps fields (e.g. uiInitialize.hostInfo set by the
      // redesigned Apps Extension tab) — don't rewrite `apps` to only sandbox.
      const nextApps = { ...(base.apps ?? {}) };
      if (hasSandboxFields) nextApps.sandbox = nextSandbox;
      else delete nextApps.sandbox;
      onChange({
        ...base,
        apps: Object.keys(nextApps).length > 0 ? nextApps : undefined,
      });
    },
    [profile, onChange]
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
          restrictTo is optional and empty by default. Only set it if you want
          to narrow the view's declared CSP further than the view itself asks
          for. Per SEP-1865 it's allowlist-only and intersects the view's
          declaration — adding origins here can only block what the view would
          otherwise reach, never make a view more compatible. Leave empty to
          honor the view's declaration as-is.
        </p>
      </div>

      <McpProfileCspDomainSetEditor
        label="restrictTo (optional, narrows view declaration)"
        value={csp?.restrictTo}
        onChange={(restrictTo) =>
          updateSandbox({ csp: { ...(csp ?? {}), restrictTo } })
        }
      />

      <McpProfileCspDirectivesEditor
        value={csp?.cspDirectives}
        onChange={(cspDirectives) =>
          updateSandbox({ csp: { ...(csp ?? {}), cspDirectives } })
        }
      />

      <Separator />

      <div className="grid gap-2">
        <Label className="text-xs">Permissions mode</Label>
        <Select
          value={permissions?.mode ?? "resource-declared"}
          onValueChange={(v) => {
            const mode = v as "resource-declared" | "deny-all" | "custom";
            updateSandbox({
              permissions: {
                ...(permissions ?? {}),
                mode,
                // Drop the allow map when leaving custom; otherwise
                // appsToJson() still serializes stale grants and flipping
                // back to custom would resurrect them.
                allow: mode === "custom" ? permissions?.allow : undefined,
              },
            });
          }}
        >
          <SelectTrigger>
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="resource-declared">
              Resource-declared (default)
            </SelectItem>
            <SelectItem value="deny-all">Deny all</SelectItem>
            <SelectItem value="custom">Custom allow</SelectItem>
          </SelectContent>
        </Select>
        <p className="text-xs text-muted-foreground">
          Resource declaration is the ceiling — host can never grant a
          permission the resource didn't request.
        </p>
      </div>

      <McpProfilePermissionsAllowEditor
        mode={permissions?.mode ?? "resource-declared"}
        allow={permissions?.allow}
        onChange={(next) =>
          updateSandbox({
            permissions: {
              ...(permissions ?? {}),
              allow: next.allow,
            },
          })
        }
      />

      <Separator />

      <McpProfileSandboxAttrsEditor
        value={profile?.apps?.sandbox?.sandboxAttrs}
        onChange={(sandboxAttrs) => updateSandbox({ sandboxAttrs })}
      />

      <McpProfileAllowFeaturesEditor
        value={profile?.apps?.sandbox?.allowFeatures}
        onChange={(allowFeatures) => updateSandbox({ allowFeatures })}
      />
    </div>
  );
}

/**
 * `cspDirectives` editor — inspector-only per-directive source-expression
 * overrides emitted in the inner doc's `<meta http-equiv="Content-Security-
 * Policy">`. Each row is a directive name + comma-separated tokens.
 *
 * Not part of SEP-1865 metadata; models what real hosts emit at the browser
 * layer (e.g. `'unsafe-eval'`, `'wasm-unsafe-eval'`, `'strict-dynamic'`,
 * nonces, hashes). Stored verbatim so future tokens land here without
 * schema churn.
 */
function McpProfileCspDirectivesEditor({
  value,
  onChange,
}: {
  value: Record<string, string[]> | undefined;
  onChange: (next: Record<string, string[]> | undefined) => void;
}) {
  const fromValue = useCallback((v: Record<string, string[]> | undefined) => {
    if (!v) return [] as Array<{ name: string; tokens: string }>;
    return Object.keys(v)
      .sort()
      .map((k) => ({ name: k, tokens: (v[k] ?? []).join(", ") }));
  }, []);

  // Local draft state including in-progress blank rows the user has
  // added but not yet filled in. `commit` filters blanks out before
  // calling onChange, so without a local buffer a freshly-added blank
  // would round-trip back through `value` as nothing and disappear.
  const [draftRows, setDraftRows] = useState<
    Array<{ name: string; tokens: string }>
  >(() => fromValue(value));

  // Reconcile with external `value` changes (e.g. switching host
  // configs from the parent). Tracks the last canonical key we synced
  // to so our own commits don't trigger a re-seed that wipes blanks.
  const valueKey = useMemo(() => JSON.stringify(value ?? null), [value]);
  const lastSyncedKeyRef = useRef(valueKey);
  useEffect(() => {
    if (lastSyncedKeyRef.current === valueKey) return;
    lastSyncedKeyRef.current = valueKey;
    setDraftRows((prev) => {
      const fromVal = fromValue(value);
      // Preserve any blank/in-progress rows the user is still editing.
      const blanks = prev.filter(
        (r) => r.name.trim() === "" || r.tokens.trim() === ""
      );
      return [...fromVal, ...blanks];
    });
  }, [valueKey, value, fromValue]);

  const commit = useCallback(
    (next: Array<{ name: string; tokens: string }>) => {
      const out: Record<string, string[]> = {};
      for (const row of next) {
        const name = row.name.trim();
        if (name === "") continue;
        const tokens = row.tokens
          .split(",")
          .map((t) => t.trim())
          .filter((t) => t.length > 0);
        if (tokens.length === 0) continue;
        out[name] = tokens;
      }
      const built = Object.keys(out).length > 0 ? out : undefined;
      lastSyncedKeyRef.current = JSON.stringify(built ?? null);
      onChange(built);
    },
    [onChange]
  );

  const updateRow = (
    idx: number,
    patch: Partial<{ name: string; tokens: string }>
  ) => {
    const next = draftRows.map((r, i) => (i === idx ? { ...r, ...patch } : r));
    setDraftRows(next);
    commit(next);
  };

  const removeRow = (idx: number) => {
    const next = draftRows.filter((_, i) => i !== idx);
    setDraftRows(next);
    commit(next);
  };

  const addRow = () => {
    // Blank rows live only in local draft state until the user types
    // both a name and at least one token — `commit` filters blanks out,
    // so committing here would no-op and the row would never appear.
    setDraftRows((prev) => [...prev, { name: "", tokens: "" }]);
  };

  const rows = draftRows;

  return (
    <div className="grid gap-2">
      <Label className="text-xs">cspDirectives (inspector-only)</Label>
      <p className="text-xs text-muted-foreground">
        Adds source expressions (e.g. <code>'unsafe-eval'</code>) to the inner
        doc CSP. Not in SEP-1865 metadata; models what real hosts emit at the
        browser layer. Comma-separate tokens; values stored verbatim so
        nonces/hashes/<code>'strict-dynamic'</code> round-trip.
      </p>
      {rows.length === 0 ? (
        <p className="text-xs italic text-muted-foreground">
          No directive overrides.
        </p>
      ) : (
        <div className="grid gap-1">
          {rows.map((row, idx) => (
            <div key={idx} className="grid grid-cols-[1fr_2fr_auto] gap-2">
              <Input
                value={row.name}
                placeholder="script-src"
                onChange={(e) => updateRow(idx, { name: e.target.value })}
                list="csp-directive-name-suggestions"
              />
              <Input
                value={row.tokens}
                placeholder="'unsafe-eval', 'wasm-unsafe-eval'"
                onChange={(e) => updateRow(idx, { tokens: e.target.value })}
              />
              <Button
                type="button"
                variant="ghost"
                size="sm"
                onClick={() => removeRow(idx)}
              >
                Remove
              </Button>
            </div>
          ))}
        </div>
      )}
      <datalist id="csp-directive-name-suggestions">
        <option value="script-src" />
        <option value="style-src" />
        <option value="img-src" />
        <option value="connect-src" />
        <option value="frame-src" />
        <option value="media-src" />
        <option value="font-src" />
        <option value="base-uri" />
        <option value="default-src" />
      </datalist>
      <Button type="button" variant="outline" size="sm" onClick={addRow}>
        + add directive
      </Button>
    </div>
  );
}

/**
 * `sandboxAttrs` editor — inspector-only extra outer/inner iframe `sandbox=`
 * tokens unioned with the mandatory `allow-scripts allow-same-origin`.
 * Each known token is a toggle; a free-text input accepts unknown tokens
 * for forward-compat.
 */
const KNOWN_SANDBOX_TOKENS = [
  "allow-scripts",
  "allow-same-origin",
  "allow-forms",
  "allow-popups",
  "allow-popups-to-escape-sandbox",
  "allow-modals",
  "allow-downloads",
  "allow-presentation",
  "allow-pointer-lock",
  "allow-top-navigation",
  "allow-top-navigation-by-user-activation",
  "allow-orientation-lock",
] as const;
const MANDATORY_SANDBOX_TOKENS = new Set<string>([
  "allow-scripts",
  "allow-same-origin",
]);

function McpProfileSandboxAttrsEditor({
  value,
  onChange,
}: {
  value: string[] | undefined;
  onChange: (next: string[] | undefined) => void;
}) {
  const [customDraft, setCustomDraft] = useState("");
  // `value === undefined` (no profile opinion) vs `value === []` (explicit
  // "spec-minimum only") are SEMANTICALLY DIFFERENT at the runtime layer:
  // the renderer treats undefined as "fall back to the legacy permissive
  // baseline" and any array (including empty) as "the profile is
  // authoritative — use spec-mandated tokens plus exactly these." The
  // toggle below is the user-facing affordance for that opt-in.
  const isEnabled = Array.isArray(value);
  const active = useMemo(() => new Set(value ?? []), [value]);

  const commit = (next: Set<string>) => {
    const arr = Array.from(next)
      .map((t) => t.trim())
      .filter((t) => t.length > 0 && !MANDATORY_SANDBOX_TOKENS.has(t));
    arr.sort();
    // Don't collapse empty → undefined. Once the user has opted in, an
    // empty array IS the stricter "spec-minimum only" host model and
    // must round-trip as `[]`.
    onChange(arr);
  };

  const setEnabled = (enabled: boolean) => {
    if (enabled === isEnabled) return;
    if (enabled) {
      // Opt in. Seed with any tokens that were already on `value` (would
      // only happen if value was [...] before, but isEnabled would be true
      // already — keeping the branch defensive).
      onChange(Array.from(active).sort());
    } else {
      // Opt out → revert to legacy permissive default.
      onChange(undefined);
    }
  };

  const toggle = (token: string) => {
    if (!isEnabled) return;
    if (MANDATORY_SANDBOX_TOKENS.has(token)) return;
    const next = new Set(active);
    if (next.has(token)) next.delete(token);
    else next.add(token);
    commit(next);
  };

  const addCustom = () => {
    if (!isEnabled) return;
    const t = customDraft.trim();
    if (t.length === 0) return;
    if (MANDATORY_SANDBOX_TOKENS.has(t)) {
      setCustomDraft("");
      return;
    }
    const next = new Set(active);
    next.add(t);
    commit(next);
    setCustomDraft("");
  };

  // Anything in value that isn't in the known list — surface as a chip too
  // so the user can see it and remove it.
  const unknownTokens = Array.from(active).filter(
    (t) =>
      !KNOWN_SANDBOX_TOKENS.includes(t as (typeof KNOWN_SANDBOX_TOKENS)[number])
  );

  return (
    <div className="grid gap-2">
      <div className="flex items-center justify-between">
        <Label className="text-xs">sandboxAttrs (inspector-only)</Label>
        <div className="flex items-center gap-2">
          <span className="text-xs text-muted-foreground">
            Model host sandbox tokens
          </span>
          <Switch
            checked={isEnabled}
            onCheckedChange={setEnabled}
            aria-label="Model host sandbox tokens"
          />
        </div>
      </div>
      <p className="text-xs text-muted-foreground">
        {isEnabled
          ? "Profile is authoritative: the iframe gets allow-scripts / allow-same-origin (spec-mandated) plus exactly the tokens checked below. Leave everything off to model a host that emits the spec minimum only."
          : "Using the inspector's legacy permissive sandbox default. Toggle on to model the real host's emitted sandbox= tokens — empty = spec minimum only."}
      </p>
      <div
        className={`flex flex-wrap gap-1 ${
          isEnabled ? "" : "opacity-50 pointer-events-none"
        }`}
      >
        {KNOWN_SANDBOX_TOKENS.map((token) => {
          const isMandatory = MANDATORY_SANDBOX_TOKENS.has(token);
          const isActive = isEnabled && (isMandatory || active.has(token));
          return (
            <button
              key={token}
              type="button"
              onClick={() => toggle(token)}
              disabled={isMandatory || !isEnabled}
              className={`rounded-md border px-2 py-0.5 text-xs ${
                isActive
                  ? "border-primary bg-primary/10 text-foreground"
                  : "border-border/40 text-muted-foreground hover:bg-muted/40"
              } ${
                isMandatory ? "cursor-not-allowed opacity-70" : "cursor-pointer"
              }`}
              title={isMandatory ? "Spec-mandated (always on)" : token}
            >
              {token}
              {isMandatory ? " (locked)" : ""}
            </button>
          );
        })}
        {unknownTokens.map((token) => (
          <button
            key={token}
            type="button"
            onClick={() => toggle(token)}
            className="rounded-md border border-primary bg-primary/10 px-2 py-0.5 text-xs"
            title={token}
          >
            {token} ×
          </button>
        ))}
      </div>
      <div
        className={`flex gap-2 ${
          isEnabled ? "" : "opacity-50 pointer-events-none"
        }`}
      >
        <Input
          value={customDraft}
          placeholder="custom token"
          disabled={!isEnabled}
          onChange={(e) => setCustomDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              e.preventDefault();
              addCustom();
            }
          }}
        />
        <Button
          type="button"
          variant="outline"
          size="sm"
          disabled={!isEnabled}
          onClick={addCustom}
        >
          Add
        </Button>
      </div>
    </div>
  );
}

/**
 * `allowFeatures` editor — inspector-only extra Permissions Policy entries
 * appended to outer/inner iframe `allow=`. Keys are RAW kebab Permissions
 * Policy tokens; values are allowlist strings.
 *
 * The 4 spec features (camera / microphone / geolocation / clipboard-write)
 * live in the Permissions section above and cannot be added here — entering
 * them shows an inline warning and the canonicalizer drops them on save as
 * a defense-in-depth safeguard.
 */
function McpProfileAllowFeaturesEditor({
  value,
  onChange,
}: {
  value: Record<string, string> | undefined;
  onChange: (next: Record<string, string> | undefined) => void;
}) {
  const specFeatures = useMemo(
    () => new Set<string>(SEP_1865_PERMISSION_FEATURES),
    []
  );

  const fromValue = useCallback((v: Record<string, string> | undefined) => {
    if (!v) return [] as Array<{ key: string; allowlist: string }>;
    return Object.keys(v)
      .sort()
      .map((k) => ({ key: k, allowlist: v[k] ?? "" }));
  }, []);

  // Local draft state including in-progress blanks. `commit` filters
  // blank/spec-feature rows out before calling onChange, so without a
  // local buffer a freshly-added blank row would round-trip back through
  // `value` as nothing and disappear before the user can type anything.
  const [draftRows, setDraftRows] = useState<
    Array<{ key: string; allowlist: string }>
  >(() => fromValue(value));

  const valueKey = useMemo(() => JSON.stringify(value ?? null), [value]);
  const lastSyncedKeyRef = useRef(valueKey);
  useEffect(() => {
    if (lastSyncedKeyRef.current === valueKey) return;
    lastSyncedKeyRef.current = valueKey;
    setDraftRows((prev) => {
      const fromVal = fromValue(value);
      // Preserve any rows the user is mid-edit (blank keys, blank
      // allowlists, or spec-feature keys that haven't been corrected
      // yet — the latter would otherwise vanish as soon as they were
      // typed, losing the inline warning's teaching moment).
      const inProgress = prev.filter(
        (r) =>
          r.key.trim() === "" ||
          r.allowlist.trim() === "" ||
          specFeatures.has(r.key.trim())
      );
      return [...fromVal, ...inProgress];
    });
  }, [valueKey, value, fromValue, specFeatures]);

  // Same `undefined` vs `{}` semantic as sandboxAttrs above: the
  // renderer treats `allowFeatures === undefined` as the legacy fallback
  // (re-adds `local-network-access *` / `midi *`); any Record value
  // (including the empty {}) is the authoritative profile model and
  // drops those legacy defaults. The toggle below is the explicit opt-in
  // — without it, removing the last row collapsed `{}` to `undefined`
  // and silently flipped a stricter-host profile back to permissive.
  const isEnabled = value !== undefined;

  const commit = useCallback(
    (next: Array<{ key: string; allowlist: string }>) => {
      const out: Record<string, string> = {};
      for (const row of next) {
        const key = row.key.trim();
        if (key === "") continue;
        // Defense in depth — the canonicalizer drops these too, but we
        // refuse to commit them locally so the warning has teeth.
        if (specFeatures.has(key)) continue;
        const allowlist = row.allowlist.trim();
        if (allowlist === "") continue;
        out[key] = allowlist;
      }
      // Don't collapse empty → undefined. Once the user has opted in,
      // an empty record IS the stricter "spec-features-only" host model
      // and must round-trip as `{}`.
      lastSyncedKeyRef.current = JSON.stringify(out);
      onChange(out);
    },
    [onChange, specFeatures]
  );

  const setEnabled = (enabled: boolean) => {
    if (enabled === isEnabled) return;
    if (enabled) {
      onChange({});
    } else {
      // Opt out → revert to legacy permissive default.
      onChange(undefined);
    }
  };

  const updateRow = (
    idx: number,
    patch: Partial<{ key: string; allowlist: string }>
  ) => {
    if (!isEnabled) return;
    const next = draftRows.map((r, i) => (i === idx ? { ...r, ...patch } : r));
    setDraftRows(next);
    commit(next);
  };

  const removeRow = (idx: number) => {
    if (!isEnabled) return;
    const next = draftRows.filter((_, i) => i !== idx);
    setDraftRows(next);
    commit(next);
  };

  const addRow = () => {
    if (!isEnabled) return;
    // Blank rows live only in local draft state until the user types
    // both a feature name and an allowlist — `commit` would filter them
    // out, so committing here would no-op and the row would never appear.
    setDraftRows((prev) => [...prev, { key: "", allowlist: "*" }]);
  };

  const rows = draftRows;

  return (
    <div className="grid gap-2">
      <div className="flex items-center justify-between">
        <Label className="text-xs">allowFeatures (inspector-only)</Label>
        <div className="flex items-center gap-2">
          <span className="text-xs text-muted-foreground">
            Model host allow features
          </span>
          <Switch
            checked={isEnabled}
            onCheckedChange={setEnabled}
            aria-label="Model host allow features"
          />
        </div>
      </div>
      <p className="text-xs text-muted-foreground">
        {isEnabled
          ? "Profile is authoritative: the outer iframe's allow= is the 4 spec permissions (above) plus exactly the features listed below. Leave empty to model a host that grants only the spec features."
          : "Using the inspector's legacy outer-iframe allow= default (adds local-network-access / midi on top of spec permissions). Toggle on to model the real host's emitted allow= — empty = spec permissions only."}
      </p>
      <div className={isEnabled ? "" : "opacity-50 pointer-events-none"}>
        {rows.length === 0 ? (
          <p className="text-xs italic text-muted-foreground">
            No extra features.
          </p>
        ) : (
          <div className="grid gap-1">
            {rows.map((row, idx) => {
              const isSpec = specFeatures.has(row.key.trim());
              return (
                <div key={idx} className="grid gap-1">
                  <div className="grid grid-cols-[1fr_1fr_auto] gap-2">
                    <Input
                      value={row.key}
                      placeholder="fullscreen"
                      disabled={!isEnabled}
                      onChange={(e) => updateRow(idx, { key: e.target.value })}
                    />
                    <Input
                      value={row.allowlist}
                      placeholder="*"
                      disabled={!isEnabled}
                      onChange={(e) =>
                        updateRow(idx, { allowlist: e.target.value })
                      }
                    />
                    <Button
                      type="button"
                      variant="ghost"
                      size="sm"
                      disabled={!isEnabled}
                      onClick={() => removeRow(idx)}
                    >
                      Remove
                    </Button>
                  </div>
                  {isSpec ? (
                    <p className="text-xs text-destructive">
                      Use Permissions above for spec features — this row will be
                      dropped on save.
                    </p>
                  ) : null}
                </div>
              );
            })}
          </div>
        )}
        <Button
          type="button"
          variant="outline"
          size="sm"
          disabled={!isEnabled}
          onClick={addRow}
        >
          + add feature
        </Button>
      </div>
    </div>
  );
}

/**
 * Per-permission allow grid for the four MCP Apps permission keys
 * spec'd by SEP-1865 (`camera`, `microphone`, `geolocation`,
 * `clipboardWrite` — camelCase, matching the resource's `_meta.ui.
 * permissions` declaration; the kebab-case `clipboard-write` form
 * belongs at the iframe `allow=` boundary, not in profile state).
 *
 * SEP-1865 is allowlist-only — there is no deny concept. Permissions
 * are positively declared; absence = not granted.
 *
 * - Allow column: only meaningful in `custom` mode (the resolver seeds
 *   the candidate set from `policy.allow` in custom mode); rendered
 *   disabled in resource-declared / deny-all so the user can see the
 *   shape without it being a no-op trap.
 *
 * Resource declaration is still the ceiling — toggling `allow` on for a
 * permission the resource didn't request yields nothing at runtime. The
 * help text below the grid spells this out.
 */
function McpProfilePermissionsAllowEditor({
  mode,
  allow,
  onChange,
}: {
  mode: "resource-declared" | "deny-all" | "custom";
  allow: Record<string, boolean> | undefined;
  onChange: (next: { allow: Record<string, boolean> | undefined }) => void;
}) {
  const PERMISSION_KEYS: ReadonlyArray<{ key: string; label: string }> = [
    { key: "camera", label: "Camera" },
    { key: "microphone", label: "Microphone" },
    { key: "geolocation", label: "Geolocation" },
    { key: "clipboardWrite", label: "Clipboard write" },
  ];
  const allowEnabled = mode === "custom";
  const allowMap = allow ?? {};

  const emitChange = (nextAllow: Record<string, boolean>) => {
    // Collapse empty objects to `undefined` so the persisted envelope
    // stays minimal and round-trips identically (matches the mcpProfile
    // hash-dedupe expectations enforced by the backend).
    const hasAllowEntries = Object.keys(nextAllow).length > 0;
    onChange({
      allow: hasAllowEntries ? nextAllow : undefined,
    });
  };

  const toggleAllow = (key: string, granted: boolean) => {
    const next = { ...allowMap };
    if (granted) {
      next[key] = true;
    } else {
      delete next[key];
    }
    emitChange(next);
  };

  return (
    <div className="grid gap-2 rounded-md border border-border/20 p-2">
      <div className="grid grid-cols-[1fr_auto] items-center gap-x-3 gap-y-1 text-xs">
        <span className="font-medium text-muted-foreground">Permission</span>
        <span
          className={`font-medium ${
            allowEnabled ? "text-muted-foreground" : "text-muted-foreground/50"
          }`}
          title={
            allowEnabled
              ? "Allow grants the permission (only in custom mode; resource declaration is the ceiling)"
              : "Allow is only used in custom mode"
          }
        >
          Allow
        </span>
        {PERMISSION_KEYS.map(({ key, label }) => (
          <PermissionRow
            key={key}
            label={label}
            allowChecked={!!allowMap[key]}
            allowEnabled={allowEnabled}
            onToggleAllow={(v) => toggleAllow(key, v)}
          />
        ))}
      </div>
      <p className="text-xs text-muted-foreground">
        Resource declaration is the ceiling — toggling Allow for a permission
        the resource didn't request has no runtime effect.
      </p>
    </div>
  );
}

function PermissionRow({
  label,
  allowChecked,
  allowEnabled,
  onToggleAllow,
}: {
  label: string;
  allowChecked: boolean;
  allowEnabled: boolean;
  onToggleAllow: (v: boolean) => void;
}) {
  return (
    <>
      <span className="text-xs">{label}</span>
      <Switch
        checked={allowChecked}
        disabled={!allowEnabled}
        onCheckedChange={onToggleAllow}
        aria-label={`Allow ${label}`}
      />
    </>
  );
}

/**
 * Reusable "string[] backed by a multi-line textarea" draft buffer.
 *
 * Same problem `protocolVersionsDraft` was introduced to fix: when a
 * textarea's `value` is recomputed every render from a filtered+trimmed
 * persisted array, pressing Enter after a non-empty line immediately
 * strips the trailing newline on the next render, making multi-line
 * entries impossible to type (only paste-all-at-once works).
 *
 * Returns `{ value, onChange }` ready to drop into a controlled
 * `<Textarea>`. The draft string is the source of truth for the
 * textarea; the persisted array is the source of truth for the wire
 * shape. Sync effect mirrors persisted into the draft when an external
 * write (reset, DTO reload, programmatic patch) diverges from the
 * draft's filtered form.
 *
 * Future cleanup: the inline protocolVersionsDraft logic above could
 * be migrated to this hook. Left alone in this commit so the rich
 * scenario-comments there aren't lost in a refactor that doesn't
 * change behavior.
 */
function useNewlineListDraft(
  persistedList: ReadonlyArray<string>,
  onPersistedChange: (next: string[]) => void
) {
  const persistedJoined = persistedList.join("\n");
  const [draft, setDraft] = useState<string>(persistedJoined);
  const draftRef = useRef(draft);
  useEffect(() => {
    draftRef.current = draft;
  }, [draft]);

  useEffect(() => {
    const draftFiltered = draftRef.current
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter((line) => line !== "")
      .join("\n");
    if (persistedJoined === draftFiltered) return;
    setDraft(persistedJoined);
  }, [persistedJoined]);

  const onChange = useCallback(
    (raw: string) => {
      // Commit raw text to the draft (preserves trailing newlines + in-
      // progress whitespace) and flush the filtered/trimmed list to the
      // persisted owner. Caller decides what to do with an empty list.
      draftRef.current = raw;
      setDraft(raw);
      const next = raw
        .split(/\r?\n/)
        .map((line) => line.trim())
        .filter((line) => line !== "");
      onPersistedChange(next);
    },
    [onPersistedChange]
  );

  return { value: draft, onChange };
}

/**
 * Single editor for one CspDomainSet (four parallel directive lists).
 * One textarea per directive — JSON-array style — keeps the surface lean
 * while exposing all four directives the spec defines.
 *
 * Each per-directive textarea uses {@link useNewlineListDraft} so users
 * can actually type a multi-line list. Without the draft buffer the
 * filtered-from-persisted `value` would strip the trailing newline on
 * every keystroke (cursor jumps to end of line; second line impossible
 * to start). Same fix shape the protocol versions field already uses.
 */
function McpProfileCspDomainSetEditor({
  label,
  value,
  onChange,
}: {
  label: string;
  value:
    | {
        connectDomains?: string[];
        resourceDomains?: string[];
        frameDomains?: string[];
        baseUriDomains?: string[];
      }
    | undefined;
  onChange: (
    next:
      | {
          connectDomains?: string[];
          resourceDomains?: string[];
          frameDomains?: string[];
          baseUriDomains?: string[];
        }
      | undefined
  ) => void;
}) {
  const directives: Array<{
    key:
      | "connectDomains"
      | "resourceDomains"
      | "frameDomains"
      | "baseUriDomains";
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

  /**
   * Commit a per-directive list to the parent's `value`, collapsing the
   * whole set to `undefined` when every directive is empty. The collapse
   * is critical: the backend canonicalizer distinguishes
   * `undefined` from `{}` on the hash, so passing an empty object here
   * would silently bump the hostConfig hash and create a duplicate row.
   */
  const commitDirective = useCallback(
    (key: (typeof directives)[number]["key"], items: string[]) => {
      const nextValue = { ...(value ?? {}) };
      if (items.length === 0) {
        delete nextValue[key];
      } else {
        nextValue[key] = items;
      }
      const hasAny = directives.some((d) => {
        const list = nextValue[d.key];
        return Array.isArray(list) && list.length > 0;
      });
      onChange(hasAny ? nextValue : undefined);
    },
    // `directives` is a module-local stable array literal; safe to omit.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [value, onChange]
  );

  return (
    <div className="grid gap-2" role="group" aria-label={label}>
      <Label className="text-xs">{label}</Label>
      {directives.map((d) => (
        <McpProfileCspDirectiveTextarea
          key={d.key}
          label={label}
          directiveKey={d.key}
          directiveLabel={d.directiveLabel}
          placeholder={d.placeholder}
          persistedList={value?.[d.key] ?? EMPTY_DIRECTIVE_LIST}
          onPersistedChange={(next) => commitDirective(d.key, next)}
        />
      ))}
    </div>
  );
}

/**
 * Stable empty-array sentinel used as the default `persistedList` for
 * unconfigured directives. Keeps the draft hook's `persistedJoined`
 * memoization stable across renders that don't actually change the
 * list — otherwise a fresh `[]` per render would invalidate the sync
 * effect's `useEffect([persistedJoined])` dependency on every parent
 * rerender and could clobber an in-progress edit.
 */
const EMPTY_DIRECTIVE_LIST: ReadonlyArray<string> = Object.freeze([]);

/**
 * One per-directive textarea inside a CspDomainSet. Lives at its own
 * component scope so {@link useNewlineListDraft} runs at component top
 * level (React's rules-of-hooks require this — can't call hooks inside
 * a `.map()` callback in the parent).
 */
function McpProfileCspDirectiveTextarea({
  label,
  directiveKey,
  directiveLabel,
  placeholder,
  persistedList,
  onPersistedChange,
}: {
  label: string;
  directiveKey: string;
  directiveLabel: string;
  placeholder: string;
  persistedList: ReadonlyArray<string>;
  onPersistedChange: (next: string[]) => void;
}) {
  const { value, onChange } = useNewlineListDraft(
    persistedList,
    onPersistedChange
  );
  return (
    <div className="grid gap-1">
      {/* Per-directive label is a real DOM <label> for screen readers.
          The placeholder is illustrative, not the accessible name —
          relying on placeholder text alone fails WCAG 1.3.1 / 4.1.2. */}
      <Label
        htmlFor={`mcp-profile-csp-${label}-${directiveKey}`}
        className="text-[10px] font-mono uppercase text-muted-foreground"
      >
        {directiveLabel}
      </Label>
      <Textarea
        id={`mcp-profile-csp-${label}-${directiveKey}`}
        aria-label={`${label} ${directiveLabel}`}
        rows={2}
        className="font-mono text-xs"
        placeholder={placeholder}
        value={value}
        onChange={(e) => onChange(e.target.value)}
      />
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
    [hostStyle]
  );
  const profilePresetJson = useMemo(
    () => JSON.stringify(profilePreset, null, 2),
    [profilePreset]
  );
  const isOverriding = override !== undefined;
  // When the user hasn't set an override, seed the editor with the profile
  // preset (writeable copy) so they have a visible starting point for edits.
  const editorValue = isOverriding
    ? override
    : (profilePreset as Record<string, unknown>);

  return (
    <div className="grid gap-2">
      <div className="flex items-center justify-between gap-2">
        <Label>Client capabilities override (JSON)</Label>
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
  raw: Record<string, unknown>
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
    [selectedSet, onChange]
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
    [onErrorChange]
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
        if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
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
          2
        );
        onChange(parsed as Record<string, unknown>);
      } catch (err) {
        setError(err instanceof Error ? err.message : "Invalid JSON");
      }
    },
    [onChange, setError]
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
      {error ? <p className="text-xs text-destructive">{error}</p> : null}
    </div>
  );
}
