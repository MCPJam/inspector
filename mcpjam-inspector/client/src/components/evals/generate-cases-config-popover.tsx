import { useEffect, useState } from "react";
import { Button } from "@mcpjam/design-system/button";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@mcpjam/design-system/popover";
import { Switch } from "@mcpjam/design-system/switch";
import { ChevronDown, Loader2, Minus, Plus, Sparkles } from "lucide-react";

import {
  DEFAULT_GENERATE_CONFIG,
  GENERATE_BUCKET_KEYS,
  GENERATE_BUCKET_META,
  type GenerateBucketKey,
  type GenerateCasesConfig,
  loadGenerateConfig,
  MAX_BUCKET,
  MAX_TOTAL,
  MIN_BUCKET,
  saveGenerateConfig,
  totalCases,
} from "@/lib/evals/eval-generation-config";

interface GenerateCasesConfigPopoverProps {
  suiteId: string;
  /** Triggers the parent's generate action (reads the persisted config). */
  onGenerate: () => void;
  disabled?: boolean;
  isGenerating?: boolean;
  disabledReason?: string;
}

/**
 * Chevron half of the "Generate" split button. Opens a config popover with
 * per-bucket case-count steppers, a live total, and a "Vary user styles"
 * toggle. The config is persisted per suite (localStorage) so the one-click
 * Generate respects the last-used settings. Progressive disclosure: nothing
 * here is required to generate — the plain Generate button uses the same
 * persisted config.
 */
export function GenerateCasesConfigPopover({
  suiteId,
  onGenerate,
  disabled = false,
  isGenerating = false,
  disabledReason,
}: GenerateCasesConfigPopoverProps) {
  const [open, setOpen] = useState(false);
  const [config, setConfig] = useState<GenerateCasesConfig>(
    DEFAULT_GENERATE_CONFIG
  );

  // Seed from persisted config whenever the popover opens or the suite changes.
  useEffect(() => {
    if (open) setConfig(loadGenerateConfig(suiteId));
  }, [open, suiteId]);

  const total = totalCases(config);

  const persist = (next: GenerateCasesConfig) => {
    setConfig(next);
    saveGenerateConfig(suiteId, next);
  };

  const adjustBucket = (key: GenerateBucketKey, delta: number) => {
    const nextValue = Math.max(
      MIN_BUCKET,
      Math.min(MAX_BUCKET, config[key] + delta)
    );
    if (nextValue === config[key]) return;
    if (delta > 0 && total >= MAX_TOTAL) return;
    persist({ ...config, [key]: nextValue });
  };

  const handleGenerateClick = () => {
    saveGenerateConfig(suiteId, config);
    setOpen(false);
    onGenerate();
  };

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button
          type="button"
          variant="outline"
          size="sm"
          className="h-8 w-7 rounded-l-none border-l-0 px-0"
          disabled={disabled || isGenerating}
          aria-label="Generation options"
        >
          <ChevronDown className="h-3.5 w-3.5 shrink-0" aria-hidden />
        </Button>
      </PopoverTrigger>
      <PopoverContent align="end" className="w-72 p-3">
        <div className="space-y-3">
          <div>
            <p className="text-xs font-medium">Generate cases</p>
            <p className="text-[11px] text-muted-foreground">
              Choose how many of each kind to create.
            </p>
          </div>

          <div className="space-y-1.5">
            {GENERATE_BUCKET_KEYS.map((key) => (
              <div
                key={key}
                className="flex items-center justify-between gap-2"
              >
                <div className="min-w-0">
                  <span className="text-xs">
                    {GENERATE_BUCKET_META[key].label}
                  </span>
                  <span className="ml-1.5 text-[11px] text-muted-foreground">
                    {GENERATE_BUCKET_META[key].hint}
                  </span>
                </div>
                <div className="flex shrink-0 items-center gap-1">
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    className="h-6 w-6 px-0"
                    aria-label={`Fewer ${GENERATE_BUCKET_META[key].label} cases`}
                    disabled={config[key] <= MIN_BUCKET}
                    onClick={() => adjustBucket(key, -1)}
                  >
                    <Minus className="h-3 w-3" aria-hidden />
                  </Button>
                  <span className="w-5 text-center text-xs tabular-nums">
                    {config[key]}
                  </span>
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    className="h-6 w-6 px-0"
                    aria-label={`More ${GENERATE_BUCKET_META[key].label} cases`}
                    disabled={config[key] >= MAX_BUCKET || total >= MAX_TOTAL}
                    onClick={() => adjustBucket(key, 1)}
                  >
                    <Plus className="h-3 w-3" aria-hidden />
                  </Button>
                </div>
              </div>
            ))}
          </div>

          <div className="flex items-center justify-between border-t border-border/40 pt-2">
            <span className="text-[11px] text-muted-foreground">Total</span>
            <span className="text-xs font-medium tabular-nums">
              {total} {total === 1 ? "case" : "cases"}
            </span>
          </div>

          <label className="flex cursor-pointer items-start justify-between gap-3 border-t border-border/40 pt-2">
            <span className="min-w-0">
              <span className="text-xs">Vary user styles</span>
              <span className="block text-[11px] text-muted-foreground">
                More realistic, varied phrasing
              </span>
            </span>
            <Switch
              checked={config.varyUserStyles}
              onCheckedChange={(checked) =>
                persist({ ...config, varyUserStyles: checked })
              }
              aria-label="Vary user styles"
            />
          </label>

          <Button
            type="button"
            size="sm"
            className="h-8 w-full gap-1.5"
            disabled={disabled || isGenerating || total < 1}
            aria-busy={isGenerating}
            onClick={handleGenerateClick}
          >
            {isGenerating ? (
              <Loader2
                className="h-3.5 w-3.5 shrink-0 animate-spin"
                aria-hidden
              />
            ) : (
              <Sparkles className="h-3.5 w-3.5 shrink-0" aria-hidden />
            )}
            Generate {total} {total === 1 ? "case" : "cases"}
          </Button>
          {disabled && disabledReason ? (
            <p className="text-[11px] text-muted-foreground">
              {disabledReason}
            </p>
          ) : null}
        </div>
      </PopoverContent>
    </Popover>
  );
}
