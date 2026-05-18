import { useCallback, useEffect, useMemo, useState } from "react";
import { Button } from "@mcpjam/design-system/button";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@mcpjam/design-system/dialog";
import { Textarea } from "@mcpjam/design-system/textarea";
import { Label } from "@mcpjam/design-system/label";
import type { ChatboxHostStyle } from "@/lib/chatbox-host-style";
import { getHostCapabilitiesForStyle } from "@/lib/host-styles";

/**
 * Direct-Chat editor for the MCP Apps `hostCapabilities` override
 * (advertised in ui/initialize). Mirrors the JSON section in
 * `HostConfigEditor`, surfaced as a standalone dialog because Direct Chat
 * doesn't own a v2 HostConfig row — its override lives in the
 * preferences-store and persists to localStorage.
 *
 * The dialog stages edits locally so the user can preview/abandon without
 * touching the persisted override until they click Save.
 */
export interface HostCapabilitiesOverrideDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  hostStyle: ChatboxHostStyle;
  /** Current saved override; undefined means "using host style preset". */
  override: Record<string, unknown> | undefined;
  /** Called on Save with the parsed override or undefined to reset to preset. */
  onSave: (next: Record<string, unknown> | undefined) => void;
}

export function HostCapabilitiesOverrideDialog({
  open,
  onOpenChange,
  hostStyle,
  override,
  onSave,
}: HostCapabilitiesOverrideDialogProps) {
  const profilePreset = useMemo(
    () => getHostCapabilitiesForStyle(hostStyle),
    [hostStyle],
  );
  const profilePresetJson = useMemo(
    () => JSON.stringify(profilePreset, null, 2),
    [profilePreset],
  );

  const initialText = useMemo(() => {
    if (override === undefined) return profilePresetJson;
    return JSON.stringify(override, null, 2);
  }, [override, profilePresetJson]);

  const [text, setText] = useState(initialText);
  const [error, setError] = useState<string | null>(null);

  // Re-sync local text every time the dialog opens (or the upstream
  // override/style changes while open). Without this, reopening after a
  // cancel would still show stale edits.
  useEffect(() => {
    if (open) {
      setText(initialText);
      setError(null);
    }
  }, [open, initialText]);

  const onTextChange = useCallback((value: string) => {
    setText(value);
    try {
      const parsed = JSON.parse(value || "{}");
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
        setError("Value must be a JSON object");
        return;
      }
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Invalid JSON");
    }
  }, []);

  const isOverriding = override !== undefined;

  const handleSave = useCallback(() => {
    try {
      const parsed = JSON.parse(text || "{}") as Record<string, unknown>;
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
        setError("Value must be a JSON object");
        return;
      }
      onSave(parsed);
      onOpenChange(false);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Invalid JSON");
    }
  }, [text, onSave, onOpenChange]);

  const handleResetToPreset = useCallback(() => {
    onSave(undefined);
    onOpenChange(false);
  }, [onSave, onOpenChange]);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        className="max-w-2xl"
        aria-describedby={undefined}
      >
        <DialogHeader>
          <DialogTitle>Host capabilities override</DialogTitle>
        </DialogHeader>

        <div className="grid gap-2 py-2">
          <div className="flex items-center justify-between gap-2">
            <Label htmlFor="host-capabilities-override-textarea">
              JSON
            </Label>
            {isOverriding ? (
              <span className="text-xs text-muted-foreground">
                Custom override active
              </span>
            ) : null}
          </div>
          <Textarea
            id="host-capabilities-override-textarea"
            className="font-mono text-xs"
            rows={14}
            value={text}
            onChange={(e) => onTextChange(e.target.value)}
            placeholder={profilePresetJson}
            spellCheck={false}
          />
          {error && (
            <p className="text-xs text-destructive">{error}</p>
          )}
        </div>

        <DialogFooter className="gap-2 sm:gap-2">
          <Button
            type="button"
            variant="ghost"
            onClick={handleResetToPreset}
            disabled={!isOverriding}
          >
            Clear override
          </Button>
          <div className="flex-1" />
          <Button
            type="button"
            variant="outline"
            onClick={() => onOpenChange(false)}
          >
            Cancel
          </Button>
          <Button type="button" onClick={handleSave} disabled={error != null}>
            Save
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
