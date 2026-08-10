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
import { jstTodayISO } from "@/lib/dateRange";

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
  if (!data)
    throw new Error("ルールが見つかりません（または権限がありません）");
  const role = await getRoleInHousehold(supabase, userId, data.household_id);
  if (role && !canEdit(role)) {
    throw new Error(
      "閲覧のみの権限（viewer）のため、追加・編集・削除はできません",
    );
  }
  return data.household_id;
}

/**
 * 予定に紐づけるペット。フォームで選ばれていればそれを、無ければ世帯にペットが
 * 1 頭だけのときに自動で当てる（完了すると記録になるので、ペットが付いていないと
 * どの子の記録か分からず、ゲスト共有の対象にもできない）。
 */
async function resolvePetId(
  supabase: Supabase,
  householdId: string,
  formData: FormData,
): Promise<string | null> {
  const petId = String(formData.get("pet_id") || "").trim();
  if (UUID_RE.test(petId)) {
    const { data } = await supabase
      .from("pets")
      .select("id")
      .eq("id", petId)
      .eq("household_id", householdId)
      .maybeSingle();
    if (data) return petId;
  }
  const { data: pets } = await supabase
    .from("pets")
    .select("id")
    .eq("household_id", householdId)
    .limit(2);
  return pets && pets.length === 1 ? (pets[0].id as string) : null;
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

  const keep = ASSIGNEE_ROLES.filter(
    (role) => who[role] && members.has(who[role] as string),
  );
  const rows = keep.map((role) => ({
    [key]: ownerRowId,
    role,
    user_id: who[role] as string,
  }));

  // 先に入れてから、残らなかった役割だけ消す。逆順にすると、insert が失敗した
  // ときに「保存に失敗したのに前の担当も消えている」状態になる
  if (rows.length > 0) {
    const { error } = await supabase
      .from(table)
      .upsert(rows, { onConflict: `${key},role` });
    if (error) throw new Error(`担当の保存に失敗しました: ${error.message}`);
  }
  const stale = ASSIGNEE_ROLES.filter((role) => !keep.includes(role));
  if (stale.length > 0) {
    const { error } = await supabase
      .from(table)
      .delete()
      .eq(key, ownerRowId)
      .in("role", stale);
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

/**
 * savePlan の中身。作った / 更新した行の id を返す（完了・見送りの経路からも使う）。
 * nextStatus を渡すと、保存と状態変更を **1 文**で行う —— 分けて投げると、
 * 状態変更だけ失敗したときに「予定が増えたのに完了していない」行が残る。
 */
async function savePlanRow(
  supabase: Supabase,
  userId: string,
  formData: FormData,
  nextStatus?: "planned" | "done" | "skipped",
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
  /** この行がその日の毎週のルールを置き換えるか */
  let overridesRule: boolean;

  if (UUID_RE.test(recordId)) {
    householdId = await requireEditableRecordHousehold(
      supabase,
      userId,
      recordId,
    );
    // 保存済みの行は overrides_rule をそのまま保つ。ルール由来を上書きするのは
    // 「実体の無い日を開いて保存した」ときだけで、それは下の insert が担う。
    // ここで立て直すと、「もう 1 件足す」で足した予定を直しただけで
    // その日の毎週のルールが黙って消える
    const { data: current } = await supabase
      .from("daycare_records")
      .select("overrides_rule")
      .eq("id", recordId)
      .maybeSingle();
    overridesRule = Boolean(current?.overrides_rule);
    const { error } = await supabase
      .from("daycare_records")
      .update({
        source,
        ...times,
        body,
        overrides_rule: overridesRule,
        ...(nextStatus ? { status: nextStatus } : {}),
      })
      .eq("id", recordId);
    if (error) throw new Error(`予定の保存に失敗しました: ${error.message}`);
    targetId = recordId;
  } else {
    householdId = await resolveWritableHousehold(supabase, userId, formData);
    const petId = await resolvePetId(supabase, householdId, formData);
    overridesRule = String(formData.get("additional") || "") !== "1";
    const { data, error } = await supabase
      .from("daycare_records")
      .insert({
        owner_id: userId,
        household_id: householdId,
        record_date: date,
        source,
        status: nextStatus ?? "planned",
        ...times,
        body,
        pet_id: petId,
        // 「もう 1 件足す」で作る予定は、その日の毎週のルールを隠さない
        // （足したつもりが、毎週の保育園を消してしまう）
        overrides_rule: overridesRule,
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

  // その日を打ち消していたなら、**ルールを置き換える行**を入れたときだけ打ち消しを外す。
  // 「もう 1 件足す」で並べた予定まで打ち消しを消すと、消したはずの
  // 毎週の予定が黙って戻ってくる
  if (overridesRule) {
    await supabase
      .from("schedule_rule_skips")
      .delete()
      .eq("household_id", householdId)
      .eq("on_date", date);
  }

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

  // 完了も保存を通す。ここを飛ばすと、同じフォームで直した種類・時刻・担当が
  // 黙って捨てられる（ルール由来はこの保存で実体になる）。
  // 状態は同じ 1 文で done にするので、「行はできたが完了していない」は起きない
  await savePlanRow(supabase, user.id, formData, "done");
  revalidateSchedule();
}

/**
 * 見送り。行かなかった日も消さずに残す（カレンダーには取り消し線で出る）。
 * 曜日ルール由来の予定はまだ行が無いので、完了と同じくここで実体にしてから落とす。
 */
export async function skipPlan(formData: FormData) {
  const supabase = await createClient();
  const user = await requireUser(supabase);

  await savePlanRow(supabase, user.id, formData, "skipped");
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

  const householdId = await resolveWritableHousehold(
    supabase,
    user.id,
    formData,
  );
  const { error } = await supabase
    .from("schedule_rule_skips")
    // 同じ日を 2 度消しても通るように、衝突は無視する（update ポリシーは無い）
    .upsert(
      { household_id: householdId, on_date: date, created_by: user.id },
      { onConflict: "household_id,on_date", ignoreDuplicates: true },
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
  const householdId = await resolveWritableHousehold(
    supabase,
    user.id,
    formData,
  );
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
    /** 省略時は date の曜日（日別シートの「これから毎週」経路） */
    weekday?: number;
    source: RecordSource;
    start_time: string | null;
    end_time: string | null;
    who: Partial<Record<AssigneeRole, string>>;
  },
) {
  const weekday = input.weekday ?? weekdayOf(input.date);
  // 「これから毎週」なので、過去の日から積まない（過去の版を消せてしまうと、
  // その版が効いていた日のカレンダーが変わる。RLS 側も今日以降しか作らせない）
  const today = jstTodayISO();
  const since = input.date < today ? today : input.date;

  // 差し替えは 1 トランザクション。分けて投げると、作成に失敗したときに
  // 版が消えたままになり、以降の予定が前の版や「なし」に落ちる
  const who = Object.fromEntries(
    ASSIGNEE_ROLES.filter((role) => input.who[role]).map((role) => [
      role,
      input.who[role] as string,
    ]),
  );
  const { error } = await supabase.rpc("replace_schedule_rule", {
    p_household: householdId,
    p_weekday: weekday,
    p_since: since,
    p_kind: input.source,
    p_start: input.start_time,
    p_end: input.end_time,
    p_assignees: who,
  });
  if (error) {
    throw new Error(`毎週のルールの保存に失敗しました: ${error.message}`);
  }
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

  const householdId = await resolveWritableHousehold(
    supabase,
    user.id,
    formData,
  );
  const raw = String(formData.get("source") || "").trim();

  // 「なし」も日付つきの版で表す（それ以降なしの墓標）。過去は変わらない
  if (raw === "" || raw === "none") {
    const { error } = await supabase.rpc("replace_schedule_rule", {
      p_household: householdId,
      p_weekday: weekday,
      p_since: since,
      p_kind: null, // それ以降なしを表す墓標
      p_start: null,
      p_end: null,
      p_assignees: {},
    });
    if (error) throw new Error(`ルールの保存に失敗しました: ${error.message}`);
    revalidateSchedule();
    return;
  }

  const source = toSource(raw);
  const times = readTimes(formData);
  await applyRepeat(supabase, user.id, householdId, {
    date: since,
    // ルール画面は「今日から」の版として積むので、since の曜日ではなく
    // 画面で選んだ曜日を使う（日曜に月曜の枠を触ると日曜が書き換わっていた）
    weekday,
    source,
    ...times,
    who: readAssignees(formData, source),
  });
  revalidateSchedule();
}

/**
 * その曜日の「今日から効く版」を用意して返す。直近の版が今日より前から効いている
 * なら、その複製を今日の版として積む（直接いじると過去の日まで書き換わる）。
 */
async function editableRuleVersion(
  supabase: Supabase,
  userId: string,
  householdId: string,
  weekday: number,
  today: string,
): Promise<string | null> {
  const { data: versions } = await supabase
    .from("schedule_rules")
    .select("id, since, kind, start_time, end_time")
    .eq("household_id", householdId)
    .eq("weekday", weekday)
    .lte("since", today)
    .order("since", { ascending: false })
    .limit(1);
  const latest = versions?.[0];
  if (!latest || !latest.kind) return null;
  if (latest.since === today) return latest.id as string;

  const { data: who } = await supabase
    .from("schedule_rule_assignees")
    .select("role, user_id")
    .eq("rule_id", latest.id);

  // 未来から効く版は畳んでから、今日の版として積む
  await supabase
    .from("schedule_rules")
    .delete()
    .eq("household_id", householdId)
    .eq("weekday", weekday)
    .gte("since", today);

  const { data: created, error } = await supabase
    .from("schedule_rules")
    .insert({
      household_id: householdId,
      weekday,
      since: today,
      kind: latest.kind,
      start_time: latest.start_time,
      end_time: latest.end_time,
      created_by: userId,
    })
    .select("id")
    .single();
  if (error) throw new Error(`ルールの更新に失敗しました: ${error.message}`);

  const rows = (who ?? []).map((a) => ({
    rule_id: created.id as string,
    role: a.role,
    user_id: a.user_id,
  }));
  if (rows.length > 0) {
    await supabase.from("schedule_rule_assignees").insert(rows);
  }
  return created.id as string;
}

/** ルールの担当だけを差し替える（ルール画面の顔タップ）。 */
export async function setRuleAssignee(
  ruleId: string,
  role: AssigneeRole,
  memberId: string | null,
  today: string,
) {
  const supabase = await createClient();
  const user = await requireUser(supabase);
  if (!UUID_RE.test(ruleId)) throw new Error("不正なリクエストです");
  if (!ASSIGNEE_ROLES.includes(role)) throw new Error("不正なリクエストです");
  if (!DATE_RE.test(today)) throw new Error("不正なリクエストです");

  const householdId = await requireEditableRuleHousehold(
    supabase,
    user.id,
    ruleId,
  );
  // 過去から効いている版をそのまま書き換えると、その版が効いていた日の担当まで
  // 変わってしまう。今日から効く版に付け替えてから差し替える
  const { data: base } = await supabase
    .from("schedule_rules")
    .select("weekday")
    .eq("id", ruleId)
    .maybeSingle();
  if (!base) throw new Error("ルールが見つかりません");
  const editable = await editableRuleVersion(
    supabase,
    user.id,
    householdId,
    Number(base.weekday),
    today,
  );
  if (!editable) throw new Error("この曜日にはルールがありません");
  ruleId = editable;
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
