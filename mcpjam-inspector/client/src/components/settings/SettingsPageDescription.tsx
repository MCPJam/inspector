import type { ReactNode } from "react";

export function SettingsPageDescription({ children }: { children: ReactNode }) {
  return (
    <p className="mt-1 text-sm font-normal leading-6 text-foreground">
      {children}
    </p>
  );
}
