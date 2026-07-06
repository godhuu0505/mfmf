import Link from "next/link";
import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { getCurrentMembership, listCurrentMemberships } from "@/lib/household";
import { createAvatarSignedUrl } from "@/lib/avatars";
import AppHeader from "@/components/AppHeader";
import AvatarUploader from "@/components/AvatarUploader";
import SubmitButton from "@/components/SubmitButton";
import {
  createGuestInvite,
  createInvite,
  deleteHousehold,
  leaveHousehold,
  removeMember,
  renameHousehold,
  revokeGuestGrant,
  revokeInvite,
  switchHousehold,
  updateHouseholdAvatar,
  updateMemberRole,
} from "@/app/settings/actions";
import DeleteHouseholdForm from "@/app/settings/DeleteHouseholdForm";

export const dynamic = "force-dynamic";

const ROLE_LABEL: Record<string, string> = {
  owner: "owner（全権・メンバー管理）",
  editor: "editor（記録の追加・編集）",
  viewer: "viewer（閲覧のみ）",
};

// 招待一覧・ゲスト一覧で使う短い role 表示（内部 role + ゲスト種別）。
const SHORT_ROLE_LABEL: Record<string, string> = {
  owner: "owner",
  editor: "editor",
  viewer: "viewer",
  "guest:daycare": "ゲスト（保育園）",
  "guest:sitter": "ゲスト（シッター）",
};

export const metadata = { title: "世帯の設定" };

export default async function SettingsPage() {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) redirect("/login");

  // 世帯セクション（Phase 3.5 S2 #46）: 世帯名・メンバー一覧・ロール変更（owner のみ）。
  // メンバー一覧は RLS（household_members_select_member）で自世帯分のみ返る。
  const membership = await getCurrentMembership(supabase);
  const isOwner = membership?.role === "owner";
  const [{ data: household }, { data: members }, memberships] = membership
    ? await Promise.all([
        supabase
          .from("households")
          .select("id, name, avatar_path")
          .eq("id", membership.householdId)
          .maybeSingle(),
        // メール・表示名は個人スコープ（UC-M03）のため、世帯メンバーに限って返す
        // SECURITY DEFINER 関数で解決する。
        supabase.rpc("get_household_members", {
          p_household: membership.householdId,
        }),
        listCurrentMemberships(supabase),
      ])
    : [{ data: null }, { data: null }, []];
  const memberRows = ((members as unknown) ?? []) as {
    user_id: string;
    role: string;
    created_at: string;
    email: string | null;
    display_name: string | null;
  }[];
  const householdData = household as
    | { id: string; name: string; avatar_path: string | null }
    | null;
  const householdAvatarUrl = await createAvatarSignedUrl(
    householdData?.avatar_path ?? null,
  );

  // 招待一覧（owner のみ。RLS invites_select_owner が強制）。
  // ゲスト管理（S4 / UC-G01）用にペット一覧とゲスト付与一覧も owner のみ取得する。
  const [{ data: invites }, { data: householdPets }, { data: guests }] =
    membership && isOwner
      ? await Promise.all([
          supabase
            .from("household_invites")
            .select("id, email, role, token, expires_at, accepted_at, revoked_at")
            .eq("household_id", membership.householdId)
            .order("created_at", { ascending: false })
            .limit(20),
          supabase
            .from("pets")
            .select("id, name")
            .eq("household_id", membership.householdId)
            .order("created_at", { ascending: true }),
          // ゲストのメール解決は owner 限定の SECURITY DEFINER 関数で行う。
          supabase.rpc("get_household_guests", {
            p_household: membership.householdId,
          }),
        ])
      : [{ data: null }, { data: null }, { data: null }];
  const guestRows = ((guests as unknown) ?? []) as {
    id: string;
    user_id: string;
    email: string | null;
    scope_pet_id: string;
    role: string;
    valid_from: string;
    valid_to: string | null;
    revoked_at: string | null;
    created_at: string;
  }[];
  const petNameById = new Map((householdPets ?? []).map((p) => [p.id, p.name]));

  // 世帯削除（UC-H09）の出し分け: 参照データが無い世帯だけ削除できる。
  // pets / invites / guests は上で取得済み。記録件数だけ head+count で軽く確認する
  // （tags・feedback 等の稀な残存は RPC delete_own_household 側が最終的に拒否する）。
  const { count: recordCount } =
    membership && isOwner
      ? await supabase
          .from("daycare_records")
          .select("id", { count: "exact", head: true })
          .eq("household_id", membership.householdId)
      : { count: 0 };
  const householdEmpty =
    isOwner &&
    (householdPets?.length ?? 0) === 0 &&
    (recordCount ?? 0) === 0 &&
    (invites?.length ?? 0) === 0 &&
    guestRows.length === 0;

  const guestStatus = (g: {
    valid_from: string;
    valid_to: string | null;
    revoked_at: string | null;
  }): string => {
    if (g.revoked_at) return "失効済み";
    const today = new Date().toISOString().slice(0, 10);
    if (g.valid_from > today) return "開始前";
    if (g.valid_to && g.valid_to < today) return "期間終了";
    return "有効";
  };

  const inviteStatus = (inv: {
    expires_at: string;
    accepted_at: string | null;
    revoked_at: string | null;
  }): string => {
    if (inv.accepted_at) return "受諾済み";
    if (inv.revoked_at) return "取消済み";
    if (new Date(inv.expires_at).getTime() < Date.now()) return "期限切れ";
    return "有効";
  };

  return (
    <>
      <AppHeader />
      <main id="main" className="mx-auto max-w-2xl px-4 py-6">
        <div className="mb-4">
          <Link
            href="/settings/account"
            className="text-sm text-muted-foreground hover:text-foreground"
          >
            ← アカウント設定へ戻る
          </Link>
        </div>
        <h1 className="mb-6 text-xl font-bold text-foreground">世帯の設定</h1>

        <div className="space-y-6">
          {/* 世帯に未所属なら、世帯の作成へ誘導する */}
          {!membership && (
            <section className="space-y-3 rounded-2xl bg-surface p-5 shadow-sm ring-1 ring-border">
              <div>
                <h2 className="text-base font-bold text-foreground">
                  まだ世帯がありません
                </h2>
                <p className="mt-0.5 text-sm text-muted-foreground">
                  記録・写真・ペットを家族と共有するには、世帯を作成してください。
                </p>
              </div>
              <Link
                href="/onboarding"
                className="inline-block rounded-lg bg-primary px-4 py-2 text-sm font-medium text-primary-foreground transition hover:bg-primary-hover"
              >
                世帯を作成する
              </Link>
            </section>
          )}

          {/* 世帯（household）: 名前・メンバー・ロール（Phase 3.5 S2） */}
          {membership && (
            <section className="space-y-4 rounded-2xl bg-surface p-5 shadow-sm ring-1 ring-border">
              <div>
                <h2 className="text-base font-bold text-foreground">世帯</h2>
                <p className="mt-0.5 text-sm text-muted-foreground">
                  記録・写真・ペットは世帯のメンバーで共有されます。あなたのロール:{" "}
                  {ROLE_LABEL[membership.role] ?? membership.role}
                </p>
              </div>

              {memberships.length > 1 && (
                <div>
                  <h3 className="mb-2 text-sm font-medium text-foreground">
                    世帯を切り替え（UC-H08）
                  </h3>
                  <ul className="space-y-2">
                    {memberships.map((m) => (
                      <li
                        key={m.householdId}
                        className="flex flex-wrap items-center justify-between gap-2 rounded-lg bg-surface-muted px-3 py-2 text-sm"
                      >
                        <span className="text-foreground">
                          {m.householdName || "（名前未設定の世帯）"} ・ {m.role}
                          {m.householdId === membership.householdId
                            ? "（表示中）"
                            : ""}
                        </span>
                        {m.householdId !== membership.householdId && (
                          <form action={switchHousehold.bind(null, m.householdId)}>
                            <SubmitButton
                              pendingLabel="切替中…"
                              className="rounded-lg border border-border px-3 py-1 text-sm font-medium text-foreground transition hover:bg-muted disabled:opacity-60"
                            >
                              この世帯を表示
                            </SubmitButton>
                          </form>
                        )}
                      </li>
                    ))}
                  </ul>
                </div>
              )}

              {isOwner ? (
                <form
                  action={renameHousehold.bind(null, membership.householdId)}
                  className="flex items-end gap-2"
                >
                  <div className="flex-1">
                    <label
                      htmlFor="household_name"
                      className="mb-1 block text-sm font-medium text-foreground"
                    >
                      世帯の名前
                    </label>
                    <input
                      id="household_name"
                      name="household_name"
                      type="text"
                      defaultValue={household?.name ?? ""}
                      placeholder="例: うちの家族"
                      className="w-full rounded-lg border border-border px-3 py-2 text-foreground outline-none focus:border-muted-foreground focus:ring-1 focus:ring-muted-foreground"
                    />
                  </div>
                  <SubmitButton
                    pendingLabel="保存中…"
                    className="rounded-lg bg-primary px-4 py-2 text-sm font-medium text-primary-foreground transition hover:bg-primary-hover disabled:opacity-60"
                  >
                    保存
                  </SubmitButton>
                </form>
              ) : (
                <p className="rounded-lg bg-surface-muted px-3 py-2 text-sm text-foreground">
                  世帯の名前: {household?.name || "（未設定）"}
                </p>
              )}

              {/* 世帯のアバター画像（owner のみ変更可・世帯で共有） */}
              <AvatarUploader
                scopeId={membership.householdId}
                currentUrl={householdAvatarUrl}
                action={updateHouseholdAvatar.bind(null, membership.householdId)}
                alt="世帯のアバター"
                label="世帯の画像"
                disabled={!isOwner}
              />

              <div>
                <h3 className="mb-2 text-sm font-medium text-foreground">メンバー</h3>
                <ul className="space-y-2">
                  {memberRows.map((m) => (
                    <li
                      key={m.user_id}
                      className="flex flex-wrap items-center justify-between gap-2 rounded-lg bg-surface-muted px-3 py-2 text-sm"
                    >
                      <span className="text-foreground">
                        {m.display_name || m.email || `メンバー ${m.user_id.slice(0, 8)}…`}
                        {m.user_id === user.id ? "（自分）" : ""}
                      </span>
                      {isOwner && m.user_id !== user.id ? (
                        <div className="flex items-center gap-2">
                          <form
                            action={updateMemberRole.bind(
                              null,
                              membership.householdId,
                              m.user_id,
                            )}
                            className="flex items-center gap-2"
                          >
                            <select
                              name="role"
                              defaultValue={m.role}
                              className="rounded-lg border border-border px-2 py-1 text-sm text-foreground"
                            >
                              <option value="owner">owner</option>
                              <option value="editor">editor</option>
                              <option value="viewer">viewer</option>
                            </select>
                            <SubmitButton
                              pendingLabel="変更中…"
                              className="rounded-lg border border-border px-3 py-1 text-sm font-medium text-foreground transition hover:bg-muted disabled:opacity-60"
                            >
                              変更
                            </SubmitButton>
                          </form>
                          <form
                            action={removeMember.bind(
                              null,
                              membership.householdId,
                              m.user_id,
                            )}
                          >
                            <SubmitButton
                              pendingLabel="削除中…"
                              className="text-xs text-red-600 transition hover:text-red-800 disabled:opacity-60"
                            >
                              削除
                            </SubmitButton>
                          </form>
                        </div>
                      ) : (
                        <span className="text-muted-foreground">{m.role}</span>
                      )}
                    </li>
                  ))}
                </ul>
                <p className="mt-2 text-xs text-muted-foreground">
                  削除・退出しても、その人が書いた記録は世帯に残ります。
                  世帯には最低 1 人の owner が必要です（最後の owner は降格・退出できません）。
                </p>
                <form
                  action={leaveHousehold.bind(null, membership.householdId)}
                  className="mt-3"
                >
                  <SubmitButton
                    pendingLabel="退出中…"
                    className="text-xs text-red-600 transition hover:text-red-800 disabled:opacity-60"
                  >
                    この世帯から退出する
                  </SubmitButton>
                </form>
              </div>

              {/* 招待（owner のみ / UC-O09〜O11。宛先メール固定 D12） */}
              {isOwner && (
                <div className="border-t border-border pt-4">
                  <h3 className="mb-2 text-sm font-medium text-foreground">
                    メンバーを招待
                  </h3>
                  <form
                    action={createInvite.bind(null, membership.householdId)}
                    className="flex flex-wrap items-end gap-2"
                  >
                    <div className="flex-1 min-w-[12rem]">
                      <label
                        htmlFor="invite_email"
                        className="mb-1 block text-xs text-muted-foreground"
                      >
                        宛先メールアドレス（このアドレスのアカウントだけが参加できます）
                      </label>
                      <input
                        id="invite_email"
                        name="invite_email"
                        type="email"
                        required
                        placeholder="family@example.com"
                        className="w-full rounded-lg border border-border px-3 py-2 text-sm text-foreground outline-none focus:border-muted-foreground focus:ring-1 focus:ring-muted-foreground"
                      />
                    </div>
                    <select
                      name="invite_role"
                      defaultValue="editor"
                      className="rounded-lg border border-border px-2 py-2 text-sm text-foreground"
                    >
                      <option value="editor">editor（編集可）</option>
                      <option value="viewer">viewer（閲覧のみ）</option>
                    </select>
                    <SubmitButton
                      pendingLabel="発行中…"
                      className="rounded-lg bg-primary px-4 py-2 text-sm font-medium text-primary-foreground transition hover:bg-primary-hover disabled:opacity-60"
                    >
                      招待を発行
                    </SubmitButton>
                  </form>

                  {(invites ?? []).length > 0 && (
                    <ul className="mt-3 space-y-2">
                      {(invites ?? []).map((inv) => (
                        <li
                          key={inv.id}
                          className="rounded-lg bg-surface-muted px-3 py-2 text-sm"
                        >
                          <div className="flex flex-wrap items-center justify-between gap-2">
                            <span className="text-foreground">
                              {inv.email}（{SHORT_ROLE_LABEL[inv.role] ?? inv.role}） ・{" "}
                              {inviteStatus(inv)}
                            </span>
                            {inviteStatus(inv) === "有効" && (
                              <form
                                action={revokeInvite.bind(
                                  null,
                                  membership.householdId,
                                  inv.id,
                                )}
                              >
                                <SubmitButton
                                  pendingLabel="取消中…"
                                  className="text-xs text-red-600 transition hover:text-red-800 disabled:opacity-60"
                                >
                                  取り消す
                                </SubmitButton>
                              </form>
                            )}
                          </div>
                          {inviteStatus(inv) === "有効" && (
                            <p className="mt-1 break-all text-xs text-muted-foreground">
                              招待リンク: /invite/{inv.token}
                              （このリンクを本人に共有してください）
                            </p>
                          )}
                        </li>
                      ))}
                    </ul>
                  )}
                </div>
              )}

              {/* 外部ゲスト（保育園/シッター・S4 / UC-G01〜G04）: owner のみ */}
              {isOwner && (
                <div className="border-t border-border pt-4">
                  <h3 className="mb-1 text-sm font-medium text-foreground">
                    外部ゲスト（保育園・シッター）
                  </h3>
                  <p className="mb-2 text-xs text-muted-foreground">
                    対象のペット 1 匹と期間を限定して招待します。ゲストに見えるのは
                    担当ペットのプロフィールと、期間内の「ゲストに共有」した記録・
                    ゲスト自身の記入だけです（写真・他のペット・世帯情報は見えません）。
                  </p>

                  {(householdPets ?? []).length === 0 ? (
                    <p className="rounded-lg bg-surface-muted px-3 py-2 text-sm text-muted-foreground">
                      ゲストを招待するには、先にペットを登録してください。
                    </p>
                  ) : (
                    <form
                      action={createGuestInvite.bind(null, membership.householdId)}
                      className="flex flex-wrap items-end gap-2"
                    >
                      <div className="flex-1 min-w-[12rem]">
                        <label
                          htmlFor="guest_email"
                          className="mb-1 block text-xs text-muted-foreground"
                        >
                          宛先メールアドレス
                        </label>
                        <input
                          id="guest_email"
                          name="guest_email"
                          type="email"
                          required
                          placeholder="daycare@example.com"
                          className="w-full rounded-lg border border-border px-3 py-2 text-sm text-foreground outline-none focus:border-muted-foreground focus:ring-1 focus:ring-muted-foreground"
                        />
                      </div>
                      <div>
                        <label
                          htmlFor="guest_pet_id"
                          className="mb-1 block text-xs text-muted-foreground"
                        >
                          対象ペット
                        </label>
                        <select
                          id="guest_pet_id"
                          name="guest_pet_id"
                          required
                          className="rounded-lg border border-border px-2 py-2 text-sm text-foreground"
                        >
                          {(householdPets ?? []).map((p) => (
                            <option key={p.id} value={p.id}>
                              {p.name}
                            </option>
                          ))}
                        </select>
                      </div>
                      <div>
                        <label
                          htmlFor="guest_role"
                          className="mb-1 block text-xs text-muted-foreground"
                        >
                          種別
                        </label>
                        <select
                          id="guest_role"
                          name="guest_role"
                          defaultValue="guest:daycare"
                          className="rounded-lg border border-border px-2 py-2 text-sm text-foreground"
                        >
                          <option value="guest:daycare">保育園</option>
                          <option value="guest:sitter">シッター</option>
                        </select>
                      </div>
                      <div>
                        <label
                          htmlFor="guest_valid_from"
                          className="mb-1 block text-xs text-muted-foreground"
                        >
                          開始日（省略時は受諾日）
                        </label>
                        <input
                          id="guest_valid_from"
                          name="guest_valid_from"
                          type="date"
                          className="rounded-lg border border-border px-2 py-1.5 text-sm text-foreground"
                        />
                      </div>
                      <div>
                        <label
                          htmlFor="guest_valid_to"
                          className="mb-1 block text-xs text-muted-foreground"
                        >
                          終了日（省略時は失効まで）
                        </label>
                        <input
                          id="guest_valid_to"
                          name="guest_valid_to"
                          type="date"
                          className="rounded-lg border border-border px-2 py-1.5 text-sm text-foreground"
                        />
                      </div>
                      <SubmitButton
                        pendingLabel="発行中…"
                        className="rounded-lg bg-primary px-4 py-2 text-sm font-medium text-primary-foreground transition hover:bg-primary-hover disabled:opacity-60"
                      >
                        ゲスト招待を発行
                      </SubmitButton>
                    </form>
                  )}

                  {guestRows.length > 0 && (
                    <ul className="mt-3 space-y-2">
                      {guestRows.map((g) => (
                        <li
                          key={g.id}
                          className="flex flex-wrap items-center justify-between gap-2 rounded-lg bg-surface-muted px-3 py-2 text-sm"
                        >
                          <span className="text-foreground">
                            {g.email ?? `ゲスト ${g.user_id.slice(0, 8)}…`}（
                            {SHORT_ROLE_LABEL[g.role] ?? g.role} /{" "}
                            {petNameById.get(g.scope_pet_id) ?? "不明なペット"}） ・{" "}
                            {g.valid_from} 〜 {g.valid_to ?? "失効まで"} ・{" "}
                            {guestStatus(g)}
                          </span>
                          {!g.revoked_at && (
                            <form
                              action={revokeGuestGrant.bind(
                                null,
                                membership.householdId,
                                g.id,
                              )}
                            >
                              <SubmitButton
                                pendingLabel="失効中…"
                                className="text-xs text-red-600 transition hover:text-red-800 disabled:opacity-60"
                              >
                                失効させる
                              </SubmitButton>
                            </form>
                          )}
                        </li>
                      ))}
                    </ul>
                  )}
                </div>
              )}

              {/* 世帯の削除（owner のみ / UC-H09）。参照データの無い世帯だけ削除できる。 */}
              {isOwner && (
                <div className="border-t border-border pt-4">
                  <h3 className="mb-1 text-sm font-medium text-red-600">
                    世帯を削除する
                  </h3>
                  {householdEmpty ? (
                    <>
                      <p className="mb-2 text-xs text-muted-foreground">
                        記録・写真・ペットなどのデータが無いこの世帯を削除します。
                        削除すると元に戻せません。
                      </p>
                      <DeleteHouseholdForm
                        action={deleteHousehold.bind(null, membership.householdId)}
                        householdName={household?.name ?? ""}
                      />
                    </>
                  ) : (
                    <p className="text-xs text-muted-foreground">
                      記録・ペットなどのデータがある世帯は、まだ削除できません。
                      データをエクスポートしてから世帯・アカウントを削除する導線は
                      準備中です（#51）。
                    </p>
                  )}
                </div>
              )}
            </section>
          )}
        </div>
      </main>
    </>
  );
}
