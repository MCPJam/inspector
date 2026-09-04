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
          // `items-start` because a multi-line error is the common case here:
          // sonner centres its row, which floats the icon and the action
          // against the middle of a paragraph instead of its first line.
          // `flex-wrap` lets an action take a line of its own.
          toast: "group/toast flex-wrap items-start",
          // `basis-0 grow` so the message never forces its own line: at its
          // natural width a paragraph does not fit beside the icon, and the
          // row wraps leaving the icon stranded alone above it. `min-w-40`
          // then decides the action's placement — with sonner's own
          // `flex-shrink: 0` on the button, a short label ("Copy") rides the
          // title row at the trailing edge, and a sentence-long CTA ("Change
          // protocol version") no longer fits beside a 10rem message and drops
          // to its own line.
          content: "max-h-[50vh] min-w-40 grow basis-0 overflow-y-auto",
          ...props.toastOptions?.classNames,
        },
      }}
    />
  );
};

export { Toaster };
