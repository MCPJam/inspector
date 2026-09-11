/**
 * A Radix dialog traps focus, so a scratch textarea parked on <body> gets
 * refocused away before the copy runs. Keep it inside the open dialog.
 */
function fallbackCopyHost(): Element {
  return (
    document.activeElement?.closest('[role="dialog"],[role="alertdialog"]') ??
    document.body
  );
}

/**
 * Copy text to clipboard with fallback for older browsers.
 * Returns true if copy succeeded, false otherwise.
 */
export async function copyToClipboard(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    // Fallback for older browsers or permission denied
    const textarea = document.createElement("textarea");
    try {
      textarea.value = text;
      textarea.style.position = "fixed";
      textarea.style.opacity = "0";
      fallbackCopyHost().appendChild(textarea);
      textarea.select();
      // execCommand("copy") reports success even when the selection never took
      // and nothing reached the clipboard, so the selection is what has to be
      // checked. Measured against the textarea's own value, which normalizes
      // CRLF to LF and so is shorter than `text` for multi-line Windows input.
      if (
        textarea.selectionStart !== 0 ||
        textarea.selectionEnd !== textarea.value.length
      ) {
        console.warn(
          "Clipboard copy failed: fallback selection did not take, nothing was copied",
        );
        return false;
      }
      // execCommand REPORTS failure by returning false rather than throwing, so
      // the result has to be forwarded — swallowing it makes every caller show a
      // success toast for a copy that never happened.
      const copied = document.execCommand("copy");
      if (!copied) {
        console.warn(
          "Clipboard copy failed: execCommand fallback reported failure",
        );
        return false;
      }
      console.warn(
        "Clipboard API unavailable, used deprecated execCommand fallback",
      );
      return true;
    } catch {
      console.warn(
        "Clipboard copy failed: both modern and fallback methods failed",
      );
      return false;
    } finally {
      // In `finally`, not on the success path: the scratch textarea must not
      // outlive the attempt even when execCommand THROWS, or a fixed-position
      // invisible node is left in the document.
      textarea.remove();
    }
  }
}
