// Actual local Storage HTTP requests, synthetic bytes, no cloud credentials.
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Client } from "pg";
import type { SupabaseClient } from "@supabase/supabase-js";
import { DB_URL, PERSONAS, SUPABASE_URL } from "./env";
import { loadSeed, loginAs } from "./testKit";

const db = new Client({ connectionString: DB_URL });
const suffix = randomUUID();
// One transparent synthetic pixel; never a user file.
const original = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aF9sAAAAASUVORK5CYII=", "base64");
let client: SupabaseClient;
let path: string;
let connected = false;
let uploaded = false;
let signedUploadToken: string;

async function sourceBytes() {
  const result = await client.storage.from("avatars").download(path);
  expect(result.error).toBeNull();
  expect(result.data).not.toBeNull();
  return Buffer.from(await result.data!.arrayBuffer());
}

beforeAll(async () => {
  const api = new URL(SUPABASE_URL);
  const database = new URL(DB_URL);
  if (api.origin !== "http://127.0.0.1:54321" || database.hostname !== "127.0.0.1" || database.port !== "54322") throw new Error("Local Supabase only");
  await db.connect();
  connected = true;
  expect((await db.query("select public.get_media_storage_mode() mode")).rows[0].mode).toBe("supabase");
  client = await loginAs(PERSONAS.aEditor);
  path = `${loadSeed().users.aEditor}/avatars/freeze-${suffix}.png`;
  const upload = await client.storage.from("avatars").upload(path, original, { contentType: "image/png", upsert: false });
  expect(upload.error).toBeNull();
  uploaded = true;
  const signed = await client.storage.from("avatars").createSignedUploadUrl(`${path}.signed`);
  expect(signed.error).toBeNull();
  signedUploadToken = signed.data!.token;
});

afterAll(async () => {
  if (connected) {
    await db.query("select public.set_media_storage_mode('frozen'); select public.set_media_storage_mode('supabase')");
    if (uploaded) {
      const result = await client.storage.from("avatars").remove([path, `${path}.copy`, `${path}.moved`, `${path}.signed`]);
      expect(result.error).toBeNull();
    }
    await db.end();
  }
});

describe("actual Storage write freeze", () => {
  it("keeps GET bytes intact while direct upsert, copy, move and delete cannot mutate them", async () => {
    expect(await sourceBytes()).toEqual(original);
    const before = (await db.query("select version,metadata,owner_id from storage.objects where bucket_id='avatars' and name=$1", [path])).rows[0];
    await db.query("select public.set_media_storage_mode('frozen')");
    // A managed last-access write must not make an otherwise authorized GET fail.
    expect(await sourceBytes()).toEqual(original);
    expect((await client.storage.from("avatars").upload(path, Buffer.from("replacement"), { contentType: "image/png", upsert: true })).error).not.toBeNull();
    expect((await client.storage.from("avatars").copy(path, `${path}.copy`)).error).not.toBeNull();
    expect((await client.storage.from("avatars").move(path, `${path}.moved`)).error).not.toBeNull();
    expect((await client.storage.from("avatars").uploadToSignedUrl(`${path}.signed`, signedUploadToken, original, { contentType: "image/png" })).error).not.toBeNull();
    // Storage can return an empty successful delete for rows hidden by RLS.
    await client.storage.from("avatars").remove([path]);
    expect((await db.query("select version,metadata,owner_id from storage.objects where bucket_id='avatars' and name=$1", [path])).rows[0]).toEqual(before);
    expect((await db.query("select count(*)::int count from storage.objects where bucket_id='avatars' and name=any($1::text[])", [[`${path}.copy`, `${path}.moved`, `${path}.signed`]])).rows[0].count).toBe(0);
    expect(await sourceBytes()).toEqual(original);
    await db.query("select public.set_media_storage_mode('gcs')");
    expect((await client.storage.from("avatars").download(path)).error).not.toBeNull();
    await db.query("select public.set_media_storage_mode('frozen'); select public.set_media_storage_mode('supabase')");
    expect(await sourceBytes()).toEqual(original);
  });
});
