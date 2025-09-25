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

interface ProviderConfig {
  id: string;
  name: string;
  logo: string;
  logoAlt: string;
  description: string;
  placeholder: string;
  getApiKeyUrl: string;
}

interface ProviderTableRowProps {
  config: ProviderConfig;
  isConfigured: boolean;
  onEdit: (providerId: string) => void;
  onDelete: (providerId: string) => void;
}

export function ProviderTableRow({
  config,
  isConfigured,
  onEdit,
  onDelete,
}: ProviderTableRowProps) {
  const description = config.description?.trim();

  return (
    <Card
      className={cn(
        "group h-full gap-4 border bg-card px-6 py-6 transition-all hover:border-primary/40 hover:shadow-md dark:hover:shadow-xl",
        isConfigured
          ? "border-green-200/80 dark:border-green-400/30"
          : "border-border/60",
      )}
    >
      <div className="flex items-start justify-between gap-6">
        <div className="flex items-center gap-4">
          <img
            src={config.logo}
            alt={config.logoAlt}
            className="size-6 object-contain"
          />
          <div className="">
            <h3 className="text-md font-semibold text-foreground pb-1">
              {config.name}{" "}
              {isConfigured && <span className="text-md">✔️</span>}
            </h3>
            {description ? (
              <p className="line-clamp-2 text-xs leading-relaxed text-muted-foreground">
                {description}
              </p>
            ) : null}
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
                onClick={() => onDelete(config.id)}
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
          onClick={() => onEdit(config.id)}
        >
          {isConfigured ? "Manage" : "Configure"}
        </Button>
      </div>
    </Card>
  );
}
