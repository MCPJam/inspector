import { Toaster as Sonner, type ToasterProps } from "sonner";
import type { CSSProperties } from "react";

export function Toaster(props: ToasterProps) {
  return (
    <Sonner
      closeButton={true}
      style={
        {
          "--normal-bg": "var(--popover)",
          "--normal-text": "var(--popover-foreground)",
          "--normal-border": "var(--border)",
        } as CSSProperties
      }
      {...props}
    />
  );
}
