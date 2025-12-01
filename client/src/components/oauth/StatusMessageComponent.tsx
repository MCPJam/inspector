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
      bgColor = "bg-destructive/10";
      textColor = "text-destructive";
      borderColor = "border-destructive/20";
      break;
    case "success":
      bgColor = "bg-success/10";
      textColor = "text-success";
      borderColor = "border-success/20";
      break;
    case "info":
    default:
      bgColor = "bg-info/10";
      textColor = "text-info";
      borderColor = "border-info/20";
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
