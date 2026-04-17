import { format, parseISO } from "date-fns";

export { cn } from "@mcpjam/design-system/cn";

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

export const formatDate = (
  date: string | Date,
  formatString = "HH:mm:ss.SSS",
): string => {
  const dateToFormat = typeof date === "string" ? parseISO(date) : date;
  return format(dateToFormat, formatString);
};
