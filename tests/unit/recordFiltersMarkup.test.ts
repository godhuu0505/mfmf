import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import RecordFilters from "@/components/RecordFilters";

const filters = { q: "架空の条件", from: "", to: "", source: "all" as const, sort: "date_desc" as const, page: 1 };
describe("ranking UI visibility", () => {
  it("keeps normal keyword search and omits the external-send button by default", () => {
    const html = renderToStaticMarkup(createElement(RecordFilters, { filters }));
    expect(html).toContain("本文・記入者で検索"); expect(html).toContain('type="submit"');
    expect(html).not.toContain("関連度で探す"); expect(html).not.toContain("Google Cloud");
  });
  it("describes the bounded input, limited masking and processing location before use", () => {
    const html = renderToStaticMarkup(createElement(RecordFilters, { filters, rankingEnabled: true }));
    for (const copy of ["関連度で探す", "入力文", "各600文字以内", "最大100件", "完全な匿名化は保証できません", "東京内での処理は保証されません", "1日20回まで"]) expect(html).toContain(copy);
    expect(html).toContain('type="button"');
  });
});
