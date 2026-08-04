import Link from "next/link";
import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { listPets } from "@/lib/pets";
import { canEdit, getCurrentMembership } from "@/lib/household";
import { createAvatarSignedUrls } from "@/lib/avatars";
import AvatarUploader from "@/components/AvatarUploader";
import PetEditSheet from "@/components/PetEditSheet";
import SubmitButton from "@/components/SubmitButton";
import { createPet, updatePet, deletePet, updatePetAvatar } from "@/app/(app)/pets/actions";

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
  // viewer には編集フォームを出さず、閲覧用の一覧のみ表示する（UC-A06）。
  const membership = await getCurrentMembership(supabase);
  const readOnly = membership !== null && !canEdit(membership.role);
  // 各ペットのアバター（private バケット）の署名付き URL をまとめて解決する。
  const avatarUrls = await createAvatarSignedUrls(
    pets.map((p) => p.avatar_path).filter((p): p is string => Boolean(p)),
  );

  return (
    <>
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
                <div className="mb-3">
                  <AvatarUploader
                    scopeId={pet.household_id}
                    currentUrl={
                      pet.avatar_path
                        ? avatarUrls.get(pet.avatar_path) ?? null
                        : null
                    }
                    action={updatePetAvatar.bind(null, pet.id)}
                    alt={`${pet.name}の写真`}
                    label={`${pet.name} の写真`}
                    disabled={readOnly}
                  />
                </div>
                <div className="flex items-center justify-between gap-3">
                  <div className="min-w-0">
                    <p className="font-medium text-foreground">{pet.name}</p>
                    <p className="mt-0.5 text-sm text-muted-foreground">
                      {pet.species ?? "種類未設定"}
                      {pet.birthday ? ` ・ 誕生日 ${pet.birthday}` : ""}
                    </p>
                  </div>
                  {!readOnly && (
                    <PetEditSheet
                      petName={pet.name}
                      editForm={
                        <form
                          action={updatePet.bind(null, pet.id)}
                          className="space-y-3"
                        >
                          <div>
                            <label className={labelClass}>名前</label>
                            <input
                              name="name"
                              type="text"
                              required
                              defaultValue={pet.name}
                              className={inputClass}
                            />
                          </div>
                          <div className="grid grid-cols-2 gap-3">
                            <div>
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
                            <div>
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
                          <SubmitButton
                            pendingLabel="更新中…"
                            className="w-full rounded-xl bg-primary py-2.5 text-sm font-medium text-primary-foreground transition hover:bg-primary-hover disabled:opacity-60"
                          >
                            更新する
                          </SubmitButton>
                        </form>
                      }
                      deleteForm={
                        <form action={deletePet.bind(null, pet.id)}>
                          <SubmitButton
                            pendingLabel="削除中…"
                            className="w-full rounded-xl bg-red-600 py-2.5 text-sm font-medium text-white transition hover:bg-red-700 disabled:opacity-60"
                          >
                            削除する
                          </SubmitButton>
                        </form>
                      }
                    />
                  )}
                </div>
              </li>
            ))}
          </ul>
        )}

        {/* 新規ペット追加（viewer には出さない） */}
        {!readOnly && (
        <section className="rounded-2xl bg-surface p-5 shadow-sm ring-1 ring-border">
          <h2 className="mb-4 text-base font-bold text-foreground">
            ペットを追加
          </h2>
          <form action={createPet} className="space-y-4">
            {/* 追加先の世帯を明示（Cookie 切替後の古いフォーム送信対策） */}
            {membership && (
              <input type="hidden" name="household_id" value={membership.householdId} />
            )}
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
        )}

      </main>
    </>
  );
}
