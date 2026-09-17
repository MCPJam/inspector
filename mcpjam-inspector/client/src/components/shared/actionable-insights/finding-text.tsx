/**
 * Recorded or model-written text, with the only two marks either producer is
 * allowed to emit.
 *
 * Backticks are how both halves of the insight surface name a tool, a field
 * path or an argument — the run page's findings and the iteration scorecard's
 * stage lines alike — so they render through ONE component. A second copy is
 * how one surface ends up printing the marks a reader was meant to see
 * formatted.
 *
 * Never HTML, never a link: this text comes from a server's error message or a
 * model's prose, and neither is markup.
 */
export function FindingText({ text }: { text: string }) {
  return (
    <>
      {text.split(/(`[^`]+`|\*\*[^*]+\*\*)/g).map((part, i) =>
        part.startsWith("`") ? (
          <code
            key={i}
            className="rounded bg-muted px-1 font-code text-[0.85em]"
          >
            {part.slice(1, -1)}
          </code>
        ) : part.startsWith("**") ? (
          <strong key={i} className="font-semibold">
            {part.slice(2, -2)}
          </strong>
        ) : (
          part
        ),
      )}
    </>
  );
}
