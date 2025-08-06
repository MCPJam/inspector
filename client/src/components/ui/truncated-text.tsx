import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog";
import { truncateText } from "@/lib/chat-utils";

interface TruncatedTextProps {
  text: string;
  maxLength?: number;
  title?: string;
  className?: string;
}

export function TruncatedText({ text, maxLength = 300, title, className = "" }: TruncatedTextProps) {
  const truncatedText = truncateText(text, maxLength);
  const isTextTruncated = truncatedText !== text;

  return (
    <p className={`text-xs text-muted-foreground leading-relaxed font-medium ${className}`}>
      <span>
        {truncatedText.replace(/\.\.\.$/, "")}
        {isTextTruncated && "..."}
      </span>
      {isTextTruncated && (
        <Dialog>
          <DialogTrigger asChild>
            <button className="text-xs text-muted-foreground hover:text-muted-foreground/90 ml-1 italic underline underline-offset-2">
              View All
            </button>
          </DialogTrigger>
          <DialogContent className="sm:max-w-3xl lg:max-w-4xl">
            <DialogHeader>
              {title && <DialogTitle className="text-lg mb-4">{title}</DialogTitle>}
              <div className="max-h-[70vh] overflow-y-auto">
                <p className="text-sm text-muted-foreground leading-relaxed whitespace-pre-wrap">
                  {text}
                </p>
              </div>
            </DialogHeader>
          </DialogContent>
        </Dialog>
      )}
    </p>
  );
}