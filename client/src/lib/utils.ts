import { clsx, type ClassValue } from "clsx";
import { twMerge } from "tailwind-merge";

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}

export const getInitials = (str: string): string => {
  if (typeof str !== "string" || !str.trim()) return "?";

  return (
    str
      .trim()
      .split(/\s+/)
      .filter(Boolean)
      .map((word) => word[0])
      .join("")
      .toUpperCase() || "?"
  );
};

export function formatCurrency(
  amount: number,
  opts?: {
    currency?: string;
    locale?: string;
    minimumFractionDigits?: number;
    maximumFractionDigits?: number;
    noDecimals?: boolean;
  },
) {
  const {
    currency = "USD",
    locale = "en-US",
    minimumFractionDigits,
    maximumFractionDigits,
    noDecimals,
  } = opts ?? {};

  const formatOptions: Intl.NumberFormatOptions = {
    style: "currency",
    currency,
    minimumFractionDigits: noDecimals ? 0 : minimumFractionDigits,
    maximumFractionDigits: noDecimals ? 0 : maximumFractionDigits,
  };

  return new Intl.NumberFormat(locale, formatOptions).format(amount);
}

export function formatTimeRemaining(timeLeftMs: number): string {
  if (timeLeftMs <= 0) return "Expired";

  const days = Math.floor(timeLeftMs / (1000 * 60 * 60 * 24));
  const hours = Math.floor(
    (timeLeftMs % (1000 * 60 * 60 * 24)) / (1000 * 60 * 60),
  );
  const minutes = Math.floor((timeLeftMs % (1000 * 60 * 60)) / (1000 * 60));
  const seconds = Math.floor((timeLeftMs % (1000 * 60)) / 1000);

  const parts = [];
  if (days > 0) parts.push(`${days}d`);
  if (hours > 0) parts.push(`${hours}h`);
  if (minutes > 0) parts.push(`${minutes}m`);
  if (seconds > 0 || parts.length === 0) parts.push(`${seconds}s`);

  return parts.join(" ") + " remaining";
}

export function getTimeBreakdown(timeLeftMs: number) {
  const days = Math.floor(timeLeftMs / (1000 * 60 * 60 * 24));
  const hours = Math.floor(
    (timeLeftMs % (1000 * 60 * 60 * 24)) / (1000 * 60 * 60),
  );
  const minutes = Math.floor((timeLeftMs % (1000 * 60 * 60)) / (1000 * 60));
  const seconds = Math.floor((timeLeftMs % (1000 * 60)) / 1000);

  return {
    days,
    hours,
    minutes,
    seconds,
    isExpired: timeLeftMs <= 0,
    isExpiringSoon: timeLeftMs <= 300000, // 5 minutes
  };
}
