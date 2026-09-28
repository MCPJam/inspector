import { cn } from "@/lib/utils";
import type { HTMLAttributes, ReactNode } from "react";

/** Left gutter shared by the chain line and section titles. */
export const SUITE_SETTINGS_CHAIN_PADDING = "pl-10";

/**
 * Vertical spine for a settings tab — one continuous line linking every section
 * title below (Railway-style, without icons in the nodes).
 */
export function SuiteSettingsSectionChain({
  children,
  className,
}: {
  children: ReactNode;
  className?: string;
}) {
  return (
    <div className={cn("relative", SUITE_SETTINGS_CHAIN_PADDING, className)}>
      <div
        aria-hidden
        className="pointer-events-none absolute bottom-6 left-[0.9375rem] top-[calc(0.625rem+0.3125rem)] w-px bg-border"
      />
      <div className="flex flex-col">{children}</div>
    </div>
  );
}

/** Dot on the spine, aligned with the section title. */
export function SuiteSettingsChainNode({ className }: { className?: string }) {
  return (
    <div
      aria-hidden
      className={cn(
        "absolute top-2.5 size-2.5 rounded-full border-2 border-border bg-background",
        "left-[calc(-2.5rem+0.9375rem-0.3125rem)]",
        className,
      )}
    />
  );
}

export function suiteSettingsChainSectionClass(className?: string) {
  return cn("relative scroll-mt-6 pb-10 last:pb-2", className);
}

/** Section shell with a chain node beside the title column. */
export function SuiteSettingsChainSection({
  children,
  className,
  ...rest
}: HTMLAttributes<HTMLElement>) {
  return (
    <section
      className={suiteSettingsChainSectionClass(className)}
      {...rest}
    >
      <SuiteSettingsChainNode />
      {children}
    </section>
  );
}
