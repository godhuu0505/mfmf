import Link from "next/link";
import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { listPets } from "@/lib/pets";
import AppHeader from "@/components/AppHeader";
import { createPet, updatePet, deletePet } from "@/app/pets/actions";

export const dynamic = "force-dynamic";

export const metadata = { title: "ペット" };

const inputClass =
  "w-full rounded-lg border border-slate-300 px-3 py-2 text-slate-900 outline-none focus:border-slate-500 focus:ring-1 focus:ring-slate-500";
const labelClass = "mb-1 block text-sm font-medium text-slate-700";

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
      <main className="mx-auto max-w-2xl px-4 py-6">
        <div className="mb-4">
          <Link href="/" className="text-sm text-slate-500 hover:text-slate-800">
            ← 一覧へ戻る
          </Link>
        </div>
        <h1 className="mb-1 text-xl font-bold text-slate-900">ペット</h1>
        <p className="mb-6 text-sm text-slate-500">
          記録を紐づけるペットを登録できます。多頭飼いにも対応しています。
        </p>

        {/* 登録済みのペット一覧（それぞれ編集・削除可能） */}
        {pets.length > 0 && (
          <ul className="mb-8 space-y-3">
            {pets.map((pet) => (
              <li
                key={pet.id}
                className="rounded-2xl bg-white p-4 shadow-sm ring-1 ring-slate-200"
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
                        <span className="ml-1 text-xs font-normal text-slate-400">
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
                        <span className="ml-1 text-xs font-normal text-slate-400">
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
                    <button
                      type="submit"
                      className="rounded-lg bg-slate-900 px-4 py-2 text-sm font-medium text-white transition hover:bg-slate-700"
                    >
                      更新
                    </button>
                  </div>
                </form>
                <form
                  action={deletePet.bind(null, pet.id)}
                  className="mt-2 border-t border-slate-100 pt-2"
                >
                  <button
                    type="submit"
                    className="text-xs text-red-500 transition hover:text-red-700"
                  >
                    このペットを削除する
                  </button>
                </form>
              </li>
            ))}
          </ul>
        )}

        {/* 新規ペット追加 */}
        <section className="rounded-2xl bg-white p-5 shadow-sm ring-1 ring-slate-200">
          <h2 className="mb-4 text-base font-bold text-slate-900">
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
                  <span className="ml-1 text-xs font-normal text-slate-400">
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
                  <span className="ml-1 text-xs font-normal text-slate-400">
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
            <button
              type="submit"
              className="rounded-lg bg-slate-900 px-5 py-2.5 font-medium text-white transition hover:bg-slate-700"
            >
              追加する
            </button>
          </form>
        </section>

        {/* ペット画像（アバター）アップロードは将来対応 */}
      </main>
    </>
  );
}
