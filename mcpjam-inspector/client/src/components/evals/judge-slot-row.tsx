/**
 * One judge on the suite settings page's Judge section: its name and status
 * lines on the left, its settings on the right. The same two columns as the
 * evaluator stages above it, so the section reads as part of one page.
 */
export function JudgeSlotRow({
  name,
  meta,
  children,
  ...rest
}: {
  name: string;
  /** Short status lines under the name (template, calibration). */
  meta?: React.ReactNode;
  children: React.ReactNode;
} & Omit<React.HTMLAttributes<HTMLElement>, "children">) {
  return (
    <section
      className="grid grid-cols-1 gap-x-6 gap-y-3 sm:grid-cols-[minmax(10rem,1fr)_2fr]"
      {...rest}
    >
      <div>
        <h4 className="font-medium text-foreground">{name}</h4>
        {meta ? <div className="mt-1 space-y-0.5">{meta}</div> : null}
      </div>
      <div className="min-w-0 space-y-4">{children}</div>
    </section>
  );
}
