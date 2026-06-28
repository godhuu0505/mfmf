import Link from "next/link";
import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { type ShareLink } from "@/types/database";
import AppHeader from "@/components/AppHeader";
import SubmitButton from "@/components/SubmitButton";
import CopyButton from "@/app/shares/CopyButton";
import {
  createShareLink,
  revokeShareLink,
  deleteShareLink,
} from "@/app/shares/actions";

export const dynamic = "force-dynamic";

export const metadata = { title: "共有リンク" };

const inputClass =
  "w-full rounded-lg border border-border px-3 py-2 text-foreground outline-none focus:border-muted-foreground focus:ring-1 focus:ring-muted-foreground";
const labelClass = "mb-1 block text-sm font-medium text-foreground";

function statusOf(link: ShareLink): { label: string; tone: string } {
  if (link.revoked_at) return { label: "失効済み", tone: "bg-surface-muted text-muted-foreground" };
  if (link.expires_at && new Date(link.expires_at) <= new Date())
    return { label: "期限切れ", tone: "bg-rose-100 text-rose-600" };
  return { label: "有効", tone: "bg-emerald-100 text-emerald-700" };
}

function formatDateTime(iso: string) {
  return new Intl.DateTimeFormat("ja-JP", {
    year: "numeric",
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  }).format(new Date(iso));
}

export default async function SharesPage() {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) redirect("/login");

  const { data } = await supabase
    .from("share_links")
    .select("*")
    .order("created_at", { ascending: false })
    .returns<ShareLink[]>();
  const links = data ?? [];

  // 共有 URL の組み立て（リクエストのホストから）。
  const h = await headers();
  const host = h.get("host") ?? "";
  const proto =
    h.get("x-forwarded-proto") ??
    (host.startsWith("localhost") || host.startsWith("127.0.0.1")
      ? "http"
      : "https");
  const baseUrl = host ? `${proto}://${host}` : "";

  return (
    <>
      <AppHeader />
      <main className="mx-auto max-w-2xl px-4 py-6">
        <div className="mb-4">
          <Link href="/" className="text-sm text-muted-foreground hover:text-foreground">
            ← 一覧へ戻る
          </Link>
        </div>
        <h1 className="mb-1 text-xl font-bold text-foreground">共有リンク</h1>
        <p className="mb-6 text-sm text-muted-foreground">
          祖父母など第三者に、記録を<strong>閲覧のみ</strong>で共有できます。
          期限切れ・失効でいつでも無効にできます。写真は共有されません（テキストのみ）。
        </p>

        {/* 既存リンク一覧 */}
        {links.length > 0 && (
          <ul className="mb-8 space-y-3">
            {links.map((link) => {
              const status = statusOf(link);
              const url = `${baseUrl}/share/${link.token}`;
              return (
                <li
                  key={link.id}
                  className="rounded-2xl bg-surface p-4 shadow-sm ring-1 ring-border"
                >
                  <div className="mb-2 flex flex-wrap items-center gap-2">
                    <span
                      className={
                        "rounded-full px-2 py-0.5 text-xs font-medium " + status.tone
                      }
                    >
                      {status.label}
                    </span>
                    {link.label && (
                      <span className="text-sm font-semibold text-foreground">
                        {link.label}
                      </span>
                    )}
                  </div>

                  <div className="mb-2 flex items-center gap-2">
                    <input
                      readOnly
                      value={url}
                      className="min-w-0 flex-1 rounded-lg border border-border bg-surface-muted px-2 py-1.5 text-xs text-muted-foreground"
                      aria-label="共有 URL"
                    />
                    <CopyButton value={url} />
                  </div>

                  <p className="text-xs text-muted-foreground">
                    {link.expires_at
                      ? `期限: ${formatDateTime(link.expires_at)}`
                      : "期限: 無期限"}
                    {(link.from_date || link.to_date) &&
                      ` / 期間: ${link.from_date ?? "〜"} 〜 ${link.to_date ?? ""}`}
                  </p>

                  <div className="mt-2 flex items-center gap-3 border-t border-border pt-2">
                    {!link.revoked_at && (
                      <form action={revokeShareLink.bind(null, link.id)}>
                        <SubmitButton
                          pendingLabel="失効中…"
                          className="text-xs font-medium text-amber-600 transition hover:text-amber-800 disabled:opacity-60"
                        >
                          失効させる
                        </SubmitButton>
                      </form>
                    )}
                    <form action={deleteShareLink.bind(null, link.id)}>
                      <SubmitButton
                        pendingLabel="削除中…"
                        className="text-xs text-red-500 transition hover:text-red-700 disabled:opacity-60"
                      >
                        削除
                      </SubmitButton>
                    </form>
                  </div>
                </li>
              );
            })}
          </ul>
        )}

        {/* 新規作成 */}
        <section className="rounded-2xl bg-surface p-5 shadow-sm ring-1 ring-border">
          <h2 className="mb-4 text-base font-bold text-foreground">
            共有リンクを作成
          </h2>
          <form action={createShareLink} className="space-y-4">
            <div>
              <label htmlFor="label" className={labelClass}>
                メモ（共有相手など・任意）
              </label>
              <input
                id="label"
                name="label"
                type="text"
                placeholder="おじいちゃん・おばあちゃん用"
                className={inputClass}
              />
            </div>
            <div className="flex flex-wrap gap-3">
              <div className="flex-1 min-w-[8rem]">
                <label htmlFor="from_date" className={labelClass}>
                  開始日<span className="ml-1 text-xs font-normal text-muted-foreground">（任意）</span>
                </label>
                <input id="from_date" name="from_date" type="date" className={inputClass} />
              </div>
              <div className="flex-1 min-w-[8rem]">
                <label htmlFor="to_date" className={labelClass}>
                  終了日<span className="ml-1 text-xs font-normal text-muted-foreground">（任意）</span>
                </label>
                <input id="to_date" name="to_date" type="date" className={inputClass} />
              </div>
              <div className="w-28">
                <label htmlFor="expires_days" className={labelClass}>
                  有効日数
                </label>
                <input
                  id="expires_days"
                  name="expires_days"
                  type="number"
                  min="0"
                  placeholder="無期限"
                  className={inputClass}
                />
              </div>
            </div>
            <SubmitButton
              pendingLabel="作成中…"
              className="rounded-lg bg-primary px-5 py-2.5 font-medium text-primary-foreground transition hover:bg-primary-hover disabled:opacity-60"
            >
              リンクを作成する
            </SubmitButton>
          </form>
        </section>
      </main>
    </>
  );
}
