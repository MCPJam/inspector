import { Input } from "@mcpjam/design-system/input";
import { Eye, EyeOff } from "lucide-react";
import { cn } from "@/lib/utils";

interface MaskedValueInputProps {
  value: string;
  onChange: (value: string) => void;
  visible: boolean;
  onToggleVisibility: () => void;
  /** Accessible name for the field itself, e.g. "Environment variable 1 value". */
  inputLabel: string;
  /** What the eye acts on, e.g. "OPENAI_API_KEY" or "variable 2". Reads as
   * "Show value for OPENAI_API_KEY". */
  subject: string;
  placeholder?: string;
  /** Wrapper class, so callers keep their own row flex sizing. */
  className?: string;
}

/** Monospace value field with an eye toggle sitting inside its right edge.
 * Shared by the env-var and header editors so the two rows stay identical. */
export function MaskedValueInput({
  value,
  onChange,
  visible,
  onToggleVisibility,
  inputLabel,
  subject,
  placeholder = "value",
  className,
}: MaskedValueInputProps) {
  return (
    <div className={cn("relative", className)}>
      <Input
        type={visible ? "text" : "password"}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
        spellCheck={false}
        autoCapitalize="off"
        autoCorrect="off"
        // Keeps the browser's password manager from offering to save an MCP
        // server's config value as a login.
        autoComplete="off"
        aria-label={inputLabel}
        className="h-8 w-full pr-8 font-mono text-xs"
      />
      <button
        type="button"
        onClick={onToggleVisibility}
        aria-label={
          visible ? `Hide value for ${subject}` : `Show value for ${subject}`
        }
        className="absolute right-0.5 top-1/2 flex h-7 w-7 -translate-y-1/2 items-center justify-center rounded text-muted-foreground transition-colors hover:text-foreground"
      >
        {visible ? (
          <EyeOff className="h-3.5 w-3.5" />
        ) : (
          <Eye className="h-3.5 w-3.5" />
        )}
      </button>
    </div>
  );
}
