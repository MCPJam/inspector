import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import {
  AppWindow,
  ArrowDownToLine,
  ChevronDown,
  ChevronRight,
  ExternalLink,
  Languages,
  MessagesSquare,
  Server,
  TerminalSquare,
} from "lucide-react";
import { Button } from "@mcpjam/design-system/button";
import { Dialog, DialogContent } from "@mcpjam/design-system/dialog";
import { Input } from "@mcpjam/design-system/input";
import { Switch } from "@mcpjam/design-system/switch";
import { Textarea } from "@mcpjam/design-system/textarea";
import {
  resolveEffectiveHostCapabilities,
  type HostConfigInputV2,
  type HostConfigMcpProfileV1,
  type CspDomainSet,
} from "@/lib/host-config-v2";
import { getHostCapabilitiesForStyle } from "@/lib/host-styles";
import {
  AddItemPill,
  CapabilityToggleRow,
  Chip,
  FieldRow,
  FocusBlock,
  SegmentedControl,
} from "./primitives";
import { fieldsWithIssues } from "./useHostDraftValidation";
import type { HostAttentionIssue } from "../types";

const EXT_ID = "io.modelcontextprotocol/ui";
const DEFAULT_MIME = "text/html;profile=mcp-app";

type SandboxMode = "host-default" | "declared" | "relaxed";

interface AppsExtensionTabProps {
  draft: HostConfigInputV2;
  onDraftChange: (
    updater: (prev: HostConfigInputV2) => HostConfigInputV2,
  ) => void;
  attention: ReadonlyArray<HostAttentionIssue>;
}

/** Read the extension blob (or null if not advertised). */
function readExtension(
  draft: HostConfigInputV2,
): { mimeTypes: string[] } | null {
  const ext = (draft.clientCapabilities?.extensions as
    | Record<string, unknown>
    | undefined)?.[EXT_ID];
  if (!ext || typeof ext !== "object") return null;
  const mimeTypes = Array.isArray((ext as { mimeTypes?: unknown }).mimeTypes)
    ? ((ext as { mimeTypes: unknown[] }).mimeTypes.filter(
        (m): m is string => typeof m === "string",
      ) as string[])
    : [];
  return { mimeTypes };
}

/**
 * Write the extension blob. `null` removes the entry entirely (extension
 * off). Cleans up an empty `extensions` map so the snapshot hash stays
 * minimal.
 */
function writeExtension(
  draft: HostConfigInputV2,
  next: { mimeTypes: string[] } | null,
): HostConfigInputV2 {
  const existingCaps = { ...draft.clientCapabilities };
  const existingExtensions = {
    ...((existingCaps.extensions as Record<string, unknown>) ?? {}),
  };
  if (next === null) {
    delete existingExtensions[EXT_ID];
  } else {
    existingExtensions[EXT_ID] = { mimeTypes: next.mimeTypes };
  }
  if (Object.keys(existingExtensions).length === 0) {
    delete existingCaps.extensions;
  } else {
    existingCaps.extensions = existingExtensions;
  }
  return { ...draft, clientCapabilities: existingCaps };
}

type CspBlock = NonNullable<
  NonNullable<HostConfigMcpProfileV1["apps"]>["sandbox"]
>["csp"];
type PermsBlock = NonNullable<
  NonNullable<HostConfigMcpProfileV1["apps"]>["sandbox"]
>["permissions"];

/**
 * Apply a mutation to the mcpProfile envelope and collapse any empty
 * sections back to `undefined`. Mirrors the "undefined ≠ empty envelope"
 * rule in host-config-v2.ts so two states (no override vs. opted-in empty)
 * hash distinctly on the backend.
 */
function withMcpProfile(
  prev: HostConfigInputV2,
  mutate: (base: HostConfigMcpProfileV1) => HostConfigMcpProfileV1,
): HostConfigInputV2 {
  const base: HostConfigMcpProfileV1 =
    prev.mcpProfile ?? { profileVersion: 1 };
  return { ...prev, mcpProfile: collapseProfile(mutate(base)) };
}

function collapseProfile(
  profile: HostConfigMcpProfileV1,
): HostConfigMcpProfileV1 | undefined {
  const init = profile.initialize;
  const initEmpty =
    !init ||
    (init.clientInfo === undefined &&
      (!init.supportedProtocolVersions ||
        init.supportedProtocolVersions.length === 0));

  const apps = profile.apps;
  const csp = apps?.sandbox?.csp;
  const cspEmpty =
    !csp ||
    (csp.mode === undefined &&
      !csp.restrictTo &&
      !csp.deny &&
      !csp.extensions);
  const perms = apps?.sandbox?.permissions;
  const permsEmpty =
    !perms ||
    (perms.mode === undefined &&
      (!perms.allow || Object.keys(perms.allow).length === 0) &&
      (!perms.deny || perms.deny.length === 0) &&
      !perms.extensions);
  const sandboxEmpty = cspEmpty && permsEmpty;
  const uiHostInfo = apps?.uiInitialize?.hostInfo;
  const uiEmpty = uiHostInfo === undefined;
  const appsEmpty = sandboxEmpty && uiEmpty;

  const profileEmpty = initEmpty && appsEmpty && !profile.extensions;
  if (profileEmpty) return undefined;

  const out: HostConfigMcpProfileV1 = { profileVersion: 1 };
  if (!initEmpty) out.initialize = init;
  if (!appsEmpty) {
    const appsOut: NonNullable<HostConfigMcpProfileV1["apps"]> = {};
    if (!sandboxEmpty) {
      const sandOut: NonNullable<
        NonNullable<HostConfigMcpProfileV1["apps"]>["sandbox"]
      > = {};
      if (!cspEmpty) sandOut.csp = csp;
      if (!permsEmpty) sandOut.permissions = perms;
      appsOut.sandbox = sandOut;
    }
    if (!uiEmpty) appsOut.uiInitialize = { hostInfo: uiHostInfo };
    out.apps = appsOut;
  }
  if (profile.extensions) out.extensions = profile.extensions;
  return out;
}

function patchCsp(
  prev: HostConfigInputV2,
  patch: (csp: NonNullable<CspBlock>) => NonNullable<CspBlock>,
): HostConfigInputV2 {
  return withMcpProfile(prev, (base) => ({
    ...base,
    apps: {
      ...base.apps,
      sandbox: {
        ...base.apps?.sandbox,
        csp: patch(base.apps?.sandbox?.csp ?? {}),
      },
    },
  }));
}

function patchPermissions(
  prev: HostConfigInputV2,
  patch: (perms: NonNullable<PermsBlock>) => NonNullable<PermsBlock>,
): HostConfigInputV2 {
  return withMcpProfile(prev, (base) => ({
    ...base,
    apps: {
      ...base.apps,
      sandbox: {
        ...base.apps?.sandbox,
        permissions: patch(base.apps?.sandbox?.permissions ?? {}),
      },
    },
  }));
}

const HOST_CAPABILITY_DEFS: ReadonlyArray<{
  key: string;
  icon: ReactNode;
  label: string;
  description: string;
  /** Some capability values carry a sub-claim (e.g. message.text). */
  subClaim?: { key: string; label: string };
}> = [
  {
    key: "openLinks",
    icon: <ExternalLink className="size-3.5" />,
    label: "openLinks",
    description: "Open external URLs requested by Views.",
  },
  {
    key: "serverTools",
    icon: <TerminalSquare className="size-3.5" />,
    label: "serverTools",
    description: "Proxy tool calls to MCP servers.",
    subClaim: { key: "listChanged", label: "listChanged" },
  },
  {
    key: "serverResources",
    icon: <Server className="size-3.5" />,
    label: "serverResources",
    description: "Proxy resource reads to MCP servers.",
  },
  {
    key: "logging",
    icon: <TerminalSquare className="size-3.5" />,
    label: "logging",
    description: "Accept log messages from Views.",
  },
  {
    key: "message",
    icon: <MessagesSquare className="size-3.5" />,
    label: "message",
    description: "Let Views send chat messages back to the host.",
    subClaim: { key: "text", label: "text" },
  },
  {
    key: "updateModelContext",
    icon: <Languages className="size-3.5" />,
    label: "updateModelContext",
    description: "Let Views update the model context.",
    subClaim: { key: "text", label: "text" },
  },
];

export function AppsExtensionTab({
  draft,
  onDraftChange,
  attention,
}: AppsExtensionTabProps) {
  const issues = fieldsWithIssues(attention, "apps");
  const extension = readExtension(draft);
  const enabled = extension !== null;
  const mimeTypes = extension?.mimeTypes ?? [];

  const preset = useMemo(
    () =>
      getHostCapabilitiesForStyle(draft.hostStyle) as Record<string, unknown>,
    [draft.hostStyle],
  );
  const effective = useMemo(
    () =>
      resolveEffectiveHostCapabilities({
        hostStyle: draft.hostStyle,
        hostCapabilitiesOverride: draft.hostCapabilitiesOverride,
      }) as Record<string, unknown>,
    [draft.hostStyle, draft.hostCapabilitiesOverride],
  );

  const [addingMime, setAddingMime] = useState(false);
  const [mimeDraft, setMimeDraft] = useState("");

  const toggleExtension = (next: boolean) => {
    onDraftChange((prev) =>
      writeExtension(
        prev,
        next ? { mimeTypes: [DEFAULT_MIME] } : null,
      ),
    );
  };

  const updateMimeTypes = (next: string[]) => {
    onDraftChange((prev) => writeExtension(prev, { mimeTypes: next }));
  };

  // Host capabilities override mechanics. Per the plan + memory rule
  // ("Advertise = enforce"), the override is a partial record that
  // shadows the preset key-by-key. Per-row state derives from whether
  // `hostCapabilitiesOverride` defines the key.
  const overrideMap = (draft.hostCapabilitiesOverride ?? {}) as Record<
    string,
    unknown
  >;

  const setOverrideKey = (key: string, value: unknown | undefined) => {
    onDraftChange((prev) => {
      const cur = (prev.hostCapabilitiesOverride ?? {}) as Record<
        string,
        unknown
      >;
      // Strip `sandbox` defensively from any override write (matches the
      // rule in resolveEffectiveHostCapabilities — sandbox is per-resource
      // at runtime, not a vendor trait).
      const { sandbox: _sandbox, ...rest } = cur;
      const next: Record<string, unknown> = { ...rest };
      if (value === undefined) {
        delete next[key];
      } else {
        next[key] = value;
      }
      // Override stays defined even when empty (`{}` = advertise nothing);
      // only the explicit "Reset to preset" button writes `undefined`.
      return { ...prev, hostCapabilitiesOverride: next };
    });
  };

  const resetOverrideToPreset = () => {
    onDraftChange((prev) => ({
      ...prev,
      hostCapabilitiesOverride: undefined,
    }));
  };

  // Sandbox CSP state.
  const sandboxCsp = draft.mcpProfile?.apps?.sandbox?.csp;
  const sandboxMode: SandboxMode = (sandboxCsp?.mode ??
    "host-default") as SandboxMode;

  // Read-only "view JSON" surface.
  const [showJson, setShowJson] = useState(false);
  const previewJson = useMemo(() => {
    const ext = readExtension(draft);
    return JSON.stringify(
      {
        clientCapabilities: {
          extensions: ext ? { [EXT_ID]: ext } : undefined,
        },
        hostCapabilities: effective,
        sandbox: draft.mcpProfile?.apps?.sandbox ?? undefined,
      },
      null,
      2,
    );
  }, [draft, effective]);

  return (
    <div className="flex flex-col gap-4">
      <FocusBlock
        title="Extension"
        subtitle={
          <span className="font-mono text-[11px]">
            {EXT_ID} · SEP-1865
          </span>
        }
        action={
          <Switch
            checked={enabled}
            onCheckedChange={toggleExtension}
            aria-label="MCP Apps extension"
          />
        }
      >
        <div className="flex flex-col gap-0.5">
          <span className="text-[12px] font-medium">Supported MIME types</span>
          <span className="text-[11px] text-muted-foreground">
            Advertised in clientCapabilities.extensions.mimeTypes.
          </span>
        </div>
        <div className="flex flex-wrap items-center gap-1.5">
          {mimeTypes.map((m, idx) => (
            <Chip
              key={m}
              mono
              tone={idx === 0 ? "primary" : "neutral"}
              onRemove={
                enabled
                  ? () =>
                      updateMimeTypes(mimeTypes.filter((x) => x !== m))
                  : undefined
              }
            >
              {m}
            </Chip>
          ))}
          {enabled ? (
            <AddItemPill
              label="Add MIME type"
              placeholder="text/html;profile=mcp-app"
              value={mimeDraft}
              onValueChange={setMimeDraft}
              active={addingMime}
              onActivate={() => setAddingMime(true)}
              onCancel={() => {
                setAddingMime(false);
                setMimeDraft("");
              }}
              onAdd={() => {
                const t = mimeDraft.trim();
                if (t === "" || mimeTypes.includes(t)) return;
                updateMimeTypes([...mimeTypes, t]);
                setMimeDraft("");
                setAddingMime(false);
              }}
              validate={(raw) =>
                raw.trim() !== "" && mimeTypes.includes(raw.trim())
                  ? "Already added"
                  : null
              }
            />
          ) : null}
        </div>
        {issues.has("mimeTypes") ? (
          <p className="text-[11px] text-amber-700 dark:text-amber-300">
            Extension is on but no MIME types are advertised — Views won't
            be able to negotiate.
          </p>
        ) : null}
      </FocusBlock>

      <HostInfoBlock
        hostInfo={draft.mcpProfile?.apps?.uiInitialize?.hostInfo}
        onChange={(next) =>
          onDraftChange((prev) =>
            withMcpProfile(prev, (base) => ({
              ...base,
              apps: {
                ...base.apps,
                uiInitialize: { hostInfo: next },
              },
            })),
          )
        }
      />

      <FocusBlock
        title="Host capabilities"
        subtitle="Advertised in ui/initialize. Override a row to deviate from the host-style preset."
        action={
          draft.hostCapabilitiesOverride !== undefined ? (
            <Button
              type="button"
              size="sm"
              variant="ghost"
              className="h-7 text-[11px]"
              onClick={resetOverrideToPreset}
            >
              Reset to preset
            </Button>
          ) : (
            <span className="text-[10.5px] text-muted-foreground">
              Using {draft.hostStyle} preset
            </span>
          )
        }
      >
        {HOST_CAPABILITY_DEFS.map((def) => {
          const overrideHas = Object.prototype.hasOwnProperty.call(
            overrideMap,
            def.key,
          );
          const overrideValue = overrideMap[def.key];
          const presetValue = preset[def.key];
          const effectiveValue = effective[def.key];

          // State derivation: a row is "inherits" when override doesn't
          // define the key; otherwise the boolean derives from whether
          // override stored `undefined` (off) or any value (on).
          let state: "inherits" | "override-on" | "override-off";
          if (!overrideHas) {
            state = "inherits";
          } else if (overrideValue === undefined) {
            state = "override-off";
          } else {
            state = "override-on";
          }

          // Sub-claim chip — when the effective value carries the sub-key,
          // render the sub-chip alongside the capability name.
          const subChip =
            def.subClaim && effectiveValue
              ? (effectiveValue as Record<string, unknown>)[
                  def.subClaim.key
                ] !== undefined
                ? def.subClaim.label
                : undefined
              : undefined;

          return (
            <CapabilityToggleRow
              key={def.key}
              icon={def.icon}
              name={def.label}
              description={def.description}
              state={state}
              presetValueLabel={
                presetValue !== undefined ? "advertised" : "not advertised"
              }
              subChip={subChip}
              onOverrideOn={() => {
                // When the preset already advertised the key, mirror its
                // shape (preserves sub-claims). Otherwise advertise an
                // empty object (the spec-neutral "yes" signal).
                const value =
                  presetValue !== undefined ? presetValue : {};
                setOverrideKey(def.key, value);
              }}
              onOverrideOff={() => setOverrideKey(def.key, undefined)}
              onResetToPreset={() => {
                // Delete just this row's override entry. If that empties
                // the override map, leave it as `{}` per the plan —
                // "Reset to preset" on the BLOCK header is the only thing
                // that writes the whole override to `undefined`.
                onDraftChange((prev) => {
                  const cur = (prev.hostCapabilitiesOverride ?? {}) as Record<
                    string,
                    unknown
                  >;
                  const next = { ...cur };
                  delete next[def.key];
                  return {
                    ...prev,
                    hostCapabilitiesOverride: next,
                  };
                });
              }}
            />
          );
        })}
      </FocusBlock>

      <HostContextBlock
        hostContext={draft.hostContext}
        onChange={(next) =>
          onDraftChange((prev) => ({ ...prev, hostContext: next }))
        }
      />

      <FocusBlock
        title="Sandbox CSP"
        subtitle="restrictTo intersects with the baseline; deny always wins."
      >
        <SegmentedControl<SandboxMode>
          ariaLabel="Sandbox CSP mode"
          value={sandboxMode}
          onChange={(next) => {
            onDraftChange((prev) =>
              patchCsp(prev, (csp) => ({
                ...csp,
                mode: next === "host-default" ? undefined : next,
              })),
            );
          }}
          options={[
            { value: "host-default", label: "host-default" },
            { value: "declared", label: "declared" },
            { value: "relaxed", label: "relaxed" },
          ]}
        />

        {sandboxMode !== "host-default" ? (
          <div className="mt-1 grid grid-cols-2 gap-3">
            <CspDomainSetEditor
              label="restrictTo"
              hint="Intersect with the baseline."
              value={sandboxCsp?.restrictTo}
              onChange={(restrictTo) => {
                onDraftChange((prev) =>
                  patchCsp(prev, (csp) => ({
                    ...csp,
                    restrictTo,
                  })),
                );
              }}
            />
            <CspDomainSetEditor
              label="deny"
              hint="Always blocked."
              value={sandboxCsp?.deny}
              onChange={(deny) => {
                onDraftChange((prev) =>
                  patchCsp(prev, (csp) => ({
                    ...csp,
                    deny,
                  })),
                );
              }}
            />
          </div>
        ) : null}
      </FocusBlock>

      <SandboxPermissionsBlock
        permissions={draft.mcpProfile?.apps?.sandbox?.permissions}
        onChange={(recipe) =>
          onDraftChange((prev) => patchPermissions(prev, recipe))
        }
        attentionIssues={issues}
      />

      <div className="flex items-center justify-end gap-2 text-[11px] text-muted-foreground">
        <span>
          Compiles to <span className="font-mono">capabilities.extensions["{EXT_ID}"]</span>
        </span>
        <button
          type="button"
          className="inline-flex items-center gap-1 text-foreground underline-offset-2 hover:underline"
          onClick={() => setShowJson(true)}
        >
          view JSON <ArrowDownToLine className="size-3" />
        </button>
      </div>

      <Dialog open={showJson} onOpenChange={setShowJson}>
        <DialogContent className="max-w-2xl">
          <div className="flex items-center gap-2">
            <AppWindow className="size-4 text-sky-600" />
            <span className="text-sm font-semibold">
              Apps Extension JSON preview
            </span>
          </div>
          <pre className="max-h-[60vh] overflow-auto rounded-md bg-muted/40 p-3 font-mono text-[11.5px]">
            {previewJson}
          </pre>
        </DialogContent>
      </Dialog>
    </div>
  );
}

/**
 * Editor for one CspDomainSet — four directive families
 * (connectDomains / resourceDomains / frameDomains / baseUriDomains)
 * rendered as collapsible sub-sections of chip lists.
 *
 * Validation: each entry must look like a fully-qualified origin
 * (scheme + host) or a wildcard subdomain pattern. We don't try to be
 * exhaustive — the renderer + CSP enforcer will reject malformed entries
 * — but we surface obvious typos to keep the editor honest.
 */
function CspDomainSetEditor({
  label,
  hint,
  value,
  onChange,
}: {
  label: string;
  hint: string;
  value: CspDomainSet | undefined;
  onChange: (next: CspDomainSet | undefined) => void;
}) {
  const directives: Array<{
    key: keyof CspDomainSet;
    title: string;
    placeholder: string;
  }> = [
    {
      key: "connectDomains",
      title: "connect-src",
      placeholder: "https://api.example.com",
    },
    {
      key: "resourceDomains",
      title: "resource (img/script/style)",
      placeholder: "https://cdn.example.com",
    },
    {
      key: "frameDomains",
      title: "frame-src",
      placeholder: "https://player.example.com",
    },
    {
      key: "baseUriDomains",
      title: "base-uri",
      placeholder: "https://example.com",
    },
  ];

  const commit = (key: keyof CspDomainSet, list: string[]) => {
    const next: CspDomainSet = { ...(value ?? {}) };
    if (list.length === 0) {
      delete next[key];
    } else {
      next[key] = list;
    }
    const hasAny = directives.some((d) => {
      const v = next[d.key];
      return Array.isArray(v) && v.length > 0;
    });
    onChange(hasAny ? next : undefined);
  };

  return (
    <div className="flex flex-col gap-2 rounded-md border border-border/50 bg-card/40 p-2.5">
      <div className="flex items-center justify-between">
        <span className="font-mono text-[11.5px] font-semibold">{label}</span>
        <span className="text-[10.5px] text-muted-foreground">{hint}</span>
      </div>
      {directives.map((d) => (
        <CspDirectiveChipList
          key={d.key}
          title={d.title}
          placeholder={d.placeholder}
          items={value?.[d.key] ?? []}
          onChange={(list) => commit(d.key, list)}
        />
      ))}
    </div>
  );
}

function validateOrigin(raw: string): string | null {
  const v = raw.trim();
  if (v === "") return "Empty";
  // Allow wildcard subdomain patterns like https://*.example.com.
  if (/^https?:\/\/(\*\.)?[a-z0-9.-]+(:\d+)?(\/.*)?$/i.test(v)) return null;
  return "Looks malformed";
}

function CspDirectiveChipList({
  title,
  placeholder,
  items,
  onChange,
}: {
  title: string;
  placeholder: string;
  items: string[];
  onChange: (next: string[]) => void;
}) {
  const [adding, setAdding] = useState(false);
  const [draft, setDraft] = useState("");

  return (
    <div className="flex flex-col gap-1">
      <span className="font-mono text-[10px] uppercase tracking-[0.04em] text-muted-foreground">
        {title}
      </span>
      <div className="flex flex-wrap items-center gap-1.5">
        {items.length === 0 && !adding ? (
          <span className="text-[10.5px] text-muted-foreground/70">—</span>
        ) : null}
        {items.map((item) => (
          <Chip
            key={item}
            mono
            tone="neutral"
            onRemove={() => onChange(items.filter((x) => x !== item))}
          >
            {item}
          </Chip>
        ))}
        <AddItemPill
          label="Add origin"
          placeholder={placeholder}
          value={draft}
          onValueChange={setDraft}
          active={adding}
          onActivate={() => setAdding(true)}
          onCancel={() => {
            setAdding(false);
            setDraft("");
          }}
          onAdd={() => {
            const t = draft.trim();
            if (t === "" || items.includes(t)) return;
            if (validateOrigin(t) !== null) return;
            onChange([...items, t]);
            setDraft("");
            setAdding(false);
          }}
          validate={(raw) => {
            const t = raw.trim();
            if (t === "") return null;
            if (items.includes(t)) return "Already added";
            return validateOrigin(t);
          }}
        />
      </div>
    </div>
  );
}

/**
 * hostInfo block — name + version sent to Views in ui/initialize. Mirrors
 * the clientInfo pattern in ProtocolTab. Flushes to
 * `mcpProfile.apps.uiInitialize.hostInfo` only when both fields are
 * non-empty; clears the field otherwise.
 */
function HostInfoBlock({
  hostInfo,
  onChange,
}: {
  hostInfo: Record<string, unknown> | undefined;
  onChange: (next: Record<string, unknown> | undefined) => void;
}) {
  const persistedName =
    typeof hostInfo?.name === "string" ? (hostInfo.name as string) : "";
  const persistedVersion =
    typeof hostInfo?.version === "string"
      ? (hostInfo.version as string)
      : "";

  const [name, setName] = useState(persistedName);
  const [version, setVersion] = useState(persistedVersion);
  const nameRef = useRef(name);
  const versionRef = useRef(version);
  useEffect(() => {
    nameRef.current = name;
  }, [name]);
  useEffect(() => {
    versionRef.current = version;
  }, [version]);

  // Mirror external resets (template switch, revert).
  useEffect(() => {
    if (
      persistedName !== nameRef.current ||
      persistedVersion !== versionRef.current
    ) {
      const draftWouldFlush =
        nameRef.current.trim() !== "" && versionRef.current.trim() !== "";
      if (!draftWouldFlush || hostInfo === undefined) {
        setName(persistedName);
        setVersion(persistedVersion);
      }
    }
  }, [persistedName, persistedVersion, hostInfo]);

  const flush = (nextName: string, nextVersion: string) => {
    const n = nextName.trim();
    const v = nextVersion.trim();
    onChange(n !== "" && v !== "" ? { name: n, version: v } : undefined);
  };

  return (
    <FocusBlock title="hostInfo" subtitle="Sent to Views in ui/initialize.">
      <div className="grid grid-cols-2 gap-2">
        <Input
          placeholder="claude-desktop"
          aria-label="Host name"
          value={name}
          onChange={(e) => {
            setName(e.target.value);
            flush(e.target.value, version);
          }}
          className="font-mono text-[12px]"
        />
        <Input
          placeholder="1.0.0"
          aria-label="Host version"
          value={version}
          onChange={(e) => {
            setVersion(e.target.value);
            flush(name, e.target.value);
          }}
          className="font-mono text-[12px]"
        />
      </div>
    </FocusBlock>
  );
}

/**
 * Structured hostContext editor. Surfaces the named SEP-1865 fields and
 * tucks the bulky template-supplied bits (styles, containerDimensions,
 * safeAreaInsets, deviceCapabilities, availableDisplayModes, userAgent,
 * platform) into a collapsed Advanced JSON block.
 */
const STRUCTURED_HOST_CONTEXT_KEYS = new Set([
  "theme",
  "displayMode",
  "locale",
  "timeZone",
]);

type ThemeMode = "light" | "dark";
type DisplayMode = "inline" | "fullscreen" | "pip";

function HostContextBlock({
  hostContext,
  onChange,
}: {
  hostContext: Record<string, unknown>;
  onChange: (next: Record<string, unknown>) => void;
}) {
  const theme =
    hostContext.theme === "light" || hostContext.theme === "dark"
      ? (hostContext.theme as ThemeMode)
      : undefined;
  const displayMode =
    hostContext.displayMode === "inline" ||
    hostContext.displayMode === "fullscreen" ||
    hostContext.displayMode === "pip"
      ? (hostContext.displayMode as DisplayMode)
      : undefined;
  const locale =
    typeof hostContext.locale === "string"
      ? (hostContext.locale as string)
      : "";
  const timeZone =
    typeof hostContext.timeZone === "string"
      ? (hostContext.timeZone as string)
      : "";

  const setKey = (key: string, value: unknown | undefined) => {
    const next = { ...hostContext };
    if (value === undefined || value === "") {
      delete next[key];
    } else {
      next[key] = value;
    }
    onChange(next);
  };

  const advancedSubset = useMemo(() => {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(hostContext)) {
      if (!STRUCTURED_HOST_CONTEXT_KEYS.has(k)) out[k] = v;
    }
    return out;
  }, [hostContext]);

  const [advancedOpen, setAdvancedOpen] = useState(false);
  const [advancedRaw, setAdvancedRaw] = useState(() =>
    JSON.stringify(advancedSubset, null, 2),
  );
  const [advancedErr, setAdvancedErr] = useState<string | null>(null);

  useEffect(() => {
    const stringified = JSON.stringify(advancedSubset, null, 2);
    try {
      const reparsed = JSON.parse(advancedRaw || "{}");
      if (JSON.stringify(reparsed) !== JSON.stringify(advancedSubset)) {
        setAdvancedRaw(stringified);
        setAdvancedErr(null);
      }
    } catch {
      // mid-edit; leave alone
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [advancedSubset]);

  const tryParseAdvanced = (raw: string) => {
    setAdvancedRaw(raw);
    try {
      const parsed = JSON.parse(raw || "{}");
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
        setAdvancedErr("Must be a JSON object");
        return;
      }
      const cleaned: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(parsed as Record<string, unknown>)) {
        if (!STRUCTURED_HOST_CONTEXT_KEYS.has(k)) cleaned[k] = v;
      }
      setAdvancedErr(null);
      const merged: Record<string, unknown> = { ...cleaned };
      for (const k of STRUCTURED_HOST_CONTEXT_KEYS) {
        if (hostContext[k] !== undefined) merged[k] = hostContext[k];
      }
      onChange(merged);
    } catch (err) {
      setAdvancedErr(err instanceof Error ? err.message : "Invalid JSON");
    }
  };

  return (
    <FocusBlock
      title="hostContext"
      subtitle="Context the host advertises to Views in ui/initialize."
    >
      <FieldRow
        label="Theme"
        control={
          <SegmentedControl<ThemeMode | "unset">
            ariaLabel="Theme"
            value={theme ?? "unset"}
            onChange={(next) =>
              setKey("theme", next === "unset" ? undefined : next)
            }
            options={[
              { value: "unset", label: "unset" },
              { value: "light", label: "light" },
              { value: "dark", label: "dark" },
            ]}
          />
        }
      />
      <FieldRow
        label="Display mode"
        control={
          <SegmentedControl<DisplayMode | "unset">
            ariaLabel="Display mode"
            value={displayMode ?? "unset"}
            onChange={(next) =>
              setKey("displayMode", next === "unset" ? undefined : next)
            }
            options={[
              { value: "unset", label: "unset" },
              { value: "inline", label: "inline" },
              { value: "fullscreen", label: "fullscreen" },
              { value: "pip", label: "pip" },
            ]}
          />
        }
      />
      <FieldRow
        label="Locale"
        description="BCP 47, e.g. en-US."
        control={
          <Input
            value={locale}
            placeholder="en-US"
            aria-label="Locale"
            onChange={(e) => setKey("locale", e.target.value)}
            className="h-8 w-32 font-mono text-[11px]"
          />
        }
      />
      <FieldRow
        label="Time zone"
        description="IANA, e.g. America/New_York."
        control={
          <Input
            value={timeZone}
            placeholder="America/Los_Angeles"
            aria-label="Time zone"
            onChange={(e) => setKey("timeZone", e.target.value)}
            className="h-8 w-48 font-mono text-[11px]"
          />
        }
      />

      <div className="rounded-md border border-border/50 bg-card/40">
        <button
          type="button"
          onClick={() => setAdvancedOpen((o) => !o)}
          aria-expanded={advancedOpen}
          className="flex w-full items-center gap-2 px-3 py-1.5 text-left"
        >
          {advancedOpen ? (
            <ChevronDown className="size-3 shrink-0 text-muted-foreground" />
          ) : (
            <ChevronRight className="size-3 shrink-0 text-muted-foreground" />
          )}
          <span className="text-[11.5px] font-medium">Advanced</span>
          <span className="ml-auto font-mono text-[10.5px] text-muted-foreground/70">
            {Object.keys(advancedSubset).length === 0
              ? "empty"
              : `${Object.keys(advancedSubset).length} keys`}
          </span>
        </button>
        {advancedOpen ? (
          <div className="border-t border-border/40 px-3 py-2">
            <Textarea
              rows={8}
              value={advancedRaw}
              onChange={(e) => tryParseAdvanced(e.target.value)}
              spellCheck={false}
              className="font-mono text-[11.5px]"
              placeholder="{ }"
            />
            {advancedErr ? (
              <p className="mt-1 text-[11px] text-destructive">{advancedErr}</p>
            ) : null}
          </div>
        ) : null}
      </div>
    </FocusBlock>
  );
}

type PermissionsMode = "resource-declared" | "deny-all" | "custom";

const SANDBOX_PERMISSION_KEYS = [
  "camera",
  "microphone",
  "geolocation",
  "clipboardWrite",
] as const;

/**
 * Sandbox permissions block. Mirrors the CSP layout. Backend canonicalizer
 * already validates this shape (mode union, allow:Record<string,boolean>,
 * deny:string[]) so the UI is additive only.
 */
function SandboxPermissionsBlock({
  permissions,
  onChange,
  attentionIssues,
}: {
  permissions: PermsBlock;
  onChange: (
    recipe: (perms: NonNullable<PermsBlock>) => NonNullable<PermsBlock>,
  ) => void;
  attentionIssues: ReadonlySet<string>;
}) {
  const mode = (permissions?.mode ?? "resource-declared") as PermissionsMode;
  const allow = (permissions?.allow ?? {}) as Record<string, boolean>;
  const deny = permissions?.deny ?? [];

  const setMode = (next: PermissionsMode) =>
    onChange((perms) => ({
      ...perms,
      mode: next === "resource-declared" ? undefined : next,
    }));

  const toggleAllow = (key: string, checked: boolean) =>
    onChange((perms) => {
      const nextAllow = { ...((perms.allow as Record<string, boolean>) ?? {}) };
      if (checked) {
        nextAllow[key] = true;
      } else {
        delete nextAllow[key];
      }
      return {
        ...perms,
        allow: Object.keys(nextAllow).length > 0 ? nextAllow : undefined,
      };
    });

  const updateDeny = (next: string[]) =>
    onChange((perms) => ({
      ...perms,
      deny: next.length > 0 ? next : undefined,
    }));

  return (
    <FocusBlock
      title="Sandbox permissions"
      subtitle="Sandbox features the View may use."
      action={
        attentionIssues.has("sandboxPermissionsAllow") ? (
          <span className="text-[10.5px] text-amber-700 dark:text-amber-300">
            attention
          </span>
        ) : null
      }
    >
      <SegmentedControl<PermissionsMode>
        ariaLabel="Permissions mode"
        value={mode}
        onChange={setMode}
        options={[
          { value: "resource-declared", label: "resource-declared" },
          { value: "deny-all", label: "deny-all" },
          { value: "custom", label: "custom" },
        ]}
      />

      {mode === "custom" ? (
        <div className="flex flex-col gap-2 rounded-md border border-border/50 bg-card/40 p-2.5">
          <span className="font-mono text-[11.5px] font-semibold">allow</span>
          <div className="grid grid-cols-2 gap-1.5">
            {SANDBOX_PERMISSION_KEYS.map((key) => (
              <label
                key={key}
                className="flex items-center justify-between gap-2 text-[12px]"
              >
                <span className="font-mono">{key}</span>
                <Switch
                  checked={allow[key] === true}
                  onCheckedChange={(c) => toggleAllow(key, c)}
                  aria-label={`Allow ${key}`}
                />
              </label>
            ))}
          </div>
        </div>
      ) : null}

      {mode !== "resource-declared" ? (
        <PermissionsDenyList items={deny} onChange={updateDeny} />
      ) : null}
    </FocusBlock>
  );
}

function PermissionsDenyList({
  items,
  onChange,
}: {
  items: string[];
  onChange: (next: string[]) => void;
}) {
  const [adding, setAdding] = useState(false);
  const [draft, setDraft] = useState("");
  return (
    <div className="flex flex-col gap-1.5 rounded-md border border-border/50 bg-card/40 p-2.5">
      <span className="font-mono text-[11.5px] font-semibold">deny</span>
      <div className="flex flex-wrap items-center gap-1.5">
        {items.length === 0 && !adding ? (
          <span className="text-[10.5px] text-muted-foreground/70">—</span>
        ) : null}
        {items.map((item) => (
          <Chip
            key={item}
            mono
            tone="neutral"
            onRemove={() => onChange(items.filter((x) => x !== item))}
          >
            {item}
          </Chip>
        ))}
        <AddItemPill
          label="Add permission"
          placeholder="camera"
          value={draft}
          onValueChange={setDraft}
          active={adding}
          onActivate={() => setAdding(true)}
          onCancel={() => {
            setAdding(false);
            setDraft("");
          }}
          onAdd={() => {
            const t = draft.trim();
            if (t === "" || items.includes(t)) return;
            onChange([...items, t]);
            setDraft("");
            setAdding(false);
          }}
          validate={(raw) =>
            raw.trim() !== "" && items.includes(raw.trim())
              ? "Already added"
              : null
          }
        />
      </div>
    </div>
  );
}
