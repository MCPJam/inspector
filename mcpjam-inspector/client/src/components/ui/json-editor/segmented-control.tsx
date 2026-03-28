import { useRef, useEffect, useState } from "react";
import { cn } from "@/lib/utils";

interface SegmentedControlOption<T extends string> {
  value: T;
  label: string;
  icon?: React.ReactNode;
}

type SegmentedControlSize = "sm" | "default";

interface SegmentedControlProps<T extends string> {
  options: SegmentedControlOption<T>[];
  value: T;
  onChange: (value: T) => void;
  className?: string;
  size?: SegmentedControlSize;
}

export function SegmentedControl<T extends string>({
  options,
  value,
  onChange,
  className,
  size = "sm",
}: SegmentedControlProps<T>) {
  const containerRef = useRef<HTMLDivElement>(null);
  const [indicatorStyle, setIndicatorStyle] = useState<React.CSSProperties>({});

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    const selectedIndex = options.findIndex((opt) => opt.value === value);
    const buttons = container.querySelectorAll("button");
    const selectedButton = buttons[selectedIndex];

    if (selectedButton) {
      setIndicatorStyle({
        width: selectedButton.offsetWidth,
        transform: `translateX(${selectedButton.offsetLeft}px)`,
      });
    }
  }, [value, options, size]);

  return (
    <div
      ref={containerRef}
      className={cn(
        "relative inline-flex items-center rounded-md bg-muted/50",
        size === "default" ? "p-1" : "p-0.5",
        className,
      )}
    >
      {/* Sliding indicator */}
      <div
        className={cn(
          "absolute left-0 rounded-md bg-background shadow-sm",
          "transition-all duration-200 ease-out",
          size === "default"
            ? "top-1 h-[calc(100%-8px)]"
            : "top-0.5 h-[calc(100%-4px)]",
        )}
        style={indicatorStyle}
      />

      {/* Options */}
      {options.map((option) => (
        <button
          key={option.value}
          type="button"
          onClick={() => onChange(option.value)}
          className={cn(
            "relative z-10 flex items-center rounded-md font-medium transition-colors duration-200",
            size === "default"
              ? "gap-2 px-3.5 py-1.5 text-sm"
              : "gap-1.5 px-2.5 py-1 text-xs",
            value === option.value
              ? "text-foreground"
              : "text-muted-foreground hover:text-foreground/80",
          )}
        >
          {option.icon}
          {option.label}
        </button>
      ))}
    </div>
  );
}
