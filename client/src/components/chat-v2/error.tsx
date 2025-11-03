import { CircleAlert } from "lucide-react";
import { Button } from "../ui/button";

interface ErrorBoxProps {
  message: string;
  onResetChat: () => void;
}

export function ErrorBox({ message, onResetChat }: ErrorBoxProps) {
  return (
    <div className="flex items-center h-full gap-3 border border-red-500 rounded bg-red-300/80 p-4 text-red-900">
      <CircleAlert className="h-6 w-6 text-red-900" />
      <p className="flex-1 text-sm leading-6">An error occured: {message}</p>
      <Button
        type="button"
        variant="outline"
        onClick={onResetChat}
        className="ml-auto"
      >
        Reset chat
      </Button>
    </div>
  );
}
