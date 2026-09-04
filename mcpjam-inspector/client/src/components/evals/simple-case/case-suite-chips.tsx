import { Button } from "@mcpjam/design-system/button";
import { cn } from "@/lib/utils";

export type CaseSuiteChipsProps = {
  models: string[];
  trials: number;
  hostLabel: string;
  onOpenSuiteSettings?: () => void;
};

function Chip({
  label,
  value,
  onOpen,
}: {
  label: string;
  value: string;
  onOpen?: () => void;
}) {
  const body = (
    <>
      <span className="text-muted-foreground">{label}</span>
      <span className="truncate text-foreground">{value}</span>
    </>
  );
  const className = cn(
    "inline-flex max-w-[14rem] items-center gap-1.5 rounded-md border border-border bg-muted/40 px-2 py-1 text-[11px]",
  );
  if (!onOpen) {
    return <span className={className}>{body}</span>;
  }
  return (
    <Button
      type="button"
      variant="ghost"
      className={cn(className, "h-auto hover:bg-muted")}
      onClick={onOpen}
    >
      {body}
    </Button>
  );
}

export function CaseSuiteChips({
  models,
  trials,
  hostLabel,
  onOpenSuiteSettings,
}: CaseSuiteChipsProps) {
  const modelValue =
    models.length === 0
      ? "Suite default"
      : models.length === 1
        ? models[0]
        : `${models[0]} +${models.length - 1}`;
  return (
    <div
      className="flex flex-wrap items-center gap-1.5"
      data-testid="case-suite-chips"
    >
      <Chip
        label="Model"
        value={modelValue}
        onOpen={onOpenSuiteSettings}
      />
      <Chip
        label="Trials"
        value={String(trials)}
        onOpen={onOpenSuiteSettings}
      />
      <Chip label="Host" value={hostLabel} onOpen={onOpenSuiteSettings} />
    </div>
  );
}
