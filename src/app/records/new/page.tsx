import Link from "next/link";
import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
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
  const tagSuggestions = (await getOwnerTags()).map((t) => t.name);

  return (
    <>
      <AppHeader />
      <main className="mx-auto max-w-2xl px-4 py-6">
        <div className="mb-4">
          <Link href="/" className="text-sm text-slate-500 hover:text-slate-800">
            ← 一覧へ戻る
          </Link>
        </div>
        <h1 className="mb-6 text-xl font-bold text-slate-900">記録を追加</h1>

        <RecordForm
          action={createRecord}
          ownerId={user.id}
          defaultDate={today}
          tagSuggestions={tagSuggestions}
          submitLabel="保存する"
          cancelHref="/"
        />
      </main>
    </>
  );
}
