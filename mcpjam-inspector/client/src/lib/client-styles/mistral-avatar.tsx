import type { ReactNode } from "react";

import { cn } from "@/lib/utils";

const MISTRAL_MARK_PATH =
  "M13.3715 16.358H16.1144V13.6486H13.3712L13.3715 16.358H10.6283V13.6486H7.88568V16.358H10.6283V19.0676H2.3999V16.358H5.14279V5.52002H7.88568V8.22963H10.6286V10.939H13.3715V8.22963H16.1144V5.52002H18.8572V16.358H21.5999V19.0676H13.3715V16.358Z";

interface MistralStaticAvatarProps {
  ariaLabel?: string;
  avatarClassName?: string;
  borderRadius?: string;
  children?: ReactNode;
  className?: string;
  testId?: string;
}

export function MistralStaticAvatar({
  ariaLabel,
  avatarClassName = "rounded-md",
  borderRadius = "25%",
  children,
  className,
  testId = "mistral-static-avatar",
}: MistralStaticAvatarProps) {
  return (
    <div
      className={cn(
        "mistral-mark-colors flex items-center justify-center overflow-hidden",
        className
      )}
      style={{ borderRadius }}
      aria-label={ariaLabel}
      data-testid={testId}
    >
      <span
        data-slot="avatar"
        className={cn(
          "relative flex h-7 w-7 shrink-0 overflow-hidden",
          avatarClassName
        )}
      >
        <div
          className="flex items-center justify-center bg-brand-500"
          style={{
            width: 28,
            height: 28,
            backgroundColor:
              "var(--bg-brand-500, var(--mistral-spinner-brand))",
          }}
        >
          <svg
            xmlns="http://www.w3.org/2000/svg"
            viewBox="0 0 24 24"
            width="21"
            height="21"
            className="text-white-default"
            fill="currentColor"
            style={{
              color: "var(--text-white-default, var(--mistral-spinner-white))",
            }}
          >
            <path d={MISTRAL_MARK_PATH} />
          </svg>
        </div>
      </span>
      {children}
    </div>
  );
}
