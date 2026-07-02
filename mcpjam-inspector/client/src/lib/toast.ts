import { toast as sonnerToast } from "sonner";

/**
 * App-wide toast.
 *
 * Identical to Sonner's `toast`, except error toasts persist until the user
 * dismisses them (the global `<Toaster>` enables a close button) instead of
 * auto-dismissing on Sonner's ~4s default. Errors are the one toast type users
 * must read and usually act on, so they shouldn't vanish on a timer the way
 * success/info toasts do.
 *
 * Callers can still override the duration per-call by passing `duration`
 * explicitly in the options.
 *
 * Import `toast` from here rather than from "sonner" directly so error toasts
 * stay consistent across the app.
 */
const error: typeof sonnerToast.error = (message, data) =>
  sonnerToast.error(message, { duration: Infinity, ...data });

export const toast: typeof sonnerToast = Object.assign(
  (...args: Parameters<typeof sonnerToast>) => sonnerToast(...args),
  sonnerToast,
  { error }
);
