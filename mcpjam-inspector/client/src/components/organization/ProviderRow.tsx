import { CheckCircle2, Circle, Pencil, Settings2, Trash2 } from "lucide-react";
import { Badge } from "@mcpjam/design-system/badge";
import { Button } from "@mcpjam/design-system/button";

export function ProviderRow({
  name,
  logo,
  configured,
  isAdmin,
  isCustom,
  onConfigure,
  onRemove,
}: {
  name: string;
  logo?: string;
  configured: boolean;
  isAdmin: boolean;
  isCustom?: boolean;
  onConfigure: () => void;
  onRemove: () => void;
}) {
  return (
    <div className="flex items-center justify-between rounded-md border border-border/40 px-3 py-2.5">
      <div className="flex items-center gap-3">
        {logo ? (
          <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-md border bg-card p-1">
            <img
              src={logo}
              alt={name}
              className="h-full w-full object-contain"
            />
          </div>
        ) : (
          <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-md border bg-muted text-xs font-semibold text-muted-foreground">
            {name.charAt(0).toUpperCase()}
          </div>
        )}
        <div className="flex items-center gap-2">
          <span className="text-sm font-medium">{name}</span>
          {isCustom ? (
            <Badge variant="outline" className="text-[10px]">
              Custom
            </Badge>
          ) : null}
        </div>
      </div>

      <div className="flex items-center gap-2">
        {configured ? (
          <Badge
            variant="secondary"
            className="gap-1 text-xs text-emerald-600 dark:text-emerald-400"
          >
            <CheckCircle2 className="size-3" />
            Configured
          </Badge>
        ) : (
          <Badge
            variant="outline"
            className="gap-1 text-xs text-muted-foreground"
          >
            <Circle className="size-3" />
            Not configured
          </Badge>
        )}

        {isAdmin ? (
          <>
            <Button variant="ghost" size="sm" onClick={onConfigure}>
              {configured ? (
                <Pencil className="size-3.5" />
              ) : (
                <>
                  <Settings2 className="mr-1.5 size-3.5" />
                  Configure
                </>
              )}
            </Button>
            {configured ? (
              <Button
                variant="ghost"
                size="sm"
                onClick={onRemove}
                className="text-destructive hover:text-destructive hover:bg-destructive/10"
              >
                <Trash2 className="size-3.5" />
              </Button>
            ) : null}
          </>
        ) : null}
      </div>
    </div>
  );
}
