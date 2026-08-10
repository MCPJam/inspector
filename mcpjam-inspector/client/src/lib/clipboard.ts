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
      document.body.appendChild(textarea);
      textarea.select();
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
