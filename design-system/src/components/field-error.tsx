import * as React from "react";

import { cn } from "../cn";

/**
 * The validation message that sits under a form control.
 *
 * This exists because there was no component for it: each message under a
 * field is written by hand, so whether it carries `role="alert"` depends on the
 * author remembering. How many existing field messages lack it has not been
 * measured.
 *
 * So the point of this component is that `role="alert"` is not optional and not
 * something a caller has to think about. Everything else it does is
 * incidental.
 *
 * It is NOT the same job as `Alert` (a notice the product writes, where nothing
 * failed) or the app's ErrorCard (a failure with a cause and a next step). This is specifically the reader's own input being wrong or
 * missing, rendered beside the control they are looking at.
 *
 * Wiring it to its input, which is the half no component can do for you:
 *
 * ```tsx
 * <Label htmlFor="url" className={error ? "text-destructive" : undefined}>
 *   Server URL
 * </Label>
 * <Input
 *   id="url"
 *   aria-invalid={Boolean(error)}
 *   aria-describedby={error ? "url-error" : undefined}
 * />
 * <FieldError id="url-error">{error}</FieldError>
 * ```
 *
 * `aria-describedby` is what ties the message to the input for a screen reader
 * moving through the form later; `role="alert"` only covers the moment it
 * appears. Both matter, and they are not substitutes.
 */
function FieldError({
  className,
  children,
  ...props
}: React.ComponentProps<"p">) {
  /**
   * Render nothing rather than an empty red paragraph.
   *
   * Callers overwhelmingly hold the message in a nullable variable and write
   * `{error && <FieldError>{error}</FieldError>}`. Returning null here means the
   * plain `<FieldError>{error}</FieldError>` also behaves, and — more
   * importantly — an empty live region never announces a blank string.
   *
   * Deliberately `== null` and `=== ""`, not a general falsy check: `0` is a
   * legitimate message body and should render.
   */
  if (children == null || children === "" || children === false) {
    return null;
  }

  return (
    <p
      data-slot="field-error"
      className={cn("text-destructive text-sm", className)}
      {...props}
      // AFTER the spread on purpose: announced the moment it appears, without
      // the reader having to go and find it. This is the whole reason the
      // component exists, so a caller cannot switch it off by passing `role`.
      role="alert"
    >
      {children}
    </p>
  );
}

export { FieldError };
