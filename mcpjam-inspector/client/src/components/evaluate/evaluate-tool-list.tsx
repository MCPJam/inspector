/**
 * Expected or observed tool names, with the misses called out in the observed
 * column rather than left for the reader to diff by eye.
 *
 * Shared by the case body and the grading peek so one miss reads the same
 * wherever it surfaces.
 */
export function EvaluateToolList({
  label,
  names,
  missing = [],
}: {
  label: string;
  names: string[];
  /** Expected calls with no observed counterpart. ALL of them, not the first. */
  missing?: readonly string[];
}) {
  return (
    <div className="min-w-0">
      <div className="text-[10.5px] font-medium uppercase tracking-wide text-muted-foreground">
        {label}
      </div>
      <ul className="mt-1.5 flex flex-col gap-1">
        {names.length === 0 && missing.length === 0 ? (
          <li className="text-[12.5px] text-muted-foreground">none recorded</li>
        ) : (
          names.map((name, index) => (
            // Keyed by position, because a case may legitimately call the same
            // tool twice and two list items cannot share a key.
            <li
              key={`${name}-${index}`}
              className="font-mono text-[12.5px] text-foreground"
            >
              {name}
            </li>
          ))
        )}
        {missing.map((name, index) => (
          <li
            key={`missing-${name}-${index}`}
            className="font-mono text-[12.5px] text-destructive"
          >
            {name}{" "}
            {/* A real space, not just the margin: this text is read aloud and
                copied, and "export_to_excalidrawnever called" is neither. */}
            <span className="font-sans text-[11.5px]">never called</span>
          </li>
        ))}
      </ul>
    </div>
  );
}
