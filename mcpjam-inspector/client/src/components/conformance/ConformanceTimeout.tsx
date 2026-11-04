import { useId, useState } from "react";
import { Clock } from "lucide-react";
import { Button } from "@mcpjam/design-system/button";
import { Input } from "@mcpjam/design-system/input";
import { Label } from "@mcpjam/design-system/label";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@mcpjam/design-system/popover";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@mcpjam/design-system/tooltip";

export function ConformanceTimeout({
  seconds,
  onSave,
}: {
  seconds?: number;
  onSave: (seconds: number | null) => Promise<void>;
}) {
  const id = useId();
  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState("");
  const [error, setError] = useState<string>();
  const [saving, setSaving] = useState(false);
  const save = async () => {
    if (saving) return;
    const value = draft.trim() === "" ? null : Number(draft);
    if (
      value !== null &&
      (!Number.isInteger(value) || value < 1 || value > 300)
    ) {
      setError("Enter a whole number from 1 to 300 seconds.");
      return;
    }
    setSaving(true);
    setError(undefined);
    try {
      await onSave(value);
      setOpen(false);
    } catch {
      setError("Could not save the timeout. Try again.");
    } finally {
      setSaving(false);
    }
  };
  return (
    <Popover
      open={open}
      onOpenChange={(next) => {
        if (saving) return;
        if (next) {
          setDraft(seconds?.toString() ?? "");
          setError(undefined);
        }
        setOpen(next);
      }}
    >
      <Tooltip>
        <TooltipTrigger asChild>
          <PopoverTrigger asChild>
            <Button variant="ghost" size="sm" aria-label="Run timeout">
              <Clock className="size-4" />
              {seconds !== undefined && <span>{seconds}s</span>}
            </Button>
          </PopoverTrigger>
        </TooltipTrigger>
        <TooltipContent>Run timeout</TooltipContent>
      </Tooltip>
      <PopoverContent align="end" className="w-80 space-y-3">
        <form
          noValidate
          className="space-y-3"
          onSubmit={(event) => {
            event.preventDefault();
            void save();
          }}
        >
          <Label htmlFor={id}>Total run timeout (seconds)</Label>
          <Input
            id={id}
            type="number"
            min={1}
            max={300}
            step={1}
            value={draft}
            disabled={saving}
            onChange={(event) => setDraft(event.target.value)}
            aria-invalid={Boolean(error)}
            aria-describedby={`${id}-help${error ? ` ${id}-error` : ""}`}
          />
          <p id={`${id}-help`} className="text-sm text-muted-foreground">
            Up to 300 seconds. Leave blank for no total limit. Individual check
            limits still apply.
          </p>
          {error && (
            <p
              id={`${id}-error`}
              role="alert"
              className="text-sm text-destructive"
            >
              {error}
            </p>
          )}
          <Button type="submit" disabled={saving}>
            {saving ? "Saving…" : "Save"}
          </Button>
        </form>
      </PopoverContent>
    </Popover>
  );
}
