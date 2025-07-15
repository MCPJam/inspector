import { CheckCheck, Copy } from "lucide-react";
import { useEffect, useState } from "react";
import { Button } from "./ui/button";

export default function CopyIcon({ value }: { value: string }) {
  const [copied, setCopied] = useState(false);

  const handleCopy = async () => {
    await navigator.clipboard.writeText(value);
    setCopied(true);
  };

  useEffect(() => {
    let timeoutId: NodeJS.Timeout;
    if (copied) {
      timeoutId = setTimeout(() => {
        setCopied(false);
      }, 500);
    }
    return () => {
      if (timeoutId) {
        clearTimeout(timeoutId);
      }
    };
  }, [copied]);

  return (
    <Button size="icon" variant="ghost" className="size-4" onClick={handleCopy}>
      {copied ? <CheckCheck /> : <Copy />}
    </Button>
  );
}
