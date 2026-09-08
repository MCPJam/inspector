import { Button } from "@mcpjam/design-system/button";
import { Label } from "@mcpjam/design-system/label";
import {
  Sheet,
  SheetContent,
  SheetHeader,
  SheetTitle,
} from "@mcpjam/design-system/sheet";

export type NextRunHostOption = {
  value: string;
  label: string;
};

export type NextRunModelOption = {
  value: string;
  label: string;
};

/**
 * Two groups, labelled by what the software actually does with the value.
 * Trials and Model are written to the case (`runs`, `models`) before every
 * quick run and on Save; only the host is a per-run choice.
 */
export function NextRunSheet({
  open,
  onOpenChange,
  trials,
  onTrialsChange,
  hostValue,
  hostOptions,
  onHostChange,
  modelValue,
  modelOptions,
  onModelChange,
  onOpenSuiteSettings,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  trials: number;
  onTrialsChange: (next: number) => void;
  hostValue: string;
  hostOptions: NextRunHostOption[];
  onHostChange: (next: string) => void;
  modelValue: string;
  modelOptions: NextRunModelOption[];
  onModelChange: (next: string) => void;
  onOpenSuiteSettings?: () => void;
}) {
  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent
        side="right"
        className="sm:max-w-sm"
        data-testid="next-run-sheet"
      >
        <SheetHeader>
          <SheetTitle>Next run</SheetTitle>
        </SheetHeader>
        <div className="flex flex-col gap-6 px-4 pb-6">
          <section className="space-y-3" data-testid="next-run-saved-group">
            <h3 className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
              Saved with this case
            </h3>
            <div className="space-y-1.5">
              <Label htmlFor="next-run-trials" className="text-[11px]">
                Trials
              </Label>
              <select
                id="next-run-trials"
                className="h-8 w-full rounded-md border border-input bg-background px-2 text-xs"
                value={trials}
                onChange={(event) => onTrialsChange(Number(event.target.value))}
              >
                {Array.from({ length: 10 }, (_, index) => index + 1).map(
                  (count) => (
                    <option key={count} value={count}>
                      {count}
                    </option>
                  ),
                )}
              </select>
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="next-run-model" className="text-[11px]">
                Model
              </Label>
              <select
                id="next-run-model"
                className="h-8 w-full rounded-md border border-input bg-background px-2 text-xs"
                value={modelValue}
                onChange={(event) => onModelChange(event.target.value)}
              >
                {modelOptions.map((option) => (
                  <option key={option.value} value={option.value}>
                    {option.label}
                  </option>
                ))}
              </select>
            </div>
          </section>
          <section className="space-y-3" data-testid="next-run-for-this-run">
            <h3 className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
              For this run
            </h3>
            <div className="space-y-1.5">
              <Label htmlFor="next-run-host" className="text-[11px]">
                Host
              </Label>
              {hostOptions.length > 0 ? (
                <select
                  id="next-run-host"
                  className="h-8 w-full rounded-md border border-input bg-background px-2 text-xs"
                  value={hostValue}
                  onChange={(event) => onHostChange(event.target.value)}
                >
                  {hostOptions.map((option) => (
                    <option key={option.value} value={option.value}>
                      {option.label}
                    </option>
                  ))}
                </select>
              ) : (
                <p className="text-xs text-muted-foreground">{hostValue}</p>
              )}
            </div>
            {onOpenSuiteSettings ? (
              <Button
                type="button"
                variant="ghost"
                size="sm"
                className="h-7 px-0 text-xs text-muted-foreground"
                onClick={onOpenSuiteSettings}
              >
                Suite settings
              </Button>
            ) : null}
          </section>
        </div>
      </SheetContent>
    </Sheet>
  );
}
