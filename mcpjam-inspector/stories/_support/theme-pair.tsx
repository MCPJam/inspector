import type { ReactNode } from "react";
import { cn } from "@mcpjam/design-system/cn";

/**
 * Renders a specimen twice, light and dark, side by side. Dark mode is a
 * `.dark` ancestor (see `.storybook/preview.tsx`), so the right pane only
 * needs the class. Stories that use this pin the toolbar theme to light,
 * because a `.dark` on `<html>` would turn the left pane dark too.
 *
 * Portalled content (a Radix popover) renders outside the panes and keeps the
 * toolbar theme, so pass a static specimen.
 */
export function ThemePair({
  children,
  className,
}: {
  children: ReactNode;
  className?: string;
}) {
  return (
    <div className="grid lg:grid-cols-2">
      {(["light", "dark"] as const).map((theme) => (
        <div
          key={theme}
          className={cn(
            theme === "dark" && "dark",
            "flex flex-col gap-3 bg-background p-6 text-foreground",
            className,
          )}
        >
          <p className="text-xs font-medium text-muted-foreground">
            {theme === "light" ? "Light" : "Dark"}
          </p>
          {children}
        </div>
      ))}
    </div>
  );
}
