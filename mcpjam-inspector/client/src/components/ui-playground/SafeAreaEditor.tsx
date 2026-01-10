import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import { RectangleHorizontal } from "lucide-react";
import {
  useUIPlaygroundStore,
  SAFE_AREA_PRESETS,
  type SafeAreaInsets,
  type SafeAreaPreset,
} from "@/stores/ui-playground-store";
import { cn } from "@/lib/utils";

/** Preset buttons for common device safe areas */
const PRESET_OPTIONS: {
  preset: SafeAreaPreset;
  label: string;
  shortLabel: string;
}[] = [
  { preset: "none", label: "None", shortLabel: "None" },
  { preset: "iphone-notch", label: "iPhone Notch", shortLabel: "Notch" },
  {
    preset: "iphone-dynamic-island",
    label: "Dynamic Island",
    shortLabel: "Island",
  },
  { preset: "android-gesture", label: "Android", shortLabel: "Android" },
];

/** Safe Area Visualization - shows the insets visually */
function SafeAreaVisualization({ insets }: { insets: SafeAreaInsets }) {
  const hasAnyInset =
    insets.top > 0 || insets.bottom > 0 || insets.left > 0 || insets.right > 0;

  return (
    <div className="relative w-full h-[140px] rounded-lg border-2 border-dashed border-border overflow-hidden bg-muted/30">
      {/* Top inset */}
      {insets.top > 0 && (
        <div
          className="absolute top-0 left-0 right-0 bg-destructive/20 border-b border-dashed border-destructive/40 flex items-center justify-center"
          style={{ height: `${Math.min(insets.top * 0.8, 40)}px` }}
        >
          <span className="text-[9px] text-muted-foreground font-medium">
            {insets.top}px
          </span>
        </div>
      )}

      {/* Bottom inset */}
      {insets.bottom > 0 && (
        <div
          className="absolute bottom-0 left-0 right-0 bg-destructive/20 border-t border-dashed border-destructive/40 flex items-center justify-center"
          style={{ height: `${Math.min(insets.bottom * 0.8, 40)}px` }}
        >
          <span className="text-[9px] text-muted-foreground font-medium">
            {insets.bottom}px
          </span>
        </div>
      )}

      {/* Left inset */}
      {insets.left > 0 && (
        <div
          className="absolute left-0 bg-destructive/20 border-r border-dashed border-destructive/40 flex items-center justify-center"
          style={{
            width: `${Math.min(insets.left * 0.8, 30)}px`,
            top: `${Math.min(insets.top * 0.8, 40)}px`,
            bottom: `${Math.min(insets.bottom * 0.8, 40)}px`,
          }}
        >
          <span className="text-[9px] text-muted-foreground font-medium writing-mode-vertical">
            {insets.left}
          </span>
        </div>
      )}

      {/* Right inset */}
      {insets.right > 0 && (
        <div
          className="absolute right-0 bg-destructive/20 border-l border-dashed border-destructive/40 flex items-center justify-center"
          style={{
            width: `${Math.min(insets.right * 0.8, 30)}px`,
            top: `${Math.min(insets.top * 0.8, 40)}px`,
            bottom: `${Math.min(insets.bottom * 0.8, 40)}px`,
          }}
        >
          <span className="text-[9px] text-muted-foreground font-medium writing-mode-vertical">
            {insets.right}
          </span>
        </div>
      )}

      {/* Safe content area */}
      <div
        className="absolute bg-green-500/10 border border-dashed border-green-500/40 flex items-center justify-center"
        style={{
          top: `${Math.min(insets.top * 0.8, 40)}px`,
          bottom: `${Math.min(insets.bottom * 0.8, 40)}px`,
          left: `${Math.min(insets.left * 0.8, 30)}px`,
          right: `${Math.min(insets.right * 0.8, 30)}px`,
        }}
      >
        <span className="text-[10px] text-muted-foreground">
          {hasAnyInset ? "Safe Content Area" : "No Insets"}
        </span>
      </div>
    </div>
  );
}

/** Input field for a single inset value */
function InsetInput({
  label,
  value,
  onChange,
}: {
  label: string;
  value: number;
  onChange: (value: number) => void;
}) {
  return (
    <div className="flex flex-col items-center gap-1">
      <span className="text-[10px] text-muted-foreground uppercase tracking-wide">
        {label}
      </span>
      <div className="relative">
        <Input
          type="number"
          min={0}
          max={100}
          value={value}
          onChange={(e) => onChange(Math.max(0, parseInt(e.target.value) || 0))}
          className="w-16 h-7 text-xs text-center pr-5 [appearance:textfield] [&::-webkit-outer-spin-button]:appearance-none [&::-webkit-inner-spin-button]:appearance-none"
        />
        <span className="absolute right-2 top-1/2 -translate-y-1/2 text-[10px] text-muted-foreground">
          px
        </span>
      </div>
    </div>
  );
}

export function SafeAreaEditor() {
  const safeAreaPreset = useUIPlaygroundStore((s) => s.safeAreaPreset);
  const safeAreaInsets = useUIPlaygroundStore((s) => s.safeAreaInsets);
  const setSafeAreaPreset = useUIPlaygroundStore((s) => s.setSafeAreaPreset);
  const setSafeAreaInsets = useUIPlaygroundStore((s) => s.setSafeAreaInsets);

  const handleInsetChange = (key: keyof SafeAreaInsets, value: number) => {
    setSafeAreaInsets({ [key]: value });
  };

  const hasAnyInset =
    safeAreaInsets.top > 0 ||
    safeAreaInsets.bottom > 0 ||
    safeAreaInsets.left > 0 ||
    safeAreaInsets.right > 0;

  return (
    <Popover>
      <PopoverTrigger asChild>
        <Button
          variant={hasAnyInset ? "secondary" : "ghost"}
          size="icon"
          className="h-7 w-7"
        >
          <RectangleHorizontal className="h-3.5 w-3.5" />
        </Button>
      </PopoverTrigger>
      <PopoverContent className="w-[280px] p-3" align="start">
        <div className="space-y-3">
          {/* Header */}
          <div className="flex items-center justify-between">
            <span className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
              Safe Area
            </span>
            {safeAreaPreset !== "none" && safeAreaPreset !== "custom" && (
              <span className="text-[10px] text-muted-foreground">
                {PRESET_OPTIONS.find((p) => p.preset === safeAreaPreset)?.label}
              </span>
            )}
          </div>

          {/* Visualization */}
          <SafeAreaVisualization insets={safeAreaInsets} />

          {/* Preset buttons */}
          <div className="flex gap-1">
            {PRESET_OPTIONS.map((option) => (
              <Button
                key={option.preset}
                variant={
                  safeAreaPreset === option.preset ? "secondary" : "ghost"
                }
                size="sm"
                onClick={() => setSafeAreaPreset(option.preset)}
                className={cn(
                  "flex-1 h-6 text-[10px] px-1",
                  safeAreaPreset === option.preset && "ring-1 ring-ring",
                )}
              >
                {option.shortLabel}
              </Button>
            ))}
          </div>

          {/* Inset inputs */}
          <div className="grid grid-cols-4 gap-2">
            <InsetInput
              label="Top"
              value={safeAreaInsets.top}
              onChange={(v) => handleInsetChange("top", v)}
            />
            <InsetInput
              label="Bottom"
              value={safeAreaInsets.bottom}
              onChange={(v) => handleInsetChange("bottom", v)}
            />
            <InsetInput
              label="Left"
              value={safeAreaInsets.left}
              onChange={(v) => handleInsetChange("left", v)}
            />
            <InsetInput
              label="Right"
              value={safeAreaInsets.right}
              onChange={(v) => handleInsetChange("right", v)}
            />
          </div>
        </div>
      </PopoverContent>
    </Popover>
  );
}
