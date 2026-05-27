/**
 * copyToClipboard
 *
 * Copies `text` to the clipboard in a way that works in both secure contexts
 * (HTTPS / localhost) and plain HTTP deployments.
 *
 * Strategy:
 *   1. Try the modern Clipboard API (`navigator.clipboard.writeText`).
 *      This works in secure contexts (HTTPS / localhost).
 *   2. Fall back to the legacy `document.execCommand('copy')` approach using
 *      a temporary off-screen <textarea>.  This works in plain HTTP contexts
 *      where the Clipboard API is blocked by the browser.
 *
 * Returns `true` if the copy succeeded, `false` otherwise.
 */
export async function copyToClipboard(text: string): Promise<boolean> {
  // 1. Modern Clipboard API — available in secure contexts.
  if (
    typeof navigator !== 'undefined' &&
    navigator.clipboard &&
    typeof navigator.clipboard.writeText === 'function'
  ) {
    try {
      await navigator.clipboard.writeText(text);
      return true;
    } catch {
      // Fall through to the legacy approach below.
    }
  }

  // 2. Legacy execCommand fallback — works in plain HTTP contexts.
  try {
    const textarea = document.createElement('textarea');
    textarea.value = text;

    // Keep it out of the viewport so it doesn't cause a visual flash.
    textarea.style.position = 'fixed';
    textarea.style.top = '-9999px';
    textarea.style.left = '-9999px';
    textarea.style.opacity = '0';
    textarea.setAttribute('readonly', '');
    textarea.setAttribute('aria-hidden', 'true');

    document.body.appendChild(textarea);
    textarea.focus();
    textarea.select();

    const success = document.execCommand('copy');
    document.body.removeChild(textarea);
    return success;
  } catch {
    return false;
  }
}
