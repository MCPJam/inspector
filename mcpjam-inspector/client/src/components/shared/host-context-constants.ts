/**
 * Static option lists and preset device metadata for host context controls.
 */

import type { ComponentType } from "react";
import { Smartphone, Tablet, Monitor } from "lucide-react";
import {
  DEVICE_VIEWPORT_CONFIGS,
  type CspMode,
  type DeviceType,
} from "@/stores/ui-playground-store";

export const PRESET_DEVICE_CONFIGS: Record<
  Exclude<DeviceType, "custom">,
  {
    width: number;
    height: number;
    label: string;
    icon: ComponentType<{ className?: string }>;
  }
> = {
  mobile: {
    ...DEVICE_VIEWPORT_CONFIGS.mobile,
    label: "Phone",
    icon: Smartphone,
  },
  tablet: {
    ...DEVICE_VIEWPORT_CONFIGS.tablet,
    label: "Tablet",
    icon: Tablet,
  },
  desktop: {
    ...DEVICE_VIEWPORT_CONFIGS.desktop,
    label: "Desktop",
    icon: Monitor,
  },
};

export const LOCALE_OPTIONS = [
  { code: "en-US", label: "English (US)" },
  { code: "en-GB", label: "English (UK)" },
  { code: "es-ES", label: "Español" },
  { code: "es-MX", label: "Español (MX)" },
  { code: "fr-FR", label: "Français" },
  { code: "de-DE", label: "Deutsch" },
  { code: "it-IT", label: "Italiano" },
  { code: "pt-BR", label: "Português (BR)" },
  { code: "ja-JP", label: "日本語" },
  { code: "zh-CN", label: "简体中文" },
  { code: "zh-TW", label: "繁體中文" },
  { code: "ko-KR", label: "한국어" },
  { code: "ar-SA", label: "العربية" },
  { code: "hi-IN", label: "हिन्दी" },
  { code: "ru-RU", label: "Русский" },
  { code: "nl-NL", label: "Nederlands" },
] as const;

export const TIMEZONE_OPTIONS = [
  { zone: "America/New_York", label: "New York", offset: "UTC-5/-4" },
  { zone: "America/Chicago", label: "Chicago", offset: "UTC-6/-5" },
  { zone: "America/Denver", label: "Denver", offset: "UTC-7/-6" },
  { zone: "America/Los_Angeles", label: "Los Angeles", offset: "UTC-8/-7" },
  { zone: "America/Sao_Paulo", label: "São Paulo", offset: "UTC-3" },
  { zone: "America/Mexico_City", label: "Mexico City", offset: "UTC-6/-5" },
  { zone: "Europe/London", label: "London", offset: "UTC+0/+1" },
  { zone: "Europe/Paris", label: "Paris", offset: "UTC+1/+2" },
  { zone: "Europe/Berlin", label: "Berlin", offset: "UTC+1/+2" },
  { zone: "Europe/Moscow", label: "Moscow", offset: "UTC+3" },
  { zone: "Asia/Dubai", label: "Dubai", offset: "UTC+4" },
  { zone: "Asia/Kolkata", label: "Mumbai", offset: "UTC+5:30" },
  { zone: "Asia/Singapore", label: "Singapore", offset: "UTC+8" },
  { zone: "Asia/Shanghai", label: "Shanghai", offset: "UTC+8" },
  { zone: "Asia/Tokyo", label: "Tokyo", offset: "UTC+9" },
  { zone: "Asia/Seoul", label: "Seoul", offset: "UTC+9" },
  { zone: "Australia/Sydney", label: "Sydney", offset: "UTC+10/+11" },
  { zone: "Pacific/Auckland", label: "Auckland", offset: "UTC+12/+13" },
  { zone: "UTC", label: "UTC", offset: "UTC+0" },
] as const;

export const CSP_MODE_OPTIONS: {
  mode: CspMode;
  label: string;
  description: string;
}[] = [
  {
    mode: "permissive",
    label: "Permissive",
    description: "Allows all HTTPS resources",
  },
  {
    mode: "widget-declared",
    label: "Strict",
    description: "Only widget-declared domains",
  },
];
