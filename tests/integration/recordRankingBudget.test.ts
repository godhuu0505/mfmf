// Executes the actual migration/function in an isolated local PostgreSQL database.
// It neither resets the shared Supabase database nor calls any external service.
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { Client } from "pg";
import { DB_URL } from "./env";

const dbName = `mfmf_ranking_test_${randomUUID().replaceAll("-", "")}`;
const owner = randomUUID(); const viewer = randomUUID(); const guest = randomUUID(); const household = randomUUID();
const members = [owner, viewer, ...Array.from({ length: 10 }, () => randomUUID())];
const sourceUrl = new URL(DB_URL);
if (!["localhost", "127.0.0.1"].includes(sourceUrl.hostname) || sourceUrl.port !== "54322") throw new Error("Local Supabase PostgreSQL only");
const targetUrl = new URL(sourceUrl); targetUrl.pathname = `/${dbName}`;
const admin = new Client({ connectionString: DB_URL });
const testDb = new Client({ connectionString: targetUrl.toString() });
let created = false;
const live = Date.now() < Date.parse("2027-06-24T00:00:00+09:00");

async function callAs(user: string | null, targetHousehold = household) {
  const client = new Client({ connectionString: targetUrl.toString() });
  await client.connect();
  try {
    await client.query("begin; set local role authenticated");
    await client.query("select set_config('request.jwt.claims',$1,true)", [JSON.stringify({ sub: user, role: "authenticated" })]);
    const result = (await client.query("select public.reserve_record_ranking($1) reservation", [targetHousehold])).rows[0].reservation;
    await client.query("commit"); return result as { allowed: boolean; reason: string };
  } finally { await client.end(); }
}
async function counters() {
  return (await testDb.query("select daily_count,lifetime_count from public.record_ranking_project_budget")).rows[0];
}

beforeAll(async () => {
  await admin.connect();
  // dbName is generated here from UUID hex only, not read from user or environment input.
  await admin.query(`create database ${dbName}`); created = true;
  await testDb.connect();
  await testDb.query(`
    create schema auth;
    create table auth.users(id uuid primary key);
    create function auth.uid() returns uuid language sql stable as
      $$ select (nullif(current_setting('request.jwt.claims',true),'')::jsonb->>'sub')::uuid $$;
  `);
  await testDb.query("create table public.household_members(household_id uuid not null,user_id uuid not null references auth.users(id),role text not null,primary key(household_id,user_id))");
  await testDb.query("grant usage on schema auth to authenticated; grant execute on function auth.uid() to authenticated");
  for (const id of [...members, guest]) await testDb.query("insert into auth.users(id) values($1)", [id]);
  for (const id of members) await testDb.query("insert into public.household_members values($1,$2,$3)", [household, id, id === viewer ? "viewer" : "owner"]);
  const migration = await readFile(new URL("../../supabase/migrations/20261028010000_record_ranking_budget.sql", import.meta.url), "utf8");
  await testDb.query(migration);
});
beforeEach(async () => {
  await testDb.query("update public.record_ranking_project_budget set usage_day=(clock_timestamp() at time zone 'Asia/Tokyo')::date,daily_count=0,lifetime_count=0; truncate public.record_ranking_user_budget");
});
afterAll(async () => {
  await testDb.end().catch(() => {});
  if (created) await admin.query(`drop database ${dbName} with (force)`);
  await admin.end();
});

describe("atomic ranking budget SQL", () => {
  it("uses an empty search_path, rejects anonymous/foreign/guest-only callers and hides the counter tables", async () => {
    const fn = (await testDb.query("select prosecdef,proconfig from pg_proc where oid='public.reserve_record_ranking(uuid)'::regprocedure")).rows[0];
    expect(fn.prosecdef).toBe(true); expect(fn.proconfig).toEqual(['search_path=""']);
    for (const [user, target] of [[null, household], [guest, household], [owner, randomUUID()]] as const) {
      await expect(callAs(user, target)).rejects.toMatchObject({ code: "42501" });
    }
    const client = new Client({ connectionString: targetUrl.toString() }); await client.connect();
    try {
      await client.query("set role authenticated");
      for (const statement of ["select * from public.record_ranking_project_budget", "update public.record_ranking_project_budget set lifetime_count=0", "select * from public.record_ranking_user_budget", "delete from public.record_ranking_user_budget"]) {
        await expect(client.query(statement)).rejects.toMatchObject({ code: "42501" });
      }
    } finally { await client.end(); }
    expect(await counters()).toEqual({ daily_count: 0, lifetime_count: 0 });
  });
  it.runIf(live)("permits members including viewers and consumes exactly one reservation", async () => {
    expect(await callAs(viewer)).toEqual({ allowed: true, reason: "reserved" });
    expect(await counters()).toEqual({ daily_count: 1, lifetime_count: 1 });
  });
  it.runIf(live)("serializes concurrent same-user requests at five per minute", async () => {
    const result = await Promise.all(Array.from({ length: 20 }, () => callAs(owner)));
    expect(result.filter((r) => r.allowed)).toHaveLength(5);
    expect(result.filter((r) => !r.allowed).every((r) => r.reason === "user_minute")).toBe(true);
    expect(await counters()).toEqual({ daily_count: 5, lifetime_count: 5 });
  });
  it.runIf(live)("enforces the daily user limit across multiple minutes", async () => {
    await callAs(owner);
    await testDb.query("update public.record_ranking_user_budget set daily_count=19,minute_count=0,usage_minute=clock_timestamp()-interval '2 minutes' where user_id=$1", [owner]);
    const result = await Promise.all(Array.from({ length: 8 }, () => callAs(owner)));
    expect(result.filter((r) => r.allowed)).toHaveLength(1);
    expect(result.filter((r) => !r.allowed).every((r) => r.reason === "user_day")).toBe(true);
  });
  it.runIf(live)("serializes different users at the project daily cap", async () => {
    await testDb.query("update public.record_ranking_project_budget set daily_count=99");
    const result = await Promise.all(members.slice(0, 10).map((user) => callAs(user)));
    expect(result.filter((r) => r.allowed)).toHaveLength(1);
    expect(result.filter((r) => !r.allowed).every((r) => r.reason === "project_day")).toBe(true);
    expect(await counters()).toEqual({ daily_count: 100, lifetime_count: 1 });
  });
  it.runIf(live)("enforces the project lifetime cap without a caller-controlled reset", async () => {
    await testDb.query("update public.record_ranking_project_budget set lifetime_count=4999");
    const result = await Promise.all(members.slice(0, 10).map((user) => callAs(user)));
    expect(result.filter((r) => r.allowed)).toHaveLength(1);
    expect(result.filter((r) => !r.allowed).every((r) => r.reason === "project_lifetime")).toBe(true);
    expect(await counters()).toEqual({ daily_count: 1, lifetime_count: 5000 });
  });
  it.runIf(!live)("refuses all reservations after the fixed credit expiry", async () => {
    expect(await callAs(owner)).toEqual({ allowed: false, reason: "expired" });
    expect(await counters()).toEqual({ daily_count: 0, lifetime_count: 0 });
  });
});
