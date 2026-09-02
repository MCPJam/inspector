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
    () => "light" as const,
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
          // `grow` pushes the action to the trailing edge of the row. Together
          // with wrapping and sonner's own `flex-shrink: 0` on the button, the
          // label decides the layout: a short one ("Copy") rides the title
          // row, and a sentence-long CTA ("Change protocol version") no longer
          // fits beside the message and drops to its own line on its own.
          content: "max-h-[50vh] overflow-y-auto grow",
          ...props.toastOptions?.classNames,
        },
      }}
    />
  );
};

export { Toaster };
