import { useMemo, useState } from "react";
import { Button } from "@mcpjam/design-system/button";
import { MaskedValueInput } from "@/components/connection/shared/MaskedValueInput";
import type {
  PluginComponentEnvRequirement,
  PluginComponentHeaderRequirement,
} from "@/lib/plugins/plugin-api-types";

/**
 * Inline setup editor for ONE plugin server component (Phase 7).
 *
 * Plugin server rows are read-only projections: the backend rejects
 * structural edits, but `servers:updateServerWithClientSecret` accepts
 * credential-only writes (env/header values) against them. This editor is
 * therefore values-only by construction — requirement NAMES come from the
 * bundle and are never editable, unlike the generic env/header editors whose
 * rows have editable keys. The value fields reuse the shared
 * `MaskedValueInput` primitive so credential entry looks identical here and
 * in the generic server settings.
 *
 * Literal (bundle-declared, secret-screened) values render read-only with an
 * override affordance: overriding stores a user value on the server row; the
 * bundle itself is never modified.
 *
 * REPLACE, NOT MERGE. `updateServerWithClientSecret` repoints the row's
 * `envSecretId`/`headersSecretId` at a NEW vault object built from exactly
 * the map it is given, and connect-time resolution prefers that vault map
 * over the row's plaintext env entirely. A partial map is therefore
 * DESTRUCTIVE: omitting a bundle-declared literal or template drops it from
 * the runtime launch. So a save submits the COMPLETE intended map for
 * whichever group it touches — every declared literal, every template, plus
 * the user's typed values (typed wins) — and the untouched group is omitted
 * entirely so its pointer is left alone.
 *
 * Residual limitation: values a user typed in an EARLIER session live only
 * in the vault, which this surface cannot read, so they are not in the map
 * this editor can rebuild. Re-entering them in the same save is what keeps
 * them; the group-scoped payload keeps that blast radius to the one group
 * being edited.
 *
 * Purely presentational: the caller supplies `onSave`, which is expected to
 * call the `servers:updateServerWithClientSecret` action with the component's
 * materialized server id.
 */

export interface PluginServerSetupValues {
  env?: Record<string, string>;
  headers?: Record<string, string>;
}

/** Whether a component projection carries anything this editor can edit. */
export function hasPluginServerSetupEntries(component: {
  envRequirements?: PluginComponentEnvRequirement[];
  headerRequirements?: PluginComponentHeaderRequirement[];
}): boolean {
  return Boolean(
    component.envRequirements?.length || component.headerRequirements?.length,
  );
}

interface SetupRow {
  /** `env:NAME` / `header:NAME` — stable identity across both groups. */
  rowKey: string;
  group: "env" | "header";
  name: string;
  /**
   * The value the BUNDLE declared for this name — a screened non-secret
   * literal, or a `${PLUGIN_ROOT}`-style template string. Either way it must
   * be re-sent on every save of this group (replace semantics).
   */
  declaredValue?: string;
  /** Template-supplied (`${PLUGIN_ROOT}`-style): the runtime resolves it at
   * launch — pre-configured, never user-editable text. */
  template: boolean;
  optional: boolean;
}

export function PluginServerSetupEditor({
  envRequirements = [],
  headerRequirements = [],
  busy = false,
  onSave,
  onCancel,
}: {
  envRequirements?: PluginComponentEnvRequirement[];
  headerRequirements?: PluginComponentHeaderRequirement[];
  busy?: boolean;
  onSave: (values: PluginServerSetupValues) => void | Promise<void>;
  onCancel: () => void;
}) {
  const rows = useMemo<SetupRow[]>(
    () => [
      ...envRequirements.map((entry) => {
        // `hasTemplate` is the marker and `valueTemplate` the string; accept
        // either as proof this entry is template-supplied.
        const template =
          entry.hasTemplate === true || entry.valueTemplate !== undefined;
        return {
          rowKey: `env:${entry.name}`,
          group: "env" as const,
          name: entry.name,
          declaredValue: entry.value ?? entry.valueTemplate,
          template,
          // Only an EXPLICIT required:false is rendered as optional — an
          // omitted flag must not claim optionality the bundle never
          // declared.
          optional:
            entry.required === false && entry.value === undefined && !template,
        };
      }),
      ...headerRequirements.map((entry) => ({
        rowKey: `header:${entry.name}`,
        group: "header" as const,
        name: entry.name,
        declaredValue: entry.value,
        template: false,
        optional: false,
      })),
    ],
    [envRequirements, headerRequirements],
  );

  const [values, setValues] = useState<Record<string, string>>({});
  /** Literal rows the user chose to override (editable from then on). */
  const [overridden, setOverridden] = useState<ReadonlySet<string>>(
    () => new Set(),
  );
  /** Rows whose value the user hid again. New rows start visible: that is
   * where typing happens (matching the generic editors' just-added rows). */
  const [hiddenRows, setHiddenRows] = useState<ReadonlySet<string>>(
    () => new Set(),
  );

  const collected = useMemo<PluginServerSetupValues>(() => {
    /**
     * The COMPLETE map for one group, or `undefined` when the user changed
     * nothing in it. Every declared literal and template is carried through
     * even when untouched — under replace semantics, omitting one deletes it.
     */
    const buildGroup = (
      group: SetupRow["group"],
    ): Record<string, string> | undefined => {
      const map: Record<string, string> = {};
      let changed = false;
      for (const row of rows) {
        if (row.group !== group) continue;
        const typed = values[row.rowKey];
        // Whitespace-only counts as "no value" (matching the clientSecret
        // convention), but the exact typed value is what gets sent.
        const hasTyped = Boolean(typed && typed.trim());
        if (hasTyped && typed !== row.declaredValue) changed = true;
        const effective = hasTyped ? typed : row.declaredValue;
        // A name-only requirement the user has not filled in has no value to
        // send; it stays absent rather than being written as empty.
        if (effective !== undefined) map[row.name] = effective;
      }
      return changed ? map : undefined;
    };

    const env = buildGroup("env");
    const headers = buildGroup("header");
    return {
      ...(env ? { env } : {}),
      ...(headers ? { headers } : {}),
    };
  }, [rows, values]);

  const hasChanges =
    collected.env !== undefined || collected.headers !== undefined;

  return (
    <div
      className="space-y-1.5 rounded-md border border-border/60 bg-muted/20 px-2.5 py-2"
      data-testid="plugin-server-setup"
    >
      <ul className="space-y-1.5">
        {rows.map((row) => {
          const isLiteral =
            row.declaredValue !== undefined && !overridden.has(row.rowKey);
          return (
            <li key={row.rowKey} className="flex items-center gap-2 text-xs">
              <code className="shrink-0 rounded bg-muted px-1 py-0.5">
                {row.name}
              </code>
              {row.optional ? (
                <span className="shrink-0 text-muted-foreground">optional</span>
              ) : null}
              {row.template ? (
                // Runtime-resolved template: nothing to enter, nothing to
                // override — the value does not exist until launch.
                <span
                  className="ml-auto text-muted-foreground"
                  title="Supplied by the bundle and resolved at launch"
                >
                  Pre-configured
                </span>
              ) : isLiteral ? (
                <>
                  <span
                    className="min-w-0 truncate font-mono text-muted-foreground"
                    title="Declared by the bundle"
                  >
                    {row.declaredValue}
                  </span>
                  <Button
                    variant="ghost"
                    size="sm"
                    className="ml-auto h-6 shrink-0 px-2 text-xs"
                    disabled={busy}
                    onClick={() => {
                      setValues((prev) => ({
                        ...prev,
                        [row.rowKey]: row.declaredValue ?? "",
                      }));
                      setOverridden((prev) =>
                        new Set(prev).add(row.rowKey),
                      );
                    }}
                  >
                    Override
                  </Button>
                </>
              ) : (
                <MaskedValueInput
                  value={values[row.rowKey] ?? ""}
                  onChange={(value) =>
                    setValues((prev) => ({ ...prev, [row.rowKey]: value }))
                  }
                  visible={!hiddenRows.has(row.rowKey)}
                  onToggleVisibility={() =>
                    setHiddenRows((prev) => {
                      const next = new Set(prev);
                      if (next.has(row.rowKey)) next.delete(row.rowKey);
                      else next.add(row.rowKey);
                      return next;
                    })
                  }
                  inputLabel={`Value for ${row.name}`}
                  subject={row.name}
                  className="min-w-0 flex-1"
                />
              )}
            </li>
          );
        })}
      </ul>
      <div className="flex items-center justify-end gap-1.5 pt-0.5">
        <Button
          variant="ghost"
          size="sm"
          className="h-6 px-2 text-xs"
          disabled={busy}
          onClick={onCancel}
        >
          Cancel
        </Button>
        <Button
          size="sm"
          className="h-6 px-2 text-xs"
          disabled={busy || !hasChanges}
          onClick={() => void onSave(collected)}
          data-testid="plugin-server-setup-save"
        >
          Save values
        </Button>
      </div>
    </div>
  );
}
