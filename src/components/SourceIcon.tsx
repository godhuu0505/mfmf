import {
  House,
  Stethoscope,
  Scissors,
  Pin,
  School,
  type LucideIcon,
} from "lucide-react";
import type { RecordSource } from "@/types/database";

// 種類（保育園 / おうち / 病院 / サロン / その他）を表す小さなアイコン。
// 色は currentColor 継承なので、置き場所のテキスト色（テーマトークン）に追従する。
const ICON: Record<RecordSource, LucideIcon> = {
  daycare: School,
  home: House,
  clinic: Stethoscope,
  salon: Scissors,
  other: Pin,
};

export default function SourceIcon({
  source,
  className = "h-4 w-4",
}: {
  source: RecordSource;
  className?: string;
}) {
  const Icon = ICON[source] ?? Pin;
  return <Icon className={className} aria-hidden="true" />;
}
