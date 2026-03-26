import type { TestingSurface } from "@/lib/testing-surface";
import { TestingSurfaceNav } from "./testing-surface-nav";

interface TestingShellHeaderProps {
  surface: TestingSurface;
  onSurfaceChange: (surface: TestingSurface) => void;
}

export function TestingShellHeader({
  surface,
  onSurfaceChange,
}: TestingShellHeaderProps) {
  return (
    <div className="shrink-0 border-b border-border/60 bg-background/95 px-4 py-2 backdrop-blur sm:px-6">
      <div className="flex items-center gap-4">
        <TestingSurfaceNav value={surface} onChange={onSurfaceChange} />
      </div>
    </div>
  );
}
