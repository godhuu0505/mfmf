"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import {
  ASSIGNEE_ROLES,
  toSource,
  type AssigneeRole,
  type RecordSource,
} from "@/types/database";
import {
  canEdit,
  getRoleInHousehold,
  requireEditableHousehold,
} from "@/lib/household";
import { rolesFor, timeProblem, weekdayOf } from "@/lib/schedule";

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

type Supabase = Awaited<ReturnType<typeof createClient>>;

async function requireUser(supabase: Supabase) {
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) redirect("/login");
  return user;
}

/**
 * 新しく作るときの書き込み先の世帯。
 * 「画面を描画した世帯」（hidden で送信）を優先し、その世帯での editor+ を検証する。
 * Cookie の現在世帯に依存すると、別タブで世帯を切り替えた後の送信で食い違う
 * （records/actions.ts の createRecord と同じ方針）。
 */
async function resolveWritableHousehold(
  supabase: Supabase,
  userId: string,
  formData: FormData,
): Promise<string> {
  const formHousehold = String(formData.get("household_id") || "").trim();
  if (UUID_RE.test(formHousehold)) {
    const role = await getRoleInHousehold(supabase, userId, formHousehold);
    if (!role) throw new Error("この世帯のメンバーではありません");
    if (!canEdit(role)) {
      throw new Error(
        "閲覧のみの権限（viewer）のため、追加・編集・削除はできません",
      );
    }
    return formHousehold;
  }
  // 予定・ルールは世帯に属する。未所属では作れない（/onboarding へ誘導する）
  const householdId = await requireEditableHousehold(supabase, userId);
  if (!householdId) {
    throw new Error("世帯がありません。先に世帯を作ってください");
  }
  return householdId;
}

/**
 * 既存の行に対する操作は「対象行の household_id」で判定する。
 * 現在世帯を基準にすると、複数世帯に属する人が別タブで切り替えたときに
 * 正当な編集を弾いたり、誤った世帯で事前認可してしまう（CLAUDE.md）。
 */
async function requireEditableRecordHousehold(
  supabase: Supabase,
  userId: string,
  recordId: string,
): Promise<string> {
  const { data } = await supabase
    .from("daycare_records")
    .select("household_id")
    .eq("id", recordId)
    .maybeSingle();
  if (!data) throw new Error("予定が見つかりません（または権限がありません）");
  const role = await getRoleInHousehold(supabase, userId, data.household_id);
  if (role && !canEdit(role)) {
    throw new Error(
      "閲覧のみの権限（viewer）のため、追加・編集・削除はできません",
    );
  }
  return data.household_id;
}

async function requireEditableRuleHousehold(
  supabase: Supabase,
  userId: string,
  ruleId: string,
): Promise<string> {
  const { data } = await supabase
    .from("schedule_rules")
    .select("household_id")
    .eq("id", ruleId)
    .maybeSingle();
  if (!data) throw new Error("ルールが見つかりません（または権限がありません）");
  const role = await getRoleInHousehold(supabase, userId, data.household_id);
  if (role && !canEdit(role)) {
    throw new Error(
      "閲覧のみの権限（viewer）のため、追加・編集・削除はできません",
    );
  }
  return data.household_id;
}

/** フォームから担当（役割 → メンバー）を取り出す。種類に無い役割は捨てる。 */
function readAssignees(
  formData: FormData,
  source: RecordSource,
): Partial<Record<AssigneeRole, string>> {
  const allowed = new Set<AssigneeRole>(rolesFor(source));
  const who: Partial<Record<AssigneeRole, string>> = {};
  for (const role of ASSIGNEE_ROLES) {
    if (!allowed.has(role)) continue;
    const v = String(formData.get(`who_${role}`) || "").trim();
    if (UUID_RE.test(v)) who[role] = v;
  }
  return who;
}

/** 担当を差し替える。世帯のメンバーでない相手は落とす（RLS の手前での防御）。 */
async function syncAssignees(
  supabase: Supabase,
  table: "record_assignees" | "schedule_rule_assignees",
  key: "record_id" | "rule_id",
  ownerRowId: string,
  householdId: string,
  who: Partial<Record<AssigneeRole, string>>,
) {
  const ids = [...new Set(Object.values(who).filter(Boolean))] as string[];
  let members = new Set<string>();
  if (ids.length > 0) {
    const { data } = await supabase
      .from("household_members")
      .select("user_id")
      .eq("household_id", householdId)
      .in("user_id", ids);
    members = new Set((data ?? []).map((m) => m.user_id as string));
  }

  const rows = ASSIGNEE_ROLES.filter(
    (role) => who[role] && members.has(who[role] as string),
  ).map((role) => ({
    [key]: ownerRowId,
    role,
    user_id: who[role] as string,
  }));

  await supabase.from(table).delete().eq(key, ownerRowId);
  if (rows.length > 0) {
    const { error } = await supabase.from(table).insert(rows);
    if (error) throw new Error(`担当の保存に失敗しました: ${error.message}`);
  }
}

function readTimes(formData: FormData) {
  const start = String(formData.get("start_time") || "").trim() || null;
  const end = String(formData.get("end_time") || "").trim() || null;
  const problem = timeProblem({ start, end });
  if (problem) throw new Error(problem);
  return { start_time: start, end_time: end };
}

function revalidateSchedule() {
  revalidatePath("/");
  revalidatePath("/calendar");
  revalidatePath("/schedule/rules");
}

// ---------------------------------------------------------------
// 予定
// ---------------------------------------------------------------

/**
 * その日の予定を保存する。
 * record_id が空（＝曜日ルール由来をそのまま開いた）ときは新しい行を作り、
 * overrides_rule = true でその日のルールを隠す（「違う日だけ上書き」）。
 */
export async function savePlan(formData: FormData) {
  const supabase = await createClient();
  const user = await requireUser(supabase);
  await savePlanRow(supabase, user.id, formData);
  revalidateSchedule();
}

/** savePlan の中身。作った / 更新した行の id を返す（完了の経路からも使う）。 */
async function savePlanRow(
  supabase: Supabase,
  userId: string,
  formData: FormData,
): Promise<{ recordId: string; householdId: string }> {
  const date = String(formData.get("record_date") || "");
  if (!DATE_RE.test(date)) throw new Error("不正なリクエストです");
  const source = toSource(formData.get("source"));
  const times = readTimes(formData);
  const body = String(formData.get("body") || "").trim();
  const who = readAssignees(formData, source);
  const repeat = String(formData.get("repeat") || "") === "1";

  const recordId = String(formData.get("record_id") || "").trim();
  let householdId: string;
  let targetId: string;

  if (UUID_RE.test(recordId)) {
    householdId = await requireEditableRecordHousehold(
      supabase,
      userId,
      recordId,
    );
    const { error } = await supabase
      .from("daycare_records")
      .update({ source, ...times, body, overrides_rule: true })
      .eq("id", recordId);
    if (error) throw new Error(`予定の保存に失敗しました: ${error.message}`);
    targetId = recordId;
  } else {
    householdId = await resolveWritableHousehold(supabase, userId, formData);
    const { data, error } = await supabase
      .from("daycare_records")
      .insert({
        owner_id: userId,
        household_id: householdId,
        record_date: date,
        source,
        status: "planned",
        ...times,
        body,
        overrides_rule: true,
      })
      .select("id")
      .single();
    if (error) throw new Error(`予定の保存に失敗しました: ${error.message}`);
    targetId = data.id as string;
  }

  await syncAssignees(
    supabase,
    "record_assignees",
    "record_id",
    targetId,
    householdId,
    who,
  );

  // その日を打ち消していたなら、予定を入れ直した時点で打ち消しは不要
  await supabase
    .from("schedule_rule_skips")
    .delete()
    .eq("household_id", householdId)
    .eq("on_date", date);

  if (repeat) {
    await applyRepeat(supabase, userId, householdId, {
      date,
      source,
      ...times,
      who,
    });
  }

  return { recordId: targetId, householdId };
}

/**
 * 予定を完了して記録にする。種類・時刻・担当はそのまま引き継ぐので、
 * ここで書き直すのは「あったこと（本文）」と写真だけ。
 */
export async function completePlan(formData: FormData) {
  const supabase = await createClient();
  const user = await requireUser(supabase);

  const body = String(formData.get("body") || "").trim();
  const recordId = String(formData.get("record_id") || "").trim();

  // ルール由来の予定を完了する場合は、この時点で実体にしてから記録にする
  // （種類・時刻・担当はフォームがそのまま運んでくる）
  const target = UUID_RE.test(recordId)
    ? recordId
    : (await savePlanRow(supabase, user.id, formData)).recordId;

  if (target === recordId) {
    await requireEditableRecordHousehold(supabase, user.id, recordId);
  }
  await markDone(supabase, target, body);
  revalidateSchedule();
}

async function markDone(supabase: Supabase, recordId: string, body: string) {
  const { error } = await supabase
    .from("daycare_records")
    .update({ status: "done", body })
    .eq("id", recordId);
  if (error) throw new Error(`記録の保存に失敗しました: ${error.message}`);
}

/** 見送り。行かなかった日も消さずに残す（カレンダーには取り消し線で出る）。 */
export async function skipPlan(recordId: string) {
  const supabase = await createClient();
  const user = await requireUser(supabase);
  if (!UUID_RE.test(recordId)) throw new Error("不正なリクエストです");
  await requireEditableRecordHousehold(supabase, user.id, recordId);
  const { error } = await supabase
    .from("daycare_records")
    .update({ status: "skipped" })
    .eq("id", recordId);
  if (error) throw new Error(`見送りにできませんでした: ${error.message}`);
  revalidateSchedule();
}

/** 見送り / 記録ずみを予定に戻す。 */
export async function reopenPlan(recordId: string) {
  const supabase = await createClient();
  const user = await requireUser(supabase);
  if (!UUID_RE.test(recordId)) throw new Error("不正なリクエストです");
  await requireEditableRecordHousehold(supabase, user.id, recordId);
  const { error } = await supabase
    .from("daycare_records")
    .update({ status: "planned" })
    .eq("id", recordId);
  if (error) throw new Error(`予定に戻せませんでした: ${error.message}`);
  revalidateSchedule();
}

/**
 * その日の予定を消す。
 * 実体の行なら削除し、曜日ルール由来ならその日だけの打ち消しを入れる
 * （ルールごと消すと、毎週の予定が全部消えてしまう）。
 */
export async function clearPlan(formData: FormData) {
  const supabase = await createClient();
  const user = await requireUser(supabase);

  const date = String(formData.get("record_date") || "");
  if (!DATE_RE.test(date)) throw new Error("不正なリクエストです");
  const recordId = String(formData.get("record_id") || "").trim();

  if (UUID_RE.test(recordId)) {
    await requireEditableRecordHousehold(supabase, user.id, recordId);
    const { error } = await supabase
      .from("daycare_records")
      .delete()
      .eq("id", recordId);
    if (error) throw new Error(`削除に失敗しました: ${error.message}`);
    revalidateSchedule();
    return;
  }

  const householdId = await resolveWritableHousehold(supabase, user.id, formData);
  const { error } = await supabase
    .from("schedule_rule_skips")
    .upsert(
      { household_id: householdId, on_date: date, created_by: user.id },
      { onConflict: "household_id,on_date" },
    );
  if (error) throw new Error(`打ち消しに失敗しました: ${error.message}`);
  revalidateSchedule();
}

/** 打ち消しを戻す（その日にまた毎週のルールが効くようにする）。 */
export async function restoreRuleForDate(formData: FormData) {
  const supabase = await createClient();
  const user = await requireUser(supabase);
  const date = String(formData.get("record_date") || "");
  if (!DATE_RE.test(date)) throw new Error("不正なリクエストです");
  const householdId = await resolveWritableHousehold(supabase, user.id, formData);
  const { error } = await supabase
    .from("schedule_rule_skips")
    .delete()
    .eq("household_id", householdId)
    .eq("on_date", date);
  if (error) throw new Error(`戻せませんでした: ${error.message}`);
  revalidateSchedule();
}

// ---------------------------------------------------------------
// 毎週の予定ルール
// ---------------------------------------------------------------

/**
 * 「これから毎週◯曜も同じにする」。since = その日の版を積む。
 * それ以降から効く古い版は畳む —— 残すと、次の週で前のルールに戻ってしまう。
 */
async function applyRepeat(
  supabase: Supabase,
  userId: string,
  householdId: string,
  input: {
    date: string;
    source: RecordSource;
    start_time: string | null;
    end_time: string | null;
    who: Partial<Record<AssigneeRole, string>>;
  },
) {
  const weekday = weekdayOf(input.date);
  await supabase
    .from("schedule_rules")
    .delete()
    .eq("household_id", householdId)
    .eq("weekday", weekday)
    .gte("since", input.date);

  const { data, error } = await supabase
    .from("schedule_rules")
    .insert({
      household_id: householdId,
      weekday,
      since: input.date,
      kind: input.source,
      start_time: input.start_time,
      end_time: input.end_time,
      created_by: userId,
    })
    .select("id")
    .single();
  if (error) throw new Error(`毎週のルールの保存に失敗しました: ${error.message}`);

  await syncAssignees(
    supabase,
    "schedule_rule_assignees",
    "rule_id",
    data.id as string,
    householdId,
    input.who,
  );
}

/**
 * ルール画面からの保存。今日から効く版として積む
 * （直接いじると過去の日まで書き換わるため、版を足す形しか用意しない）。
 */
export async function saveRule(formData: FormData) {
  const supabase = await createClient();
  const user = await requireUser(supabase);

  const weekday = Number(formData.get("weekday"));
  if (!Number.isInteger(weekday) || weekday < 0 || weekday > 6) {
    throw new Error("不正なリクエストです");
  }
  const since = String(formData.get("since") || "");
  if (!DATE_RE.test(since)) throw new Error("不正なリクエストです");

  const householdId = await resolveWritableHousehold(supabase, user.id, formData);
  const raw = String(formData.get("source") || "").trim();

  // 「なし」も日付つきの版で表す（それ以降なしの墓標）。過去は変わらない
  if (raw === "" || raw === "none") {
    await supabase
      .from("schedule_rules")
      .delete()
      .eq("household_id", householdId)
      .eq("weekday", weekday)
      .gte("since", since);
    const { error } = await supabase.from("schedule_rules").insert({
      household_id: householdId,
      weekday,
      since,
      kind: null,
      created_by: user.id,
    });
    if (error) throw new Error(`ルールの保存に失敗しました: ${error.message}`);
    revalidateSchedule();
    return;
  }

  const source = toSource(raw);
  const times = readTimes(formData);
  await applyRepeat(supabase, user.id, householdId, {
    date: since,
    source,
    ...times,
    who: readAssignees(formData, source),
  });
  revalidateSchedule();
}

/** ルールの担当だけを差し替える（ルール画面の顔タップ）。 */
export async function setRuleAssignee(
  ruleId: string,
  role: AssigneeRole,
  memberId: string | null,
) {
  const supabase = await createClient();
  const user = await requireUser(supabase);
  if (!UUID_RE.test(ruleId)) throw new Error("不正なリクエストです");
  if (!ASSIGNEE_ROLES.includes(role)) throw new Error("不正なリクエストです");

  const householdId = await requireEditableRuleHousehold(
    supabase,
    user.id,
    ruleId,
  );
  if (memberId === null) {
    await supabase
      .from("schedule_rule_assignees")
      .delete()
      .eq("rule_id", ruleId)
      .eq("role", role);
  } else {
    if (!UUID_RE.test(memberId)) throw new Error("不正なリクエストです");
    const { data } = await supabase
      .from("household_members")
      .select("user_id")
      .eq("household_id", householdId)
      .eq("user_id", memberId)
      .maybeSingle();
    if (!data) throw new Error("この世帯のメンバーではありません");
    const { error } = await supabase
      .from("schedule_rule_assignees")
      .upsert(
        { rule_id: ruleId, role, user_id: memberId },
        { onConflict: "rule_id,role" },
      );
    if (error) throw new Error(`担当の保存に失敗しました: ${error.message}`);
  }
  revalidateSchedule();
}

/** 予定の担当だけを差し替える（週のまとめ入力 / 日別シートの顔タップ）。 */
export async function setRecordAssignee(
  recordId: string,
  role: AssigneeRole,
  memberId: string | null,
) {
  const supabase = await createClient();
  const user = await requireUser(supabase);
  if (!UUID_RE.test(recordId)) throw new Error("不正なリクエストです");
  if (!ASSIGNEE_ROLES.includes(role)) throw new Error("不正なリクエストです");

  const householdId = await requireEditableRecordHousehold(
    supabase,
    user.id,
    recordId,
  );
  if (memberId === null) {
    await supabase
      .from("record_assignees")
      .delete()
      .eq("record_id", recordId)
      .eq("role", role);
  } else {
    if (!UUID_RE.test(memberId)) throw new Error("不正なリクエストです");
    const { data } = await supabase
      .from("household_members")
      .select("user_id")
      .eq("household_id", householdId)
      .eq("user_id", memberId)
      .maybeSingle();
    if (!data) throw new Error("この世帯のメンバーではありません");
    const { error } = await supabase
      .from("record_assignees")
      .upsert(
        { record_id: recordId, role, user_id: memberId },
        { onConflict: "record_id,role" },
      );
    if (error) throw new Error(`担当の保存に失敗しました: ${error.message}`);
  }
  revalidateSchedule();
}
