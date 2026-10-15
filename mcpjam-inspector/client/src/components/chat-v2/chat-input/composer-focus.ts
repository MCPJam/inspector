/** Marks the chat composer's text box so a layout can hand focus back to it. */
export const CHAT_COMPOSER_INPUT_ATTRIBUTE = "data-chat-composer-input";

/**
 * Focuses the first chat composer under `root` that can take focus. False
 * when there is none: no composer, or it is hidden (a form card stands in for
 * it) or disabled.
 */
export function focusChatComposer(
  root: ParentNode | null | undefined,
): boolean {
  if (!root) return false;
  const inputs = root.querySelectorAll<HTMLTextAreaElement>(
    `textarea[${CHAT_COMPOSER_INPUT_ATTRIBUTE}]`,
  );
  for (const input of inputs) {
    if (input.disabled || input.closest("[hidden]")) continue;
    input.focus();
    if (input.ownerDocument.activeElement === input) return true;
  }
  return false;
}
