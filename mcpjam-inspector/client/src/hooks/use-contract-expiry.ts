import { useEffect, useState } from "react";

/** Wake a mounted view at the contract boundary, even without a database write. */
export function useContractExpiry<T extends { unlimitedCreditsUntil?: number | null }>(value: T | undefined): T | undefined {
  const [now, setNow] = useState(Date.now);
  const deadline = value?.unlimitedCreditsUntil;
  useEffect(() => {
    if (!deadline || deadline <= Date.now()) return;
    const timer = setTimeout(() => setNow(Date.now()), Math.min(deadline - Date.now() + 1, 2_147_483_647));
    return () => clearTimeout(timer);
  }, [deadline, now]);
  return value && deadline && deadline <= now ? { ...value, unlimitedCreditsUntil: null } : value;
}
