import { describe, expect, it } from "vitest";
import { canEdit, householdScopeFilter, type HouseholdRole } from "@/lib/household";

// S2 RBAC の役割境界。viewer に書き込みを許す変更が入るとここで落ちる。
// （どのヘルパーをどの Server Action が呼ぶかは Integration 層で検証する。
//  ここは role → 可否 の対応そのものだけを見る）

describe("canEdit", () => {
  const table: [HouseholdRole, boolean][] = [
    ["owner", true],
    ["editor", true],
    ["viewer", false],
  ];

  it.each(table)("%s → %s", (role, expected) => {
    expect(canEdit(role)).toBe(expected);
  });
});

describe("householdScopeFilter", () => {
  it("当該世帯の行と household_id が null の行（無停止移行の取りこぼし防止）を対象にする", () => {
    const hh = "11111111-1111-4111-8111-111111111111";
    expect(householdScopeFilter(hh)).toBe(
      `household_id.eq.${hh},household_id.is.null`,
    );
  });
});
