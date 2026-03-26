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
      size="default"
      className="w-full sm:w-auto"
      options={[
        {
          value: "explore",
          label: "Explore",
          icon: <Sparkles className="h-4 w-4" />,
        },
        {
          value: "suites",
          label: "Suites",
          icon: <Layers3 className="h-4 w-4" />,
        },
        {
          value: "runs",
          label: "Runs",
          icon: <GitBranch className="h-4 w-4" />,
        },
      ]}
    />
  );
}
