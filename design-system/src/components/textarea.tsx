import * as React from "react";

import { cn } from "../cn";

function Textarea({ className, ...props }: React.ComponentProps<"textarea">) {
  return (
    <textarea
      data-slot="textarea"
      className={cn(
        // wrap-anywhere caps the field-sizing-content min-content width: without
        // it a long unbroken value widens the textarea past its container and
        // drags every w-full sibling in the dialog along with it.
        "border-input placeholder:text-muted-foreground focus-visible:border-ring focus-visible:ring-ring/30 aria-invalid:ring-destructive/20 dark:aria-invalid:ring-destructive/40 aria-invalid:border-destructive dark:bg-input/30 flex field-sizing-content min-h-16 w-full min-w-0 rounded-md border bg-transparent px-3 py-2 text-base wrap-anywhere shadow-xs transition-[color,box-shadow] outline-none focus-visible:ring-2 disabled:cursor-not-allowed disabled:opacity-50 md:text-sm",
        className,
      )}
      {...props}
    />
  );
}

export { Textarea };
