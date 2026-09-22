/**
 * The marker that makes a required field LOOK required, for forms whose Save is
 * already gated on the field being filled. A gate nobody can see reads as a
 * bug — "I can create a scenario without an environment" was reported against a
 * screen that already refused to, because the only sign was an inert button.
 *
 * The glyph is decorative: assistive tech gets the word, and the control itself
 * still has to carry `aria-required` — this marks the LABEL, it does not
 * annotate the input.
 *
 * Primary, not destructive: every Production Redesign frame draws the marker in
 * the brand colour, and red on a field nobody has touched yet reads as an error
 * that already happened.
 */
export function RequiredMark() {
  return (
    <>
      <span aria-hidden="true" className="font-medium text-primary">
        *
      </span>
      <span className="sr-only">(required)</span>
    </>
  );
}
