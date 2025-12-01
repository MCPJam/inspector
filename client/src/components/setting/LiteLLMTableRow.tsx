import { Button } from "../ui/button";
import { Card } from "../ui/card";
import { cn } from "@/lib/utils";

interface LiteLLMTableRowProps {
  baseUrl: string;
  modelAlias: string;
  onEdit: () => void;
}

export function LiteLLMTableRow({
  baseUrl,
  modelAlias,
  onEdit,
}: LiteLLMTableRowProps) {
  const isConfigured = Boolean(baseUrl && modelAlias);

  // Count the number of models configured
  const modelCount = modelAlias
    ? modelAlias
        .split(",")
        .map((m) => m.trim())
        .filter((m) => m.length > 0).length
    : 0;

  return (
    <Card
      className={cn(
        "group h-full gap-4 border bg-card px-6 py-6 transition-all hover:border-primary/40 hover:shadow-md dark:hover:shadow-xl",
        isConfigured
          ? "border-success/30"
          : "border-border/60",
      )}
    >
      <div className="flex items-start justify-between gap-6">
        <div className="flex items-center gap-4">
          <div className="size-6 rounded bg-card p-0.5 flex items-center justify-center border">
            <img
              src="/litellm_logo.png"
              alt="LiteLLM Logo"
              className="w-full h-full object-contain"
            />
          </div>
          <div className="">
            <h3 className="text-md font-semibold text-foreground pb-1">
              LiteLLM {isConfigured && <span className="text-md">✔️</span>}
            </h3>
            <p className="line-clamp-2 text-xs leading-relaxed text-muted-foreground">
              {isConfigured
                ? `${modelCount} model${modelCount !== 1 ? "s" : ""} configured`
                : "Connect to your LiteLLM proxy"}
            </p>
          </div>
        </div>
      </div>
      <div className="space-y-4">
        <Button
          size="sm"
          variant={isConfigured ? "outline" : "secondary"}
          className="w-full"
          onClick={onEdit}
        >
          {isConfigured ? "Manage" : "Configure"}
        </Button>
      </div>
    </Card>
  );
}
