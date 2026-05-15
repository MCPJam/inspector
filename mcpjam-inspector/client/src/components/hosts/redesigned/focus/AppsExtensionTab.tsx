import { useMemo, useState, type ReactNode } from "react";
import {
  AppWindow,
  ArrowDownToLine,
  ExternalLink,
  Languages,
  MessagesSquare,
  Server,
  TerminalSquare,
} from "lucide-react";
import { Button } from "@mcpjam/design-system/button";
import { Dialog, DialogContent } from "@mcpjam/design-system/dialog";
import { Switch } from "@mcpjam/design-system/switch";
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

/**
 * Sandbox patch helper. Collapses to undefined when the resulting profile
 * has no live fields (matches the "undefined ≠ empty envelope" rule from
 * host-config-v2.ts:53).
 */
function patchSandbox(
  prev: HostConfigInputV2,
  patch: (
    csp: NonNullable<
      NonNullable<HostConfigMcpProfileV1["apps"]>["sandbox"]
    >["csp"],
  ) => NonNullable<
    NonNullable<HostConfigMcpProfileV1["apps"]>["sandbox"]
  >["csp"],
): HostConfigInputV2 {
  const base: HostConfigMcpProfileV1 =
    prev.mcpProfile ?? { profileVersion: 1 };
  const sandbox = base.apps?.sandbox ?? {};
  const csp = sandbox.csp ?? {};
  const nextCsp = patch(csp);
  const nextSandbox = {
    ...sandbox,
    csp: nextCsp,
  };
  // Collapse the next profile if everything emptied out.
  const cspEmpty =
    !nextCsp ||
    (nextCsp.mode === undefined &&
      !nextCsp.restrictTo &&
      !nextCsp.deny &&
      !nextCsp.extensions);
  const permsEmpty = !nextSandbox.permissions;
  const sandboxEmpty = cspEmpty && permsEmpty;
  const appsEmpty = sandboxEmpty && !base.apps?.uiInitialize;
  const initEmpty =
    !base.initialize ||
    (base.initialize.clientInfo === undefined &&
      (!base.initialize.supportedProtocolVersions ||
        base.initialize.supportedProtocolVersions.length === 0));
  const profileEmpty = appsEmpty && initEmpty && !base.extensions;
  const nextProfile = profileEmpty
    ? undefined
    : {
        ...base,
        apps: appsEmpty
          ? undefined
          : {
              ...base.apps,
              sandbox: sandboxEmpty
                ? undefined
                : {
                    ...nextSandbox,
                    csp: cspEmpty ? undefined : nextCsp,
                  },
            },
      };
  return { ...prev, mcpProfile: nextProfile };
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

      <FocusBlock
        title="Sandbox CSP"
        subtitle="Compiles to capabilities.extensions.sandbox.csp. restrictTo intersects with the chosen baseline; deny always wins."
      >
        <SegmentedControl<SandboxMode>
          ariaLabel="Sandbox CSP mode"
          value={sandboxMode}
          onChange={(next) => {
            onDraftChange((prev) =>
              patchSandbox(prev, (csp) => ({
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

        <div className="mt-1 grid grid-cols-2 gap-3">
          <CspDomainSetEditor
            label="restrictTo"
            hint="Intersect with the baseline."
            value={sandboxCsp?.restrictTo}
            onChange={(restrictTo) => {
              onDraftChange((prev) =>
                patchSandbox(prev, (csp) => ({
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
                patchSandbox(prev, (csp) => ({
                  ...csp,
                  deny,
                })),
              );
            }}
          />
        </div>
      </FocusBlock>

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
