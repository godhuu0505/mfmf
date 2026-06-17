"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";

async function requireUser() {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) redirect("/login");
  return { supabase, user };
}

function parsePetFields(formData: FormData) {
  const name = String(formData.get("name") || "").trim();
  const speciesRaw = String(formData.get("species") || "").trim();
  const birthdayRaw = String(formData.get("birthday") || "").trim();
  return {
    name,
    species: speciesRaw === "" ? null : speciesRaw,
    birthday: birthdayRaw === "" ? null : birthdayRaw,
  };
}

export async function createPet(formData: FormData) {
  const { supabase, user } = await requireUser();
  const fields = parsePetFields(formData);
  if (fields.name === "") {
    throw new Error("ペットの名前を入力してください");
  }

  const { error } = await supabase
    .from("pets")
    .insert({ owner_id: user.id, ...fields });
  if (error) {
    throw new Error(`ペットの追加に失敗しました: ${error.message}`);
  }

  revalidatePath("/pets");
  revalidatePath("/");
}

export async function updatePet(petId: string, formData: FormData) {
  const { supabase } = await requireUser();
  const fields = parsePetFields(formData);
  if (fields.name === "") {
    throw new Error("ペットの名前を入力してください");
  }

  // RLS (owner_id = auth.uid()) により自分のペットのみ更新できる。
  const { error } = await supabase.from("pets").update(fields).eq("id", petId);
  if (error) {
    throw new Error(`ペットの更新に失敗しました: ${error.message}`);
  }

  revalidatePath("/pets");
  revalidatePath("/");
}

export async function deletePet(petId: string) {
  const { supabase } = await requireUser();
  // 記録の pet_id は ON DELETE SET NULL のため、削除しても記録自体は残る。
  const { error } = await supabase.from("pets").delete().eq("id", petId);
  if (error) {
    throw new Error(`ペットの削除に失敗しました: ${error.message}`);
  }

  revalidatePath("/pets");
  revalidatePath("/");
}
