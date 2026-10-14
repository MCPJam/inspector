import { toast } from "sonner";

/** A background launch owns its error toast after setup closes. */
export function refuseCaseSave(message: string, quiet: boolean): false {
  if (quiet) throw new Error(message);
  toast.error(message);
  return false;
}
