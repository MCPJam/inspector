import { useSyncExternalStore } from "react";
import { Toaster as Sonner, ToasterProps } from "sonner";

/**
 * The theme, read from the `.dark` class this design system scopes its own dark
 * tokens under (see tokens.css) — not from next-themes, which nothing in the app
 * provides. With no provider its `useTheme()` fell back to "system", so Sonner
 * resolved the OS setting instead: on a dark-mode machine viewing the light app
 * it stamped `data-sonner-theme="dark"` and coloured the description
 * `hsl(0 0% 91%)`, near-white on the white background our own vars supplied.
 */
function subscribeToDocumentTheme(onChange: () => void) {
  if (typeof MutationObserver === "undefined") return () => {};
  const observer = new MutationObserver(onChange);
  observer.observe(document.documentElement, {
    attributes: true,
    attributeFilter: ["class"],
  });
  return () => observer.disconnect();
}

function getDocumentTheme(): "dark" | "light" {
  return document.documentElement.classList.contains("dark") ? "dark" : "light";
}

const Toaster = ({ ...props }: ToasterProps) => {
  const theme = useSyncExternalStore(
    subscribeToDocumentTheme,
    getDocumentTheme,
    () => "light" as const
  );

  return (
    <Sonner
      theme={theme as ToasterProps["theme"]}
      className="toaster group"
      closeButton={true}
      style={
        {
          "--normal-bg": "var(--popover)",
          "--normal-text": "var(--popover-foreground)",
          "--normal-border": "var(--border)",
        } as React.CSSProperties
      }
      {...props}
      toastOptions={{
        ...props.toastOptions,
        classNames: {
          // `flex-wrap` so an action can take a line of its own instead of
          // squeezing the message into a narrow column beside it.
          toast: "group/toast flex-wrap",
          content: "max-h-[50vh] overflow-y-auto",
          // Error actions sit BELOW the text. Sonner's default puts the button
          // in the same row, which works for a short confirmation but not
          // here: an error toast's message is a sentence or two, and the row
          // layout squeezes it while leaving the one actionable control
          // competing with the close button in the corner. `basis-full` forces
          // its own line (the container wraps, above).
          //
          // Scoped to `data-type="error"` through the toast's own
          // `group/toast`, so short action toasts elsewhere keep the compact
          // inline button they were designed around.
          actionButton: [
            "group-data-[type=error]/toast:mt-2",
            "group-data-[type=error]/toast:ml-0",
            "group-data-[type=error]/toast:basis-full",
            "group-data-[type=error]/toast:justify-center",
          ].join(" "),
          ...props.toastOptions?.classNames,
        },
      }}
    />
  );
};

export { Toaster };
