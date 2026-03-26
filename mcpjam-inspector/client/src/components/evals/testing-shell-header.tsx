import { BookOpen } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import type { TestingSurface } from "@/lib/testing-surface";
import { TestingSurfaceNav } from "./testing-surface-nav";

interface TestingShellHeaderProps {
  surfaceTitle: string;
  subtitle?: string;
  surface: TestingSurface;
  onSurfaceChange: (surface: TestingSurface) => void;
}

export function TestingShellHeader({
  surfaceTitle,
  subtitle,
  surface,
  onSurfaceChange,
}: TestingShellHeaderProps) {
  return (
    <div className="shrink-0 border-b border-border/60 bg-background/95 px-4 py-3 backdrop-blur sm:px-6">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between sm:gap-4">
        <div className="min-w-0 flex flex-col gap-0.5">
          <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
            <p className="text-xs font-medium uppercase tracking-[0.18em] text-primary/80">
              Testing
            </p>
            <Dialog>
              <DialogTrigger asChild>
                <button
                  type="button"
                  className="inline-flex items-center gap-1 text-xs text-muted-foreground underline-offset-4 hover:text-foreground hover:underline"
                >
                  <BookOpen className="h-3 w-3 shrink-0 opacity-70" />
                  What are Cases / Suites / Runs?
                </button>
              </DialogTrigger>
              <DialogContent className="sm:max-w-lg">
                <DialogHeader>
                  <DialogTitle className="text-base">Testing glossary</DialogTitle>
                </DialogHeader>
                <div className="grid gap-3 text-sm text-muted-foreground">
                  <p>
                    <span className="font-medium text-foreground">Case</span>: one
                    runnable scenario.
                  </p>
                  <p>
                    <span className="font-medium text-foreground">Suite</span>: saved
                    cases you want to keep proving.
                  </p>
                  <p>
                    <span className="font-medium text-foreground">Run</span>: one
                    execution of a suite.
                  </p>
                  <p>
                    <span className="font-medium text-foreground">Replay</span>:
                    inspect what changed and how to fix it.
                  </p>
                </div>
              </DialogContent>
            </Dialog>
          </div>
          <h1 className="text-lg font-semibold tracking-tight sm:text-xl">
            {surfaceTitle}
          </h1>
          {subtitle ? (
            <p className="max-w-2xl text-xs text-muted-foreground sm:text-sm">
              {subtitle}
            </p>
          ) : null}
        </div>
        <TestingSurfaceNav value={surface} onChange={onSurfaceChange} />
      </div>
    </div>
  );
}
