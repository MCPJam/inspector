"use client";

import Image from "next/image";
import { getProviderLogoFromProvider } from "./chat-helpers";
import { cn } from "@/lib/chat-utils";
import { getProviderColor } from "./chat-helpers";

interface ProviderLogoProps {
  provider: string;
}

export function ProviderLogo({ provider }: ProviderLogoProps) {
  const logoSrc = getProviderLogoFromProvider(provider);

  if (!logoSrc) {
    return (
      <div className={cn("h-3 w-3 rounded-sm", getProviderColor(provider))} />
    );
  } else {
    return (
      <Image
        src={logoSrc}
        width={12}
        height={12}
        alt={`${provider} logo`}
        className={"h-3 w-3 object-contain"}
      />
    );
  }
}
