import { clsx, type ClassValue } from "clsx";
import { twMerge } from "tailwind-merge";

/** 合并条件类名并消解 Tailwind 冲突类（后写者胜，如 cn("p-2","p-4") = "p-4"）——组件拼样式的唯一入口。 */
export function cn(...inputs: ClassValue[]): string {
  return twMerge(clsx(inputs));
}
