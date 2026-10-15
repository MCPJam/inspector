import { toast } from "sonner";

export const CASE_SAVE_FAILURE_MESSAGE =
  "We couldn’t save this test. Check its settings and try again.";

/** A background launch owns its error toast after setup closes. */
export function refuseCaseSave(message: string, quiet: boolean): false {
  if (quiet) throw new Error(message);
  toast.error(message);
  return false;
}

export function refuseInvalidCaseSave(message: string, quiet: boolean): false {
  return refuseCaseSave(quiet ? CASE_SAVE_FAILURE_MESSAGE : message, quiet);
}
