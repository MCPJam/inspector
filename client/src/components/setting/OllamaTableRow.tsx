import { Button } from "../ui/button";
import { Card } from "../ui/card";
import { cn } from "@/lib/utils";

interface OllamaTableRowProps {
  baseUrl: string;
  onEdit: () => void;
}

export function OllamaTableRow({ baseUrl, onEdit }: OllamaTableRowProps) {
  const isConfigured = Boolean(baseUrl);

  return (
    <Card
      className={cn(
        "group h-full gap-4 border bg-card px-6 py-6 transition-all hover:border-primary/40 hover:shadow-md dark:hover:shadow-xl",
        isConfigured ? "border-success/30" : "border-border/60",
      )}
    >
      <div className="flex items-start justify-between gap-6">
        <div className="flex items-center gap-4">
          <img
            src="/ollama_logo.svg"
            alt="Ollama"
            className="size-6 object-contain"
          />
          <div className="">
            <h3 className="text-md font-semibold text-foreground pb-1">
              Ollama {isConfigured && <span className="text-md">✔️</span>}
            </h3>
            <p className="line-clamp-2 text-xs leading-relaxed text-muted-foreground">
              {isConfigured
                ? "Local models available"
                : "Install and connect Ollama locally"}
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
