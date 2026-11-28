import { useContext } from "react";
import { Cpu } from "lucide-react";
import { resolveHostLogoByName } from "@/lib/host-logo";
import {
  ModelDisplayNamesContext,
  modelDisplayName,
} from "@/lib/model-display-name";
import { cn } from "@/lib/utils";
import { usePreferencesStore } from "@/stores/preferences/preferences-provider";

const PILL =
  "inline-flex h-6 shrink-0 items-center gap-1 rounded-full border border-border bg-muted/50 px-2 text-xs text-muted-foreground";

function more(count: number): string {
  return count > 1 ? ` +${count - 1}` : "";
}

/**
 * Where a suite runs, written out beside its name: the model, then the client.
 * A pill with nothing resolved yet is left out rather than showing a placeholder.
 */
export function SuitePills({
  models,
  clients,
  className,
}: {
  models: (string | null)[];
  clients: string[];
  className?: string;
}) {
  const knownModels = useContext(ModelDisplayNamesContext);
  const themeMode = usePreferencesStore((s) => s.themeMode);
  const resolvedModels = models.filter((model): model is string =>
    Boolean(model),
  );
  const model = resolvedModels[0];
  const client = clients[0];
  if (!model && !client) return null;

  return (
    <span
      className={cn("flex min-w-0 flex-wrap items-center gap-1.5", className)}
    >
      {model ? (
        <span className={PILL} title="Model">
          <Cpu className="size-3 shrink-0" aria-hidden />
          <span className="sr-only">Model: </span>
          {modelDisplayName(model, knownModels)}
          {more(resolvedModels.length)}
        </span>
      ) : null}
      {client ? (
        <span className={PILL} title="Client">
          <span className="inline-flex size-4 shrink-0 items-center justify-center rounded-sm border border-border/50 bg-background">
            <img
              src={resolveHostLogoByName(client, themeMode)}
              alt=""
              className="size-2.5 object-contain"
            />
          </span>
          <span className="sr-only">Client: </span>
          {client}
          {more(clients.length)}
        </span>
      ) : null}
    </span>
  );
}
