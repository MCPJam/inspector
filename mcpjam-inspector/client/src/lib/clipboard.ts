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
    try {
      const textarea = document.createElement("textarea");
      textarea.value = text;
      textarea.style.position = "fixed";
      textarea.style.opacity = "0";
      document.body.appendChild(textarea);
      textarea.select();
      document.execCommand("copy");
      document.body.removeChild(textarea);
      console.warn(
        "Clipboard API unavailable, used deprecated execCommand fallback",
      );
      return true;
    } catch {
      console.warn(
        "Clipboard copy failed: both modern and fallback methods failed",
      );
      return false;
    }
  }
}
