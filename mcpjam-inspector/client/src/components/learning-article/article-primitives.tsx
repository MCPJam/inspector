import type { ReactNode } from "react";

// ---------------------------------------------------------------------------
// Neutral aside — replaces AnalogyCallout, KeyDetails, Tip
// ---------------------------------------------------------------------------

export function Aside({ children }: { children: ReactNode }) {
  return (
    <div className="border-l-2 border-border pl-4 my-5">
      <div className="text-[13px] text-foreground/80 leading-relaxed">
        {children}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Section wrapper
// ---------------------------------------------------------------------------

export function Section({
  step,
  title,
  children,
}: {
  step: number;
  title: string;
  children: ReactNode;
}) {
  return (
    <section className="relative py-12 first:pt-6">
      <div className="space-y-5">
        <div className="flex items-center gap-2">
          <span className="text-[10px] text-muted-foreground font-mono">
            Section {step}
          </span>
        </div>

        <h2 className="text-xl font-semibold tracking-tight text-foreground -mt-1">
          {title}
        </h2>

        {children}
      </div>

      {/* Section divider */}
      <div className="mt-12 border-b border-border/30" />
    </section>
  );
}

// ---------------------------------------------------------------------------
// Article hero & outro
// ---------------------------------------------------------------------------

export function ArticleHero({
  title,
  subtitle,
}: {
  title: string;
  subtitle: string;
}) {
  return (
    <div className="pt-8 pb-4">
      <div className="space-y-3">
        <h1 className="text-2xl font-bold tracking-tight text-foreground">
          {title}
        </h1>
        <p className="text-sm text-muted-foreground leading-relaxed">
          {subtitle}
        </p>
      </div>
    </div>
  );
}

export function ArticleOutro({ children }: { children: ReactNode }) {
  return (
    <div className="pt-4 pb-8 text-center">
      <p className="text-sm text-muted-foreground/60">{children}</p>
    </div>
  );
}
