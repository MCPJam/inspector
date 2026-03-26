import { GitBranch, Layers3, Sparkles } from "lucide-react";
import { SegmentedControl } from "@/components/ui/json-editor/segmented-control";
import type { TestingSurface } from "@/lib/testing-surface";

interface TestingSurfaceNavProps {
  value: TestingSurface;
  onChange: (surface: TestingSurface) => void;
}

export function TestingSurfaceNav({
  value,
  onChange,
}: TestingSurfaceNavProps) {
  return (
    <SegmentedControl
      value={value}
      onChange={onChange}
      className="w-full sm:w-auto"
      options={[
        {
          value: "explore",
          label: "Explore",
          icon: <Sparkles className="h-3.5 w-3.5" />,
        },
        {
          value: "suites",
          label: "Suites",
          icon: <Layers3 className="h-3.5 w-3.5" />,
        },
        {
          value: "runs",
          label: "Runs",
          icon: <GitBranch className="h-3.5 w-3.5" />,
        },
      ]}
    />
  );
}
