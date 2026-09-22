import { useId } from "react";
import { Minus, Plus } from "lucide-react";
import { Button } from "@mcpjam/design-system/button";
import { Input } from "@mcpjam/design-system/input";
export function RunIterationControl({
  value,
  onChange,
  disabled = false,
}: {
  value: string;
  onChange: (value: string) => void;
  disabled?: boolean;
}) {
  const id = useId();
  const count = Number(value);
  const valid = Number.isInteger(count) && count >= 1 && count <= 10;
  return (
    <section>
      <label htmlFor={id} className="mb-3 block text-sm font-semibold">
        Iterations per case
      </label>
      <div className="flex items-center gap-2">
        <Button
          variant="outline"
          size="icon"
          aria-label="Fewer iterations"
          disabled={disabled || !valid || count <= 1}
          onClick={() => onChange(String(count - 1))}
        >
          <Minus className="size-4" />
        </Button>
        <Input
          id={id}
          type="number"
          min={1}
          max={10}
          step={1}
          value={value}
          disabled={disabled}
          onChange={(event) => onChange(event.target.value)}
          className="w-20 text-center font-mono"
          aria-invalid={!valid}
        />
        <Button
          variant="outline"
          size="icon"
          aria-label="More iterations"
          disabled={disabled || !valid || count >= 10}
          onClick={() => onChange(String(count + 1))}
        >
          <Plus className="size-4" />
        </Button>
      </div>
      {!valid && (
        <p role="alert" className="mt-2 text-xs text-destructive">
          Enter a whole number from 1 to 10.
        </p>
      )}
    </section>
  );
}
