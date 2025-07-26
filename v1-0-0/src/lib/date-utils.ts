import { format, parseISO } from "date-fns";

export const formatDate = (
  date: string | Date,
  formatString = "HH:mm:ss.SSS",
): string => {
  const dateToFormat = typeof date === "string" ? parseISO(date) : date;
  return format(dateToFormat, formatString);
};
