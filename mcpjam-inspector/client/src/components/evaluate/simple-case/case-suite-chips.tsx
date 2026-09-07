import { Button } from "@mcpjam/design-system/button";
import { cn } from "@/lib/utils";
import { resolveModelOptionLabel } from "../../evals/compare-playground-helpers";

export type CaseSuiteChipsProps = {
  models: string[];
  modelLabelByValue?: Record<string, string>;
  trials: number;
  hostLabel: string;
  onOpen?: () => void;
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
  modelLabelByValue = {},
  trials,
  hostLabel,
  onOpen,
  onOpenSuiteSettings,
}: CaseSuiteChipsProps) {
  const open = onOpen ?? onOpenSuiteSettings;
  const firstLabel =
    models.length === 0
      ? "Suite default"
      : resolveModelOptionLabel(models[0]!, modelLabelByValue);
  const modelValue =
    models.length <= 1 ? firstLabel : `${firstLabel} +${models.length - 1}`;
  return (
    <div
      className="flex flex-wrap items-center gap-1.5"
      data-testid="case-suite-chips"
    >
      <Chip label="Model" value={modelValue} onOpen={open} />
      <Chip label="Trials" value={String(trials)} onOpen={open} />
      <Chip label="Host" value={hostLabel} onOpen={open} />
    </div>
  );
}
