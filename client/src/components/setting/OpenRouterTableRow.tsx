import { Ellipsis } from "lucide-react";
import { Button } from "../ui/button";
import { Card } from "../ui/card";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "../ui/dropdown-menu";
import { cn } from "@/lib/utils";

interface OpenRouterTableRowProps {
  modelAlias: string[];
  onEdit: () => void;
  onDelete: () => void;
}

export function OpenRouterTableRow({
  modelAlias,
  onEdit,
  onDelete,
}: OpenRouterTableRowProps) {
  const isConfigured = Boolean(modelAlias && modelAlias.length > 0);

  // Count the number of models configured
  const modelCount = modelAlias ? modelAlias.length : 0;

  return (
    <Card
      className={cn(
        "group h-full gap-4 border bg-card px-6 py-6 transition-all hover:border-primary/40 hover:shadow-md dark:hover:shadow-xl",
        isConfigured ? "border-success/30" : "border-border/60",
      )}
    >
      <div className="flex items-start justify-between gap-6">
        <div className="flex items-center gap-4">
          <div className="size-6 rounded bg-card p-0.5 flex items-center justify-center border">
            <img
              src="/openrouter_logo.png"
              alt="OpenRouter Logo"
              className="w-full h-full object-contain"
            />
          </div>
          <div>
            <h3 className="text-md font-semibold text-foreground pb-1">
              OpenRouter {isConfigured && <span className="text-md">√</span>}
            </h3>
            <p className="line-clamp-2 text-xs leading-relaxed text-muted-foreground">
              {isConfigured
                ? `${modelCount} model${modelCount !== 1 ? "s" : ""} configured`
                : "Connect to OpenRouter models"}
            </p>
          </div>
        </div>
        {isConfigured ? (
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button
                size="icon"
                variant="ghost"
                className="size-8 rounded-md border border-transparent hover:bg-muted/50"
              >
                <Ellipsis className="size-4" />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="w-44">
              <DropdownMenuItem
                variant="destructive"
                onClick={() => onDelete()}
              >
                Remove provider
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        ) : null}
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
