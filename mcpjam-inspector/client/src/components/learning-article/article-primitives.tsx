import type { ReactNode } from "react";
import { Lightbulb, Info, Zap } from "lucide-react";
import { motion } from "framer-motion";

// ---------------------------------------------------------------------------
// Animation helpers
// ---------------------------------------------------------------------------

export const EASE = [0.25, 0.1, 0.25, 1] as const;

export function sectionChild(order: number) {
  return {
    initial: { opacity: 0, y: 16 } as const,
    whileInView: { opacity: 1, y: 0 } as const,
    viewport: { once: true } as const,
    transition: {
      delay: order * 0.08,
      duration: 0.4,
      ease: EASE,
    },
  };
}

// ---------------------------------------------------------------------------
// Callout sub-components
// ---------------------------------------------------------------------------

export function AnalogyCallout({ children }: { children: ReactNode }) {
  return (
    <motion.div
      className="rounded-lg border border-indigo-200/50 dark:border-indigo-800/30 bg-indigo-50/40 dark:bg-indigo-950/10 p-4"
      {...sectionChild(3)}
    >
      <div className="flex items-center gap-2 mb-2">
        <Zap className="h-3.5 w-3.5 text-indigo-500/70" />
        <span className="text-[11px] font-semibold text-indigo-600 dark:text-indigo-400 uppercase tracking-wider">
          Analogy
        </span>
      </div>
      <p className="text-[13px] text-foreground/80 leading-relaxed">
        {children}
      </p>
    </motion.div>
  );
}

export function KeyDetails({ items }: { items: string[] }) {
  return (
    <motion.div
      className="rounded-lg border border-blue-200/50 dark:border-blue-800/30 bg-blue-50/40 dark:bg-blue-950/10 p-4"
      {...sectionChild(4)}
    >
      <div className="flex items-center gap-2 mb-2.5">
        <Info className="h-3.5 w-3.5 text-blue-500/70" />
        <span className="text-[11px] font-semibold text-blue-600 dark:text-blue-400 uppercase tracking-wider">
          Key details
        </span>
      </div>
      <ul className="space-y-2">
        {items.map((item, i) => (
          <li
            key={i}
            className="flex items-start gap-2 text-[13px] text-foreground/80 leading-relaxed"
          >
            <span className="mt-1.5 block h-1 w-1 rounded-full bg-blue-400/60 shrink-0" />
            {item}
          </li>
        ))}
      </ul>
    </motion.div>
  );
}

export function Tip({ children }: { children: ReactNode }) {
  return (
    <motion.div
      className="rounded-lg border border-amber-200/50 dark:border-amber-800/30 bg-amber-50/40 dark:bg-amber-950/10 p-4"
      {...sectionChild(6)}
    >
      <div className="flex items-center gap-2 mb-2">
        <Lightbulb className="h-3.5 w-3.5 text-amber-500/70" />
        <span className="text-[11px] font-semibold text-amber-600 dark:text-amber-400 uppercase tracking-wider">
          Tip
        </span>
      </div>
      <p className="text-[13px] text-foreground/80 leading-relaxed">
        {children}
      </p>
    </motion.div>
  );
}

// ---------------------------------------------------------------------------
// Section wrapper
// ---------------------------------------------------------------------------

export function Section({
  category,
  categoryColor,
  step,
  title,
  children,
}: {
  category: string;
  categoryColor: string;
  step: number;
  title: string;
  children: ReactNode;
}) {
  return (
    <motion.section
      className="relative py-12 first:pt-6"
      initial={{ opacity: 0, y: 30 }}
      whileInView={{ opacity: 1, y: 0 }}
      viewport={{ once: true, amount: 0.15 }}
      transition={{ duration: 0.5, ease: EASE }}
    >
      <div className="space-y-5">
        {/* Category badge + step number */}
        <motion.div className="flex items-center gap-2" {...sectionChild(0)}>
          <span
            className="block h-2 w-2 rounded-full"
            style={{ backgroundColor: categoryColor }}
          />
          <span
            className="text-[11px] font-semibold uppercase tracking-wider"
            style={{ color: categoryColor }}
          >
            {category}
          </span>
          <span className="text-[10px] text-muted-foreground/50 font-mono">
            Section {step}
          </span>
        </motion.div>

        {/* Title */}
        <motion.h2
          className="text-xl font-semibold tracking-tight text-foreground -mt-1"
          {...sectionChild(1)}
        >
          {title}
        </motion.h2>

        {children}
      </div>

      {/* Section divider */}
      <div className="mt-12 border-b border-border/30" />
    </motion.section>
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
      <motion.div
        initial={{ opacity: 0, y: 10 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.4, ease: EASE }}
        className="space-y-3"
      >
        <h1 className="text-2xl font-bold tracking-tight text-foreground">
          {title}
        </h1>
        <p className="text-sm text-muted-foreground leading-relaxed">
          {subtitle}
        </p>
      </motion.div>
    </div>
  );
}

export function ArticleOutro({ children }: { children: ReactNode }) {
  return (
    <motion.div
      className="pt-4 pb-8 text-center"
      initial={{ opacity: 0 }}
      whileInView={{ opacity: 1 }}
      viewport={{ once: true }}
      transition={{ duration: 0.5 }}
    >
      <p className="text-sm text-muted-foreground/60">{children}</p>
    </motion.div>
  );
}
