import { Check } from "lucide-react";
import { cn } from "@/lib/utils";

interface ProviderRowProps {
  logo: string;
  logoAlt: string;
  name: string;
  isConfigured: boolean;
  onEdit: () => void;
  configType?: "api-key" | "base-url";
}

export function ProviderRow({
  logo,
  logoAlt,
  name,
  isConfigured,
  onEdit,
  configType = "api-key",
}: ProviderRowProps) {
  const addLabel = configType === "base-url" ? "Add Base URL" : "Add API Key";

  return (
    <button
      type="button"
      onClick={onEdit}
      className={cn(
        "w-full flex items-center justify-between px-4 py-3 rounded-md border transition-colors text-left",
        "hover:bg-muted/30 cursor-pointer",
        isConfigured ? "border-success/30" : "border-border/40",
      )}
    >
      <div className="flex items-center gap-3">
        <img src={logo} alt={logoAlt} className="size-5 object-contain" />
        <span className="text-sm font-medium">{name}</span>
        {isConfigured && <Check className="size-4 text-success" />}
      </div>

      <span className="text-sm text-muted-foreground">
        {isConfigured ? "Edit" : addLabel}
      </span>
    </button>
  );
}
