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
import { toast } from "@/lib/toast";

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
  onInvalidChange,
}: {
  /** The saved override; absent means the default. */
  seconds?: number;
  onSave: (seconds: number | null) => Promise<void>;
  /**
   * True while the field holds a value that cannot be saved, so Settings can
   * hold Back until it is fixed. A save in flight does not hold Back:
   * pressing Back is what blurs the field and starts that save, so holding it
   * would swallow the click. The save finishes, and reports a failure, after
   * Settings closes.
   */
  onInvalidChange?: (invalid: boolean) => void;
}) {
  const id = useId();
  // What this field last knows is saved: the prop, or its own save that
  // landed before the prop caught up (a saved run's Settings reads a
  // snapshot), so a later change is compared with the value really stored.
  const [saved, setSaved] = useState(seconds);
  useEffect(() => setSaved(seconds), [seconds]);
  const effectiveSeconds = saved ?? DEFAULT_CONFORMANCE_RUN_TIMEOUT_SECONDS;
  const [draft, setDraft] = useState(String(effectiveSeconds));
  const [invalid, setInvalid] = useState(false);
  const [saving, setSaving] = useState(false);
  const editing = useRef(false);
  // A number field reports text it cannot parse (e.g. "3e" or "-") as "",
  // the same as a cleared field; only its validity tells them apart.
  const badInput = useRef(false);

  // A saved value that changes (a teammate's save, or this one landing) shows
  // here, unless the field is being edited. It replaces whatever the field
  // held, an invalid value included, so that error goes with it. Only on a
  // change: a failed save keeps what was typed so it can be retried.
  useEffect(() => {
    if (editing.current) return;
    setDraft(String(effectiveSeconds));
    badInput.current = false;
    setInvalid(false);
  }, [effectiveSeconds]);

  useEffect(() => {
    onInvalidChange?.(invalid);
  }, [invalid, onInvalidChange]);

  const commit = async () => {
    editing.current = false;
    if (saving) return;
    const value = badInput.current ? Number.NaN : parseTimeout(draft);
    if (Number.isNaN(value)) {
      setInvalid(true);
      return;
    }
    setInvalid(false);
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
      // Like the checks and inputs on this page: a toast, which still shows
      // when Back already closed Settings.
      toast.error("Could not save the run timeout. Try again.");
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
          badInput.current = event.target.validity.badInput;
          setDraft(event.target.value);
          if (invalid) setInvalid(false);
        }}
        onBlur={() => void commit()}
        aria-invalid={invalid}
        aria-describedby={`${id}-help${invalid ? ` ${id}-error` : ""}`}
      />
      <p id={`${id}-help`} className="text-sm text-muted-foreground">
        {saving
          ? "Saving..."
          : "Maximum time for the whole run. Defaults to 300 seconds (5 minutes)."}
      </p>
      {invalid && (
        <p id={`${id}-error`} role="alert" className="text-sm text-destructive">
          {INVALID}
        </p>
      )}
    </form>
  );
}
