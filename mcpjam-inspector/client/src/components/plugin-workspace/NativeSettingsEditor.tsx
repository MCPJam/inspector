import { useId, useSyncExternalStore } from "react";
import { Button } from "@mcpjam/design-system/button";
import { Label } from "@mcpjam/design-system/label";
import { Switch } from "@mcpjam/design-system/switch";
import { describePluginSettingsError } from "../host-workspace/plugin-settings-errors";
import { SchemaFormFieldControl } from "../schema-form/SchemaFormFieldControl";
import { patternHint, type SchemaFormField } from "../schema-form/field";
import type { PluginSettingsField } from "@/shared/plugin-settings";
import type { NativeSettingsController } from "./native-settings-controller";
type NativeSettingsAction = {
  name: string;
  kind: "tool" | "app" | "unavailable";
};
import { Loader2 } from "lucide-react";

function controlField(field: PluginSettingsField): SchemaFormField {
  return {
    ...field,
    kind: field.enum ? "enum" : field.type,
    required: false,
    options: field.enum?.map((value) => ({ value, label: value })),
  };
}

/** Reuses controlled fields; settings owns its separate save/refresh lifetime. */
export function NativeSettingsEditor({
  controller,
  actions = [],
  onAction,
  actionPending,
  actionResult,
  appActionsAvailable = false,
}: {
  controller: NativeSettingsController;
  actions?:
    | readonly NativeSettingsAction[]
    | (() => readonly NativeSettingsAction[]);
  onAction?: (tool: string) => void;
  actionPending?: string;
  actionResult?: { tool: string; text: string; failed: boolean };
  appActionsAvailable?: boolean;
}) {
  const snapshot = useSyncExternalStore(
    controller.subscribe,
    controller.getSnapshot,
  );
  const prefix = useId();
  const { document, busy, closed, invalidated, uncertain } = snapshot;
  const disabled = closed || invalidated;
  const currentActions = typeof actions === "function" ? actions() : actions;
  return (
    <section
      aria-label="Native plugin settings"
      data-plugin-private="settings"
      className="space-y-6"
    >
      {document.groups.map((group, groupIndex) => (
        <fieldset key={groupIndex} className="space-y-2" disabled={disabled}>
          <legend className="mb-2 text-sm font-medium">{group.title}</legend>
          {/* Grouped rows: label left, control right (booleans as switches). */}
          <div className="divide-y divide-border/60 rounded-lg border border-border bg-muted/30">
            {group.items.map((item, itemIndex) => {
              if (item.kind === "tool") {
                const action = currentActions.find(
                  (action) => action.name === item.tool,
                );
                const available =
                  Boolean(onAction) &&
                  (action?.kind === "tool" ||
                    (action?.kind === "app" && appActionsAvailable));
                const running = actionPending === item.tool;
                const result =
                  actionResult?.tool === item.tool ? actionResult : undefined;
                return (
                  <div
                    key={itemIndex}
                    className="flex items-center justify-between gap-4 px-4 py-3"
                  >
                    <div className="min-w-0 flex-1 space-y-0.5">
                      <p className="text-sm">{item.title}</p>
                      {item.description && (
                        <p className="text-xs text-muted-foreground">
                          {item.description}
                        </p>
                      )}
                      {!available && (
                        <p className="text-xs text-muted-foreground">
                          {action?.kind === "app"
                            ? "This client cannot display this settings app."
                            : "This settings action is unavailable."}
                        </p>
                      )}
                      {running ? (
                        <p
                          role="status"
                          className="text-xs text-muted-foreground"
                        >
                          Running {item.title}…
                        </p>
                      ) : result ? (
                        <p
                          role="status"
                          title={result.text}
                          className={
                            result.failed
                              ? "line-clamp-2 text-xs text-destructive"
                              : "line-clamp-2 text-xs text-muted-foreground"
                          }
                        >
                          {result.text}
                        </p>
                      ) : null}
                    </div>
                    <Button
                      type="button"
                      variant="outline"
                      size="sm"
                      className="shrink-0"
                      disabled={
                        !available ||
                        disabled ||
                        uncertain ||
                        Boolean(busy) ||
                        Boolean(actionPending)
                      }
                      onClick={() => onAction?.(item.tool)}
                      title={
                        result
                          ? result.text
                          : !available
                          ? action?.kind === "app"
                            ? "This client cannot display this settings app"
                            : "This settings action is unavailable"
                          : undefined
                      }
                    >
                      {running && (
                        <Loader2
                          aria-hidden="true"
                          className="size-4 animate-spin"
                        />
                      )}
                      {item.title}
                    </Button>
                  </div>
                );
              }
              const field = document.fields.find(
                (field) => field.name === item.property,
              )!;
              const control = controlField(field);
              const id = `${prefix}-${groupIndex}-${itemIndex}`;
              const error = snapshot.errors[field.name];
              const isBoolean = control.kind === "boolean";
              return (
                <div
                  key={itemIndex}
                  className="flex items-center justify-between gap-4 px-4 py-3"
                >
                  <div className="min-w-0 flex-1 space-y-0.5">
                    <Label htmlFor={id} className="text-sm font-normal">
                      {field.title}
                    </Label>
                    {field.description && (
                      <p className="text-xs text-muted-foreground">
                        {field.description}
                      </p>
                    )}
                    {patternHint(control) && (
                      <p className="text-xs text-muted-foreground">
                        {patternHint(control)}
                      </p>
                    )}
                    {error && (
                      <p
                        id={`${id}-error`}
                        role="alert"
                        className="text-xs text-destructive"
                      >
                        {error}
                      </p>
                    )}
                  </div>
                  {isBoolean ? (
                    <Switch
                      id={id}
                      className="shrink-0"
                      checked={Boolean(snapshot.draft[field.name])}
                      disabled={disabled}
                      aria-invalid={Boolean(error)}
                      aria-describedby={error ? `${id}-error` : undefined}
                      onCheckedChange={(checked) =>
                        controller.edit(field.name, checked)
                      }
                    />
                  ) : (
                    <div className="w-48 shrink-0">
                      <SchemaFormFieldControl
                        field={control}
                        id={id}
                        value={snapshot.draft[field.name]}
                        error={error}
                        disabled={disabled}
                        onChange={(value) => controller.edit(field.name, value)}
                      />
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        </fieldset>
      ))}
      {invalidated && (
        <p role="alert" className="text-sm text-destructive">
          The settings schema changed. Close and reopen settings before saving.
        </p>
      )}
      {uncertain && (
        <p role="alert" className="text-sm text-destructive">
          {snapshot.error === "PLUGIN_SETTINGS_ACTION_REFRESH_REQUIRED"
            ? describePluginSettingsError(snapshot.error)
            : "Saving could not be confirmed. Refresh to check the server before saving again."}
        </p>
      )}
      {snapshot.error && !uncertain && (
        <p role="alert" className="text-sm text-destructive">
          {describePluginSettingsError(snapshot.error)} Your edits are still
          here.
        </p>
      )}
      <div className="flex flex-wrap items-center gap-3">
        <Button
          type="button"
          variant="outline"
          disabled={disabled || Boolean(busy) || Boolean(actionPending)}
          onClick={() => void controller.refresh().catch(() => {})}
        >
          {busy === "refresh" ? "Refreshing…" : "Refresh settings"}
        </Button>
        <Button
          type="button"
          variant="secondary"
          disabled={
            disabled ||
            uncertain ||
            Boolean(busy) ||
            Boolean(actionPending) ||
            !snapshot.dirty ||
            Object.keys(snapshot.errors).length > 0
          }
          onClick={() => void controller.save().catch(() => {})}
        >
          {busy === "save" ? "Saving…" : "Save settings"}
        </Button>
        <p role="status" className="text-sm text-muted-foreground">
          {busy
            ? busy === "save"
              ? "Saving changes"
              : "Checking server settings"
            : snapshot.dirty
            ? "Unsaved changes"
            : "Settings are up to date"}
        </p>
      </div>
    </section>
  );
}
