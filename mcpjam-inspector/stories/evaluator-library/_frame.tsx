import type { ReactNode } from "react";

/** A labelled specimen, so each story shows states side by side. */
export function Specimen({
  label,
  children,
  width = 520,
}: {
  label: string;
  children: ReactNode;
  width?: number;
}) {
  return (
    <figure className="flex flex-col gap-2" style={{ width }}>
      <figcaption className="font-mono text-[11px] uppercase tracking-wide text-muted-foreground">
        {label}
      </figcaption>
      {children}
    </figure>
  );
}

export function Grid({ children }: { children: ReactNode }) {
  return <div className="flex flex-wrap items-start gap-8 p-2">{children}</div>;
}
