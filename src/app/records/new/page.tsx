import Link from "next/link";
import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { getCurrentProfile } from "@/lib/profile";
import { listPets } from "@/lib/pets";
import AppHeader from "@/components/AppHeader";
import RecordForm from "@/components/RecordForm";
import { createRecord } from "@/app/records/actions";
import { getOwnerTags } from "@/lib/tags";

export const dynamic = "force-dynamic";

export default async function NewRecordPage() {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) redirect("/login");

  const today = new Date().toISOString().slice(0, 10);
  const [profile, pets, ownerTags] = await Promise.all([
    getCurrentProfile(),
    listPets(),
    getOwnerTags(),
  ]);
  const tagSuggestions = ownerTags.map((t) => t.name);

  return (
    <>
      <AppHeader />
      <main id="main" className="mx-auto max-w-2xl px-4 py-6">
        <div className="mb-4">
          <Link href="/" className="text-sm text-muted-foreground hover:text-foreground">
            ← 一覧へ戻る
          </Link>
        </div>
        <h1 className="mb-6 text-xl font-bold text-foreground">記録を追加</h1>

        <RecordForm
          action={createRecord}
          ownerId={user.id}
          defaultDate={today}
          defaultAuthor={profile?.default_author ?? ""}
          pets={pets.map((p) => ({ id: p.id, name: p.name }))}
          defaultPetId={pets[0]?.id ?? null}
          tagSuggestions={tagSuggestions}
          submitLabel="保存する"
          cancelHref="/"
        />
      </main>
    </>
  );
}
