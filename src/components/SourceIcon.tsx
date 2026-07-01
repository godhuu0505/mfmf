import { House, School } from "lucide-react";
import type { RecordSource } from "@/types/database";

// 記録元（おうち / 保育園）を表す小さなアイコン。
// 色は currentColor 継承なので、置き場所のテキスト色（テーマトークン）に追従する。
export default function SourceIcon({
  source,
  className = "h-4 w-4",
}: {
  source: RecordSource;
  className?: string;
}) {
  const Icon = source === "home" ? House : School;
  return <Icon className={className} aria-hidden="true" />;
}
