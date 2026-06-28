import Link from "next/link";
import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { listPets } from "@/lib/pets";
import AppHeader from "@/components/AppHeader";
import SubmitButton from "@/components/SubmitButton";
import { createPet, updatePet, deletePet } from "@/app/pets/actions";

export const dynamic = "force-dynamic";

export const metadata = { title: "ペット" };

const inputClass =
  "w-full rounded-lg border border-border px-3 py-2 text-foreground outline-none focus:border-muted-foreground focus:ring-1 focus:ring-muted-foreground";
const labelClass = "mb-1 block text-sm font-medium text-foreground";

export default async function PetsPage() {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) redirect("/login");

  const pets = await listPets();

  return (
    <>
      <AppHeader />
      <main id="main" className="mx-auto max-w-2xl px-4 py-6">
        <div className="mb-4">
          <Link href="/" className="text-sm text-muted-foreground hover:text-foreground">
            ← 一覧へ戻る
          </Link>
        </div>
        <h1 className="mb-1 text-xl font-bold text-foreground">ペット</h1>
        <p className="mb-6 text-sm text-muted-foreground">
          記録を紐づけるペットを登録できます。多頭飼いにも対応しています。
        </p>

        {/* 登録済みのペット一覧（それぞれ編集・削除可能） */}
        {pets.length > 0 && (
          <ul className="mb-8 space-y-3">
            {pets.map((pet) => (
              <li
                key={pet.id}
                className="rounded-2xl bg-surface p-4 shadow-sm ring-1 ring-border"
              >
                <form
                  action={updatePet.bind(null, pet.id)}
                  className="space-y-3"
                >
                  <div className="flex flex-wrap gap-3">
                    <div className="flex-1 min-w-[10rem]">
                      <label className={labelClass}>名前</label>
                      <input
                        name="name"
                        type="text"
                        required
                        defaultValue={pet.name}
                        className={inputClass}
                      />
                    </div>
                    <div className="w-32">
                      <label className={labelClass}>
                        種類
                        <span className="ml-1 text-xs font-normal text-muted-foreground">
                          （任意）
                        </span>
                      </label>
                      <input
                        name="species"
                        type="text"
                        defaultValue={pet.species ?? ""}
                        placeholder="犬 / 猫 など"
                        className={inputClass}
                      />
                    </div>
                    <div className="w-40">
                      <label className={labelClass}>
                        誕生日
                        <span className="ml-1 text-xs font-normal text-muted-foreground">
                          （任意）
                        </span>
                      </label>
                      <input
                        name="birthday"
                        type="date"
                        defaultValue={pet.birthday ?? ""}
                        className={inputClass}
                      />
                    </div>
                  </div>
                  <div className="flex items-center gap-3">
                    <SubmitButton
                      pendingLabel="更新中…"
                      className="rounded-lg bg-primary px-4 py-2 text-sm font-medium text-primary-foreground transition hover:bg-primary-hover disabled:opacity-60"
                    >
                      更新
                    </SubmitButton>
                  </div>
                </form>
                <form
                  action={deletePet.bind(null, pet.id)}
                  className="mt-2 border-t border-border pt-2"
                >
                  <SubmitButton
                    pendingLabel="削除中…"
                    className="text-xs text-red-600 transition hover:text-red-800 disabled:opacity-60"
                  >
                    このペットを削除する
                  </SubmitButton>
                </form>
              </li>
            ))}
          </ul>
        )}

        {/* 新規ペット追加 */}
        <section className="rounded-2xl bg-surface p-5 shadow-sm ring-1 ring-border">
          <h2 className="mb-4 text-base font-bold text-foreground">
            ペットを追加
          </h2>
          <form action={createPet} className="space-y-4">
            <div className="flex flex-wrap gap-3">
              <div className="flex-1 min-w-[10rem]">
                <label htmlFor="new-name" className={labelClass}>
                  名前
                </label>
                <input
                  id="new-name"
                  name="name"
                  type="text"
                  required
                  placeholder="うちの子"
                  className={inputClass}
                />
              </div>
              <div className="w-32">
                <label htmlFor="new-species" className={labelClass}>
                  種類
                  <span className="ml-1 text-xs font-normal text-muted-foreground">
                    （任意）
                  </span>
                </label>
                <input
                  id="new-species"
                  name="species"
                  type="text"
                  placeholder="犬 / 猫 など"
                  className={inputClass}
                />
              </div>
              <div className="w-40">
                <label htmlFor="new-birthday" className={labelClass}>
                  誕生日
                  <span className="ml-1 text-xs font-normal text-muted-foreground">
                    （任意）
                  </span>
                </label>
                <input
                  id="new-birthday"
                  name="birthday"
                  type="date"
                  className={inputClass}
                />
              </div>
            </div>
            <SubmitButton
              pendingLabel="追加中…"
              className="rounded-lg bg-primary px-5 py-2.5 font-medium text-primary-foreground transition hover:bg-primary-hover disabled:opacity-60"
            >
              追加する
            </SubmitButton>
          </form>
        </section>

        {/* ペット画像（アバター）アップロードは将来対応 */}
      </main>
    </>
  );
}
