import { useEffect, useRef, useState } from "react";
import { Input } from "@mcpjam/design-system/input";
import {
  type HostConfigInputV2,
  type HostConfigMcpProfileV1,
} from "@/lib/host-config-v2";
import {
  AddItemPill,
  CapabilityToggleRow,
  Chip,
  FieldRow,
  FocusBlock,
} from "./primitives";
import type { HostAttentionIssue } from "../types";
import { Network, Sparkles, Wrench } from "lucide-react";

interface ProtocolTabProps {
  draft: HostConfigInputV2;
  onDraftChange: (
    updater: (prev: HostConfigInputV2) => HostConfigInputV2,
  ) => void;
  attention: ReadonlyArray<HostAttentionIssue>;
}

/**
 * Helper: produce a new `mcpProfile` envelope after applying a patch to
 * `initialize`. Collapses to `undefined` when every initialize subfield
 * AND every apps subfield is empty, preserving the "undefined ≠ empty
 * envelope" hash distinction from host-config-v2.ts:53.
 */
function patchProfile(
  prev: HostConfigMcpProfileV1 | undefined,
  patch: (
    base: HostConfigMcpProfileV1,
  ) => HostConfigMcpProfileV1 | undefined,
): HostConfigMcpProfileV1 | undefined {
  const base: HostConfigMcpProfileV1 = prev ?? { profileVersion: 1 };
  return patch(base);
}

function collapseProfile(
  next: HostConfigMcpProfileV1,
): HostConfigMcpProfileV1 | undefined {
  const initEmpty =
    !next.initialize ||
    (next.initialize.clientInfo === undefined &&
      (!next.initialize.supportedProtocolVersions ||
        next.initialize.supportedProtocolVersions.length === 0));
  const appsEmpty = !next.apps;
  const extEmpty = !next.extensions;
  if (initEmpty && appsEmpty && extEmpty) return undefined;
  return next;
}

export function ProtocolTab({
  draft,
  onDraftChange,
}: ProtocolTabProps) {
  const profile = draft.mcpProfile;
  const persistedCi = profile?.initialize?.clientInfo;
  const persistedVersions = profile?.initialize?.supportedProtocolVersions;

  // Local draft buffer for clientInfo. Keeps mid-edit values stable;
  // flushed to the persisted envelope only when both required fields are
  // present (matches the partial-flush rule the legacy editor relies on).
  const [ciName, setCiName] = useState(
    typeof persistedCi?.name === "string" ? persistedCi.name : "",
  );
  const [ciVersion, setCiVersion] = useState(
    typeof persistedCi?.version === "string" ? persistedCi.version : "",
  );
  const ciNameRef = useRef(ciName);
  const ciVersionRef = useRef(ciVersion);
  useEffect(() => {
    ciNameRef.current = ciName;
  }, [ciName]);
  useEffect(() => {
    ciVersionRef.current = ciVersion;
  }, [ciVersion]);

  // Mirror external changes (e.g. revert/load).
  useEffect(() => {
    const persistedName =
      typeof persistedCi?.name === "string" ? persistedCi.name : "";
    const persistedVersion =
      typeof persistedCi?.version === "string" ? persistedCi.version : "";
    if (
      persistedName !== ciNameRef.current ||
      persistedVersion !== ciVersionRef.current
    ) {
      const draftWouldFlush =
        ciNameRef.current.trim() !== "" && ciVersionRef.current.trim() !== "";
      if (!draftWouldFlush || persistedCi === undefined) {
        setCiName(persistedName);
        setCiVersion(persistedVersion);
      }
    }
  }, [persistedCi]);

  const flushClientInfo = (nextName: string, nextVersion: string) => {
    const nameTrim = nextName.trim();
    const versionTrim = nextVersion.trim();
    onDraftChange((prev) => {
      const newProfile = patchProfile(prev.mcpProfile, (base) => {
        const init = base.initialize ?? {};
        const hasRequired = nameTrim !== "" && versionTrim !== "";
        const nextInit = {
          ...init,
          clientInfo: hasRequired
            ? { name: nameTrim, version: versionTrim }
            : undefined,
        };
        const initHasFields =
          nextInit.clientInfo !== undefined ||
          (nextInit.supportedProtocolVersions &&
            nextInit.supportedProtocolVersions.length > 0);
        return collapseProfile({
          ...base,
          initialize: initHasFields ? nextInit : undefined,
        });
      });
      return { ...prev, mcpProfile: newProfile };
    });
  };

  // Protocol versions chip list.
  const versions = persistedVersions ?? [];
  const [addingVersion, setAddingVersion] = useState(false);
  const [versionDraft, setVersionDraft] = useState("");

  const updateVersions = (next: string[]) => {
    onDraftChange((prev) => {
      const newProfile = patchProfile(prev.mcpProfile, (base) => {
        const init = base.initialize ?? {};
        const nextInit = {
          ...init,
          supportedProtocolVersions: next.length > 0 ? next : undefined,
        };
        const initHasFields =
          nextInit.clientInfo !== undefined ||
          (nextInit.supportedProtocolVersions &&
            nextInit.supportedProtocolVersions.length > 0);
        return collapseProfile({
          ...base,
          initialize: initHasFields ? nextInit : undefined,
        });
      });
      return { ...prev, mcpProfile: newProfile };
    });
  };

  // Base capabilities — toggles over `clientCapabilities.{roots, sampling,
  // experimental}`. Tri-state: a key that is `undefined` means "not
  // advertised". `{}` is meaningful (advertise empty object).
  const caps = draft.clientCapabilities ?? {};
  const rootsCap = caps.roots as
    | { listChanged?: boolean }
    | undefined;
  const samplingCap = caps.sampling;
  const experimentalCap = caps.experimental;

  const setCap = (key: string, next: unknown) => {
    onDraftChange((prev) => {
      const nextCaps = { ...prev.clientCapabilities };
      if (next === undefined) {
        delete nextCaps[key];
      } else {
        nextCaps[key] = next;
      }
      return { ...prev, clientCapabilities: nextCaps };
    });
  };

  return (
    <div className="flex flex-col gap-4">
      <FocusBlock
        title="clientInfo"
        subtitle="Sent verbatim in the base-protocol initialize request. Leave blank to use SDK defaults."
      >
        <div className="grid grid-cols-2 gap-2">
          <Input
            placeholder="@mcpjam/inspector"
            aria-label="Client name"
            value={ciName}
            onChange={(e) => {
              setCiName(e.target.value);
              flushClientInfo(e.target.value, ciVersion);
            }}
            className="font-mono text-[12px]"
          />
          <Input
            placeholder="1.0.0"
            aria-label="Client version"
            value={ciVersion}
            onChange={(e) => {
              setCiVersion(e.target.value);
              flushClientInfo(ciName, e.target.value);
            }}
            className="font-mono text-[12px]"
          />
        </div>
      </FocusBlock>

      <FocusBlock
        title="Supported protocol versions"
        subtitle="Order is semantic — the first entry is proposed in initialize.params.protocolVersion."
      >
        <div className="flex flex-wrap items-center gap-1.5">
          {versions.map((v, idx) => (
            <Chip
              key={v}
              mono
              tone={idx === 0 ? "primary" : "neutral"}
              onRemove={() =>
                updateVersions(versions.filter((x) => x !== v))
              }
            >
              {v}
            </Chip>
          ))}
          <AddItemPill
            label="Add version"
            placeholder="2025-11-25"
            value={versionDraft}
            onValueChange={setVersionDraft}
            active={addingVersion}
            onActivate={() => setAddingVersion(true)}
            onCancel={() => {
              setAddingVersion(false);
              setVersionDraft("");
            }}
            onAdd={() => {
              const trimmed = versionDraft.trim();
              if (trimmed === "" || versions.includes(trimmed)) return;
              updateVersions([...versions, trimmed]);
              setVersionDraft("");
              setAddingVersion(false);
            }}
            validate={(raw) =>
              raw.trim() !== "" && versions.includes(raw.trim())
                ? "Already added"
                : null
            }
          />
        </div>
      </FocusBlock>

      <FocusBlock
        title="Base capabilities"
        subtitle="Advertised in clientCapabilities during the base-protocol initialize."
      >
        <CapabilityToggleRow
          icon={<Network className="size-3.5" />}
          name="roots"
          description="Expose filesystem roots to the server."
          presetValueLabel={rootsCap ? "advertised" : "not advertised"}
          state={rootsCap ? "override-on" : "override-off"}
          subChip={
            rootsCap?.listChanged ? <span>listChanged</span> : undefined
          }
          onOverrideOn={() => setCap("roots", { listChanged: true })}
          onOverrideOff={() => setCap("roots", undefined)}
        />
        <CapabilityToggleRow
          icon={<Sparkles className="size-3.5" />}
          name="sampling"
          description="Let the server request LLM sampling from the host."
          presetValueLabel={samplingCap ? "advertised" : "not advertised"}
          state={samplingCap ? "override-on" : "override-off"}
          onOverrideOn={() => setCap("sampling", {})}
          onOverrideOff={() => setCap("sampling", undefined)}
        />
        <CapabilityToggleRow
          icon={<Wrench className="size-3.5" />}
          name="experimental"
          description="Opt into non-standard experimental capability."
          presetValueLabel={
            experimentalCap ? "advertised" : "not advertised"
          }
          state={experimentalCap ? "override-on" : "override-off"}
          onOverrideOn={() => setCap("experimental", {})}
          onOverrideOff={() => setCap("experimental", undefined)}
        />
      </FocusBlock>

      <FocusBlock
        title="Connection defaults"
        subtitle="Per-host fallback for server requests. Servers can override these in the Servers tab."
      >
        <FieldRow
          label="Request timeout"
          description="Per-request timeout in milliseconds."
          control={
            <div className="flex items-center gap-1.5">
              <Input
                type="number"
                min={1}
                step={500}
                value={draft.connectionDefaults.requestTimeout}
                onChange={(e) => {
                  const parsed = Number(e.target.value);
                  if (Number.isFinite(parsed) && parsed > 0) {
                    onDraftChange((prev) => ({
                      ...prev,
                      connectionDefaults: {
                        ...prev.connectionDefaults,
                        requestTimeout: parsed,
                      },
                    }));
                  }
                }}
                className="h-8 w-28 font-mono text-[12px]"
                aria-label="Request timeout (ms)"
              />
              <span className="font-mono text-[11px] text-muted-foreground">
                ms
              </span>
            </div>
          }
        />
        <HeadersListEditor
          headers={draft.connectionDefaults.headers ?? {}}
          onChange={(headers) =>
            onDraftChange((prev) => ({
              ...prev,
              connectionDefaults: {
                ...prev.connectionDefaults,
                headers,
              },
            }))
          }
        />
      </FocusBlock>
    </div>
  );
}

/**
 * Headers editor as a list of name/value pairs with a per-row remove.
 * Backs the raw `Record<string, string>` shape but renders without raw
 * JSON. `Authorization` is reserved at the persistence boundary
 * (coerceHeadersToStringRecord in HostConfigEditor) so we mirror that
 * rule here: filtered out of the displayed list.
 */
function HeadersListEditor({
  headers,
  onChange,
}: {
  headers: Record<string, string>;
  onChange: (next: Record<string, string>) => void;
}) {
  const entries = Object.entries(headers).filter(
    ([k]) => k.trim() !== "" && k.toLowerCase() !== "authorization",
  );
  const [adding, setAdding] = useState(false);
  const [draftName, setDraftName] = useState("");
  const [draftValue, setDraftValue] = useState("");

  return (
    <div className="flex flex-col gap-1.5">
      <span className="text-[12px] font-medium">Connection headers</span>
      {entries.length === 0 && !adding ? (
        <p className="text-[11px] text-muted-foreground">
          No host-level headers configured.
        </p>
      ) : null}
      {entries.map(([key, val]) => (
        <div key={key} className="flex items-center gap-2">
          <Input
            value={key}
            disabled
            className="h-8 w-40 font-mono text-[11px]"
          />
          <Input
            value={val}
            onChange={(e) => {
              const next = { ...headers, [key]: e.target.value };
              onChange(next);
            }}
            className="h-8 flex-1 font-mono text-[11px]"
          />
          <button
            type="button"
            onClick={() => {
              const next = { ...headers };
              delete next[key];
              onChange(next);
            }}
            className="text-[10.5px] text-muted-foreground underline-offset-2 hover:underline"
          >
            remove
          </button>
        </div>
      ))}
      {adding ? (
        <div className="flex items-center gap-2">
          <Input
            placeholder="X-Header"
            value={draftName}
            onChange={(e) => setDraftName(e.target.value)}
            className="h-8 w-40 font-mono text-[11px]"
          />
          <Input
            placeholder="value"
            value={draftValue}
            onChange={(e) => setDraftValue(e.target.value)}
            className="h-8 flex-1 font-mono text-[11px]"
          />
          <button
            type="button"
            onClick={() => {
              const k = draftName.trim();
              if (k === "" || k.toLowerCase() === "authorization") return;
              onChange({ ...headers, [k]: draftValue });
              setDraftName("");
              setDraftValue("");
              setAdding(false);
            }}
            className="text-[10.5px] underline-offset-2 hover:underline"
          >
            add
          </button>
          <button
            type="button"
            onClick={() => {
              setDraftName("");
              setDraftValue("");
              setAdding(false);
            }}
            className="text-[10.5px] text-muted-foreground underline-offset-2 hover:underline"
          >
            cancel
          </button>
        </div>
      ) : (
        <button
          type="button"
          onClick={() => setAdding(true)}
          className="inline-flex w-fit items-center gap-1 rounded-full border border-dashed border-border/70 px-2.5 py-0.5 text-[11px] text-muted-foreground hover:border-foreground/40 hover:text-foreground"
        >
          + Add header
        </button>
      )}
    </div>
  );
}

