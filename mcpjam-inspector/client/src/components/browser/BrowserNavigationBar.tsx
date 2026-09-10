import { useEffect, useRef, type ReactNode } from "react";
import { ArrowLeft, ArrowRight, Play, RotateCw } from "lucide-react";
import { cn } from "@mcpjam/design-system/cn";
import { Button } from "@mcpjam/design-system/button";
import {
  addressFieldValue,
  type AddressFieldEvent,
  type AddressFieldState,
} from "@/lib/browser-shell/address-field";
import type { BrowserControlState } from "../../../../shared/browser-session-state";

/**
 * The second row: back, forward, reload, the address, and who is driving.
 *
 * TWO ROWS RATHER THAN THREE, and this one carries the ownership status and
 * "Resume agent" alongside the controls rather than in a bar of their own. The
 * page area is the point of the panel — a person opens it to watch a browser,
 * not to read chrome — and a third row costs 36 vertical pixels on every
 * screen forever to say something that is usually "the agent is driving".
 *
 * The status is a WORD, not a badge with a border and a background. It changes
 * rarely and it is not a control; giving it the visual weight of a button
 * makes it compete with the buttons beside it, and the thing that actually
 * needs to be noticed — that a person has taken over — is better said by the
 * Resume button appearing than by a chip changing colour.
 */

export interface BrowserNavigationBarProps {
  authority?: { kind: "shared" } | { kind: "lease" };
  address: AddressFieldState;
  onAddress: (event: AddressFieldEvent) => void;
  canGoBack: boolean;
  canGoForward: boolean;
  onBack: () => void;
  onForward: () => void;
  onReload: () => void;
  control: BrowserControlState;
  /** True when the lease is THIS pane's, so the shell may offer to hand back. */
  holding: boolean;
  /**
   * Hand the browser back and let the agent continue.
   *
   * Absent when there is nothing to resume — nobody is holding it, or this
   * pane is not the holder.
   */
  onResumeAgent?: (() => void) | undefined;
  /** Is a resume in flight? The button says so rather than doing nothing. */
  resuming?: boolean;
  /** Engine-specific trailing controls: the quality menu, the stats toggle. */
  trailing?: ReactNode;
  disabled?: boolean;
}

export function BrowserNavigationBar({
  address,
  authority = { kind: "lease" },
  onAddress,
  canGoBack,
  canGoForward,
  onBack,
  onForward,
  onReload,
  control,
  holding,
  onResumeAgent,
  resuming = false,
  trailing,
  disabled = false,
}: BrowserNavigationBarProps) {
  const inputRef = useRef<HTMLInputElement | null>(null);
  const value = addressFieldValue(address);

  // Focusing reveals the whole URL, which means the text under the caret
  // changes at the moment of focus. Selecting all of it is what every browser
  // does and what makes "focus, type a new address" work — without it the
  // caret lands somewhere inside a URL that just appeared and typing edits it.
  useEffect(() => {
    if (!address.focused) return;
    if (address.draft !== null) return;
    inputRef.current?.select();
  }, [address.focused, address.draft]);

  return (
    <div
      data-testid="browser-nav-bar"
      className="flex shrink-0 items-center gap-1 px-2 pb-1.5 pt-1"
    >
      <NavButton
        icon={ArrowLeft}
        label="Back"
        onClick={onBack}
        disabled={disabled || !canGoBack}
      />
      <NavButton
        icon={ArrowRight}
        label="Forward"
        onClick={onForward}
        disabled={disabled || !canGoForward}
      />
      <NavButton
        icon={RotateCw}
        label="Reload"
        onClick={onReload}
        disabled={disabled}
      />
      <input
        ref={inputRef}
        type="text"
        // NOT `type="url"`, deliberately. A url input's built-in validation
        // rejects `localhost:3000` and every other scheme-less form, which is
        // most of what anybody types into this particular browser.
        value={value}
        disabled={disabled}
        spellCheck={false}
        autoComplete="off"
        autoCorrect="off"
        autoCapitalize="off"
        aria-label="Address"
        placeholder="Search Google or enter a URL"
        data-testid="browser-address"
        onChange={(event) =>
          onAddress({ type: "edit", value: event.target.value })
        }
        onFocus={() => onAddress({ type: "focus" })}
        onBlur={() => onAddress({ type: "blur" })}
        onKeyDown={(event) => {
          if (event.key === "Enter") {
            event.preventDefault();
            onAddress({ type: "commit" });
            return;
          }
          if (event.key === "Escape") {
            event.preventDefault();
            // STOPPED here. The page also wants Escape — it closes dialogs —
            // and the pane's key handler forwards it, so letting this bubble
            // would cancel the edit AND dismiss whatever the page had open.
            event.stopPropagation();
            onAddress({ type: "cancel" });
            inputRef.current?.blur();
          }
        }}
        className={cn(
          "h-7 min-w-0 flex-1 rounded-md bg-muted/60 px-2.5 text-xs text-foreground transition-colors",
          "placeholder:text-muted-foreground",
          "focus:bg-background focus:outline-none focus:ring-2 focus:ring-ring",
          "disabled:opacity-60",
        )}
      />
      {authority.kind === "lease" ? (
        <span
          data-testid="browser-control-status"
          // ANNOUNCED. Losing the browser to somebody else changes what every
          // control on this bar does, and a person using a screen reader has no
          // picture to notice it in.
          role="status"
          aria-live="polite"
          className="shrink-0 whitespace-nowrap px-1 text-[11px] text-muted-foreground"
        >
          {controlSentence(control, holding)}
        </span>
      ) : null}
      {onResumeAgent ? (
        <Button
          size="sm"
          variant="outline"
          onClick={onResumeAgent}
          disabled={resuming}
          data-testid="browser-resume-agent"
          className="h-7 shrink-0 px-2 text-xs"
        >
          <Play className="mr-1 size-3" aria-hidden />
          {resuming ? "Resuming…" : "Resume agent"}
        </Button>
      ) : null}
      {trailing}
    </div>
  );
}

/**
 * Who is driving, in words a person can act on.
 *
 * "You" wins over the lease's own vocabulary when this pane is the holder: the
 * lease says `human`, and there is a real difference between "a human has this
 * browser" and "you have this browser" when two panes are open on one session.
 */
export function controlSentence(
  control: BrowserControlState,
  holding: boolean,
): string {
  if (holding) return control.parked ? "You have it (paused)" : "You have it";
  switch (control.kind) {
    case "human":
      return "Someone else is driving";
    case "script":
      return "A script is driving";
    default:
      return "The agent is driving";
  }
}

function NavButton({
  icon: Icon,
  label,
  onClick,
  disabled,
}: {
  icon: typeof ArrowLeft;
  label: string;
  onClick: () => void;
  disabled: boolean;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      aria-label={label}
      title={label}
      data-testid={`browser-${label.toLowerCase()}`}
      className={cn(
        "flex size-7 shrink-0 items-center justify-center rounded-md text-muted-foreground transition-colors",
        "hover:bg-accent hover:text-accent-foreground",
        "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
        // `pointer-events-none` as well as `disabled`, so a disabled Back does
        // not swallow a hover that would otherwise reach the strip behind it.
        "disabled:pointer-events-none disabled:opacity-40",
      )}
    >
      <Icon className="size-3.5" aria-hidden />
    </button>
  );
}
