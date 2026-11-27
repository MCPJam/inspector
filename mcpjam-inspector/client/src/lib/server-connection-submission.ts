import type { ServerFormData } from "@/shared/types";

export type ServerConnectionSubmissionOptions = {
  onAccepted?: () => void;
  onConfigSaved?: () => void;
  suppressErrorToast?: boolean;
  // Owner-worded reason for a refused save that the user can act on (a taken
  // name, a plan limit). Never a raw error.
  onRejected?: (reason: string) => void;
};

export type ServerConnectionSubmit = (
  data: ServerFormData,
  options?: ServerConnectionSubmissionOptions,
) => void | Promise<void>;

export function submitServerDraft(
  submit: ServerConnectionSubmit,
  data: ServerFormData,
  onRejected?: (reason: string) => void,
): Promise<boolean> {
  return new Promise((resolve) => {
    try {
      const operation = submit(data, {
        onAccepted: () => resolve(true),
        suppressErrorToast: true,
        onRejected,
      });
      void Promise.resolve(operation).then(
        () => resolve(false),
        () => resolve(false),
      );
    } catch {
      resolve(false);
    }
  });
}
