/**
 * The run timeout, as a section of a server's Conformance Settings. Like the
 * rest of Settings it has no Save button: a change saves when the field loses
 * focus or on Enter. Clearing the field goes back to the default.
 */

import { useEffect, useId, useRef, useState } from "react";
import {
  DEFAULT_CONFORMANCE_RUN_TIMEOUT_SECONDS,
  MAX_CONFORMANCE_RUN_TIMEOUT_SECONDS,
} from "@/shared/conformance-timeout";
import { Input } from "@mcpjam/design-system/input";
import { Label } from "@mcpjam/design-system/label";

const INVALID = `Enter a whole number from 1 to ${MAX_CONFORMANCE_RUN_TIMEOUT_SECONDS} seconds.`;

/** The field's value as a timeout: null is the default, NaN is invalid. */
function parseTimeout(draft: string): number | null {
  if (draft.trim() === "") return null;
  const value = Number(draft);
  return Number.isInteger(value) &&
    value >= 1 &&
    value <= MAX_CONFORMANCE_RUN_TIMEOUT_SECONDS
    ? value
    : Number.NaN;
}

export function ConformanceTimeoutSetting({
  seconds,
  onSave,
  onBusyChange,
}: {
  /** The saved override; absent means the default. */
  seconds?: number;
  onSave: (seconds: number | null) => Promise<void>;
  /**
   * True while a change is saving or the field holds an invalid value, so
   * Settings can hold Back until the change is saved or fixed.
   */
  onBusyChange?: (busy: boolean) => void;
}) {
  const id = useId();
  // What this field last knows is saved: the prop, or its own save that
  // landed before the prop caught up (a saved run's Settings reads a
  // snapshot), so a later change is compared with the value really stored.
  const [saved, setSaved] = useState(seconds);
  useEffect(() => setSaved(seconds), [seconds]);
  const effectiveSeconds = saved ?? DEFAULT_CONFORMANCE_RUN_TIMEOUT_SECONDS;
  const [draft, setDraft] = useState(String(effectiveSeconds));
  const [error, setError] = useState<string>();
  const [saving, setSaving] = useState(false);
  const editing = useRef(false);

  // A saved value that changes (a teammate's save, or this one landing) shows
  // here, unless the field is being edited. Only on a change: a failed save
  // keeps what was typed so it can be retried.
  useEffect(() => {
    if (!editing.current) setDraft(String(effectiveSeconds));
  }, [effectiveSeconds]);

  const invalid = error === INVALID;
  useEffect(() => {
    onBusyChange?.(saving || invalid);
  }, [saving, invalid, onBusyChange]);

  const commit = async () => {
    editing.current = false;
    if (saving) return;
    const value = parseTimeout(draft);
    if (Number.isNaN(value)) {
      setError(INVALID);
      return;
    }
    setError(undefined);
    // A cleared field reads as the default again.
    setDraft(String(value ?? DEFAULT_CONFORMANCE_RUN_TIMEOUT_SECONDS));
    const unchanged =
      (value ?? undefined) === saved ||
      (saved === undefined && value === DEFAULT_CONFORMANCE_RUN_TIMEOUT_SECONDS);
    if (unchanged) return;
    setSaving(true);
    try {
      await onSave(value);
      setSaved(value ?? undefined);
    } catch {
      setError("Could not save the timeout. Try again.");
    } finally {
      setSaving(false);
    }
  };

  return (
    <form
      noValidate
      className="space-y-2"
      onSubmit={(event) => {
        event.preventDefault();
        void commit();
      }}
    >
      <Label htmlFor={id}>Total run timeout (seconds)</Label>
      <Input
        id={id}
        type="number"
        inputMode="numeric"
        min={1}
        max={MAX_CONFORMANCE_RUN_TIMEOUT_SECONDS}
        step={1}
        value={draft}
        disabled={saving}
        className="max-w-40"
        onChange={(event) => {
          editing.current = true;
          setDraft(event.target.value);
          if (error) setError(undefined);
        }}
        onBlur={() => void commit()}
        aria-invalid={Boolean(error)}
        aria-describedby={`${id}-help${error ? ` ${id}-error` : ""}`}
      />
      <p id={`${id}-help`} className="text-sm text-muted-foreground">
        {saving
          ? "Saving..."
          : "Maximum time for the whole run. Defaults to 300 seconds (5 minutes)."}
      </p>
      {error && (
        <p id={`${id}-error`} role="alert" className="text-sm text-destructive">
          {error}
        </p>
      )}
    </form>
  );
}
