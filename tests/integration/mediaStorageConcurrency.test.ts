// Real PostgreSQL locks, synthetic identities only. File-parallelism is disabled
// by the integration config. No Storage bytes or cloud requests are made.
import { randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Client } from "pg";
import { DB_URL } from "./env";

const admin = new Client({ connectionString: DB_URL });
const first = new Client({ connectionString: DB_URL });
const second = new Client({ connectionString: DB_URL });
const owner = randomUUID();
const editor = randomUUID();
const household = randomUUID();
const record = randomUUID();
let secondPid: number;
let initialized = false;

async function asUser(db: Client, user: string) {
  await db.query("begin; set local role authenticated");
  await db.query("select set_config('request.jwt.claims',$1,true)", [JSON.stringify({ sub: user, role: "authenticated" })]);
}
async function waitForLock() {
  for (let i = 0; i < 100; i++) {
    const { rows } = await admin.query("select cardinality(pg_blocking_pids($1)) > 0 blocked", [secondPid]);
    if (rows[0].blocked) return;
    await delay(10);
  }
  throw new Error("Expected concurrent operation to wait for a PostgreSQL lock");
}
async function reserve(db: Client) {
  const { rows } = await db.query("select public.reserve_media_upload('photo',$1,$2,100,'image/jpeg') asset", [record, household]);
  return rows[0].asset as { id: string };
}

beforeAll(async () => {
  // A configuration mistake must never run a backend-switch test on production.
  const url = new URL(DB_URL);
  if (!["127.0.0.1", "localhost"].includes(url.hostname) || url.port !== "54322") throw new Error("Local Supabase only");
  await Promise.all([admin.connect(), first.connect(), second.connect()]);
  expect((await admin.query("select public.get_media_storage_mode() mode")).rows[0].mode).toBe("supabase");
  secondPid = (await second.query("select pg_backend_pid() pid")).rows[0].pid;
  await admin.query("insert into auth.users(id,email) values($1,$2),($3,$4)", [owner, `lock-owner-${owner}@test.local`, editor, `lock-editor-${editor}@test.local`]);
  await admin.query("insert into public.households(id,name) values($1,'media concurrency fixture')", [household]);
  await admin.query("insert into public.household_members(household_id,user_id,role) values($1,$2,'owner'),($1,$3,'editor')", [household, owner, editor]);
  await admin.query("insert into public.daycare_records(id,owner_id,household_id) values($1,$2,$3)", [record, owner, household]);
  initialized = true;
});
afterAll(async () => {
  await Promise.allSettled([first.query("rollback"), second.query("rollback")]);
  if (initialized) {
    // Keep immutable synthetic tombstones, as production does. Remove every live
    // fixture reference/reservation; no trigger is disabled to erase history.
    await admin.query("delete from public.daycare_records where id=$1", [record]);
    await admin.query("update public.media_assets set state='deleted',deleted_at=now() where (household_id=$1 or created_by=$2) and state<>'deleted'", [household, editor]);
    await admin.query("select public.set_media_storage_mode('frozen'); select public.set_media_storage_mode('supabase')");
  }
  await Promise.allSettled([admin.end(), first.end(), second.end()]);
});

describe("media storage transaction boundaries", () => {
  it("rejects an old Storage request queued behind the freeze table lock", async () => {
    await first.query("begin; select public.set_media_storage_mode('frozen')");
    await asUser(second, editor);
    const pending = second.query("insert into storage.objects(bucket_id,name) values('avatars',$1)", [`${editor}/avatars/queued.jpg`])
      .then(() => ({ code: "unexpected success" }), (error: { code: string }) => ({ code: error.code }));
    await waitForLock();
    await first.query("commit");
    expect(await pending).toEqual({ code: "42501" });
    await second.query("rollback");
    await admin.query("select public.set_media_storage_mode('gcs')");
  });

  it("keeps role revocation behind a reservation and rechecks it on publish", async () => {
    await asUser(first, editor);
    const asset = await reserve(first);
    await second.query("begin");
    const pending = second.query("update public.household_members set role='viewer' where household_id=$1 and user_id=$2", [household, editor]);
    await waitForLock();
    await first.query("commit");
    await pending;
    await second.query("commit");
    await asUser(first, editor);
    await expect(first.query("select public.commit_media_upload($1,'901')", [asset.id])).rejects.toMatchObject({ code: "42501" });
    await first.query("rollback");
    await admin.query("update public.household_members set role='editor' where household_id=$1 and user_id=$2", [household, editor]);
  });

  it("serializes two avatar replacements and refuses the stale CAS", async () => {
    await asUser(first, editor);
    const { rows } = await first.query("select public.reserve_media_upload('profile',$1,null,100,'image/png') asset", [editor]);
    const firstId = rows[0].asset.id;
    const secondId = (await first.query("select public.reserve_media_upload('profile',$1,null,100,'image/png') asset", [editor])).rows[0].asset.id;
    await first.query("commit");
    await asUser(first, editor);
    await first.query("select public.commit_media_upload($1,'910')", [firstId]);
    await asUser(second, editor);
    const pending = second.query("select public.commit_media_upload($1,'911')", [secondId])
      .then(() => ({ code: "unexpected success" }), (error: { code: string }) => ({ code: error.code }));
    await waitForLock();
    await first.query("commit");
    expect(await pending).toEqual({ code: "40001" });
    await second.query("rollback");
    expect((await admin.query("select avatar_asset_id from public.profiles where owner_id=$1", [editor])).rows[0].avatar_asset_id).toBe(firstId);
    await admin.query("delete from public.profiles where owner_id=$1", [editor]);
  });

  it("serializes parent deletion after publish and terminalizes every asset", async () => {
    await asUser(first, editor);
    const asset = await reserve(first);
    await first.query("select public.commit_media_upload($1,'902')", [asset.id]);
    await asUser(second, owner);
    const pending = second.query("delete from public.daycare_records where id=$1", [record]);
    await waitForLock();
    await first.query("commit");
    await pending;
    await second.query("commit");
    expect((await admin.query("select state from public.media_assets where id=$1", [asset.id])).rows[0].state).toBe("deleted");
    expect((await admin.query("select count(*)::int n from public.record_photos where record_id=$1", [record])).rows[0].n).toBe(0);
    expect((await admin.query("select count(*)::int n from public.media_assets where household_id=$1 and state<>'deleted'", [household])).rows[0].n).toBe(0);
  });
  it("refuses publish after a concurrent parent deletion wins", async () => {
    await admin.query("insert into public.daycare_records(id,owner_id,household_id) values($1,$2,$3)", [record, owner, household]);
    await asUser(first, editor);
    const asset = await reserve(first);
    await first.query("commit");
    await asUser(first, owner);
    await first.query("delete from public.daycare_records where id=$1", [record]);
    await asUser(second, editor);
    const pending = second.query("select public.commit_media_upload($1,'920')", [asset.id])
      .then(() => ({ code: "unexpected success" }), (error: { code: string }) => ({ code: error.code }));
    await waitForLock();
    await first.query("commit");
    expect(await pending).toEqual({ code: "42501" });
    await second.query("rollback");
    expect((await admin.query("select state from public.media_assets where id=$1", [asset.id])).rows[0].state).toBe("deleted");
  });

});
