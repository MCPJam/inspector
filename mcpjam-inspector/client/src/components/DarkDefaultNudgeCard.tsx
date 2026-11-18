import { ArrowRight, Moon, Sun, X } from "lucide-react";
import { Button } from "@mcpjam/design-system/button";
import {
  Card,
  CardDescription,
  CardFooter,
  CardHeader,
  CardTitle,
} from "@mcpjam/design-system/card";
import { ThemePreview } from "./settings/ThemePreview";

type DarkDefaultNudgeCardProps = {
  onOpenSettings: () => void;
  onDismiss: () => void;
};

/**
 * The toast body for the dark default nudge: a light-to-dark picture on top,
 * the message and actions below. Rendered through `toast.custom`, so it brings
 * its own surface instead of sonner's default row.
 */
export function DarkDefaultNudgeCard({
  onOpenSettings,
  onDismiss,
}: DarkDefaultNudgeCardProps) {
  return (
    <Card className="relative w-[356px] gap-0 overflow-hidden py-0 shadow-lg">
      <div className="relative border-b border-border bg-muted/40 p-3">
        <ThemePreview mode="system" />
        <div
          aria-hidden="true"
          className="pointer-events-none absolute inset-0 flex items-center justify-center gap-3"
        >
          <span className="theme-preview-light flex size-10 items-center justify-center rounded-full border border-border bg-background text-foreground shadow-sm">
            <Sun className="size-5" />
          </span>
          <span className="flex size-6 items-center justify-center rounded-full bg-primary text-primary-foreground shadow-sm">
            <ArrowRight className="size-3.5" />
          </span>
          <span className="dark flex size-10 items-center justify-center rounded-full border border-border bg-background text-foreground shadow-sm ring-2 ring-primary">
            <Moon className="size-5" />
          </span>
        </div>
      </div>
      <button
        type="button"
        aria-label="Dismiss"
        onClick={onDismiss}
        className="absolute right-2 top-2 flex size-6 items-center justify-center rounded-full bg-background/80 text-muted-foreground hover:text-foreground"
      >
        <X className="size-3.5" />
      </button>
      <CardHeader className="gap-1 px-4 pt-4">
        <CardTitle className="text-sm">Dark mode is now the default.</CardTitle>
        <CardDescription className="text-sm">
          You can switch to light or System in Settings.
        </CardDescription>
      </CardHeader>
      <CardFooter className="justify-end gap-2 px-4 pb-4 pt-3">
        <Button variant="ghost" size="sm" onClick={onOpenSettings}>
          Open Settings
        </Button>
        <Button size="sm" onClick={onDismiss}>
          Keep dark
        </Button>
      </CardFooter>
    </Card>
  );
}
