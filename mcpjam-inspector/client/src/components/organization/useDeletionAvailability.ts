import { useEffect, useState } from "react";
import { readDeletionAvailability } from "@/lib/apis/deletion-api";
export function useDeletionAvailability(open: boolean) {
  const [available, setAvailable] = useState<boolean | null>(null);
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    let active = true;
    setAvailable(null);
    setFailed(false);
    if (open) void readDeletionAvailability().then(
      (value) => { if (active) setAvailable(value); },
      () => { if (active) setFailed(true); },
    );
    return () => { active = false; };
  }, [open]);
  return { available, failed };
}
