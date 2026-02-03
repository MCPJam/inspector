import { useRef, useEffect, useState } from "react";
import { cn } from "@/lib/utils";

interface SegmentedControlOption<T extends string> {
  value: T;
  label: string;
  icon?: React.ReactNode;
}

interface SegmentedControlProps<T extends string> {
  options: SegmentedControlOption<T>[];
  value: T;
  onChange: (value: T) => void;
  className?: string;
}

export function SegmentedControl<T extends string>({
  options,
  value,
  onChange,
  className,
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
  }, [value, options]);

  return (
    <div
      ref={containerRef}
      className={cn(
        "relative inline-flex items-center rounded-md bg-muted/50 p-0.5",
        className,
      )}
    >
      {/* Sliding indicator */}
      <div
        className={cn(
          "absolute top-0.5 left-0 h-[calc(100%-4px)] rounded-md",
          "bg-background shadow-sm",
          "transition-all duration-200 ease-out",
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
            "relative z-10 flex items-center gap-1.5 px-2.5 py-1",
            "text-xs font-medium rounded-md",
            "transition-colors duration-200",
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
