import type { ServerFormData } from "@/shared/types";

export type ServerConnectionSubmissionOptions = {
  onAccepted?: () => void;
  suppressErrorToast?: boolean;
};

export type ServerConnectionSubmit = (
  data: ServerFormData,
  options?: ServerConnectionSubmissionOptions,
) => void | Promise<void>;

export function submitServerDraft(
  submit: ServerConnectionSubmit,
  data: ServerFormData,
): Promise<boolean> {
  return new Promise((resolve) => {
    try {
      const operation = submit(data, {
        onAccepted: () => resolve(true),
        suppressErrorToast: true,
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
