import { AlertCircle } from "lucide-react";
import { StatusMessage } from "@/shared/types.js";
interface StatusMessageProps {
  message: StatusMessage;
}
export const StatusMessageComponent = ({ message }: StatusMessageProps) => {
  let bgColor: string;
  let textColor: string;
  let borderColor: string;

  switch (message.type) {
    case "error":
      bgColor = "bg-red-50 dark:bg-red-950/50";
      textColor = "text-red-700 dark:text-red-400";
      borderColor = "border-red-200 dark:border-red-800";
      break;
    case "success":
      bgColor = "bg-green-50 dark:bg-green-950/50";
      textColor = "text-green-700 dark:text-green-400";
      borderColor = "border-green-200 dark:border-green-800";
      break;
    case "info":
    default:
      bgColor = "bg-blue-50 dark:bg-blue-950/50";
      textColor = "text-blue-700 dark:text-blue-400";
      borderColor = "border-blue-200 dark:border-blue-800";
      break;
  }

  return (
    <div
      className={`p-3 rounded-md border ${bgColor} ${borderColor} ${textColor} mb-4`}
    >
      <div className="flex items-center gap-2">
        <AlertCircle className="h-4 w-4" />
        <p className="text-sm">{message.message}</p>
      </div>
    </div>
  );
};
