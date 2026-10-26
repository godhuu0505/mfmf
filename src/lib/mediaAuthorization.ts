// Server-only dependency: never expose these factories as a raw-path Server Action.
import { createClient } from "@/lib/supabase/server";
import { getRoleInHousehold } from "@/lib/household";
import { AVATAR_BUCKET, PHOTO_BUCKET } from "@/types/database";

type ServerClient = Awaited<ReturnType<typeof createClient>>;
export type AvatarKind = "profile" | "household" | "pet";
export type AvatarTarget = Readonly<{ kind: AvatarKind; entityId: string }>;
const authorized = Symbol("authorized-media");
const issued = new WeakSet<object>();
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MAX_TARGETS = 1000;
const FAILURE = "画像へのアクセスを確認できませんでした";

type DescriptorBase = Readonly<{
  [authorized]: true;
  actorId: string;
  entityId: string;
  path: string;
  householdId: string | null;
  ownerId: string | null;
}>;
export type AuthorizedPhotoDescriptor = DescriptorBase & Readonly<{
  kind: "photo";
  bucket: typeof PHOTO_BUCKET;
  photoId: string;
  recordId: string;
  householdId: string;
  ownerId: string;
}>;
export type AuthorizedAvatarDescriptor = DescriptorBase & Readonly<{
  kind: AvatarKind;
  bucket: typeof AVATAR_BUCKET;
}>;
export type AuthorizedMediaDescriptor = AuthorizedPhotoDescriptor | AuthorizedAvatarDescriptor;

// A TypeScript cast or browser JSON must not manufacture an authorization receipt.
// This is a process-local boundary, not evidence of GCS metadata or upload completion.
export function assertAuthorizedMediaDescriptor(value: unknown): asserts value is AuthorizedMediaDescriptor {
  if (typeof value !== "object" || value === null || !issued.has(value)) throw new Error(FAILURE);
}

function issue<T extends object>(value: T): Readonly<T & { [authorized]: true }> {
  const descriptor = Object.freeze({ ...value, [authorized]: true as const });
  issued.add(descriptor);
  return descriptor;
}

function ids(values: readonly string[]): string[] {
  if (!Array.isArray(values) || values.length > MAX_TARGETS || values.some((id) => typeof id !== "string" || !UUID.test(id))) {
    throw new Error(FAILURE);
  }
  return [...new Set(values.map((id) => id.toLowerCase()))];
}

// Preserve the original object key. Do not URL-decode, trim or normalize it.
// Historical uploads used the same filename sanitizer, but an owner UUID prefix.
function pathParts(path: unknown): [string, string, string] | null {
  if (typeof path !== "string" || path.length > 1024) return null;
  const parts = path.split("/");
  if (parts.length !== 3 || !UUID.test(parts[0]) || !/^[a-zA-Z0-9._-]+$/.test(parts[2]) ||
      parts[2] === "." || parts[2] === "..") return null;
  return parts as [string, string, string];
}

async function context() {
  const supabase = await createClient();
  const { data: { user }, error } = await supabase.auth.getUser();
  if (error || !user || !UUID.test(user.id)) throw new Error(FAILURE);
  const memberships = new Map<string, Promise<boolean>>();
  const memberOf = (householdId: string): Promise<boolean> => {
    if (!UUID.test(householdId)) return Promise.resolve(false);
    let result = memberships.get(householdId);
    if (!result) {
      result = getRoleInHousehold(supabase, user.id, householdId).then((role) => role !== null);
      memberships.set(householdId, result);
    }
    return result;
  };
  return { supabase, user, memberOf };
}

type PhotoRow = { id: string; record_id: string; household_id: string; storage_path: string };
type RecordRow = { id: string; household_id: string; owner_id: string };

/** Read authorization only. Missing, invisible and invalidly bound rows are omitted. */
async function photoReads(photoIds: readonly string[]): Promise<readonly AuthorizedPhotoDescriptor[]> {
  const requested = ids(photoIds);
  const { supabase, user, memberOf } = await context();
  if (!requested.length) return [];
  const { data: photos, error } = await supabase.from("record_photos")
    .select("id, record_id, household_id, storage_path").in("id", requested).returns<PhotoRow[]>();
  if (error) throw new Error(FAILURE);
  if (!photos?.length) return [];
  const recordIds = ids(photos.map((photo) => photo.record_id));
  const { data: records, error: recordError } = await supabase.from("daycare_records")
    .select("id, household_id, owner_id").in("id", recordIds).returns<RecordRow[]>();
  if (recordError) throw new Error(FAILURE);
  const parentById = new Map((records ?? []).map((record) => [record.id, record]));
  const byId = new Map<string, AuthorizedPhotoDescriptor>();
  for (const photo of photos) {
    const parent = parentById.get(photo.record_id);
    const parts = pathParts(photo.storage_path);
    if (!requested.includes(photo.id) || !parent || !parts || !UUID.test(parent.owner_id) ||
        photo.household_id !== parent.household_id || !await memberOf(parent.household_id) ||
        parts[1].toLowerCase() !== parent.id ||
        ![parent.household_id, parent.owner_id].includes(parts[0].toLowerCase())) continue;
    byId.set(photo.id, issue({ kind: "photo" as const, bucket: PHOTO_BUCKET, actorId: user.id,
      entityId: photo.id, photoId: photo.id, recordId: parent.id, householdId: parent.household_id,
      ownerId: parent.owner_id, path: photo.storage_path }));
  }
  return requested.flatMap((id) => byId.has(id) ? [byId.get(id)!] : []);
}

type AvatarRow = { id: string; household_id: string | null; owner_id: string | null; avatar_path: string | null };
async function avatarRows(supabase: ServerClient, kind: AvatarKind, requested: string[]): Promise<AvatarRow[]> {
  if (!requested.length) return [];
  if (kind === "profile") {
    const { data, error } = await supabase.from("profiles").select("owner_id, avatar_path")
      .in("owner_id", requested).returns<{ owner_id: string; avatar_path: string | null }[]>();
    if (error) throw new Error(FAILURE);
    return (data ?? []).map((row) => ({ ...row, id: row.owner_id, household_id: null }));
  }
  if (kind === "household") {
    const { data, error } = await supabase.from("households").select("id, avatar_path")
      .in("id", requested).returns<{ id: string; avatar_path: string | null }[]>();
    if (error) throw new Error(FAILURE);
    return (data ?? []).map((row) => ({ ...row, household_id: row.id, owner_id: null }));
  }
  const { data, error } = await supabase.from("pets").select("id, household_id, owner_id, avatar_path")
    .in("id", requested).returns<AvatarRow[]>();
  if (error) throw new Error(FAILURE);
  return data ?? [];
}

/** A guest-visible pet is not permission to read its uploaded avatar. */
async function avatarReads(targets: readonly AvatarTarget[]): Promise<readonly AuthorizedAvatarDescriptor[]> {
  if (!Array.isArray(targets) || targets.length > MAX_TARGETS || targets.some((target) =>
    !target || !["profile", "household", "pet"].includes(target.kind))) throw new Error(FAILURE);
  ids(targets.map((target) => target.entityId));
  const { supabase, user, memberOf } = await context();
  const byTarget = new Map<string, AuthorizedAvatarDescriptor>();
  for (const kind of ["profile", "household", "pet"] as const) {
    const requested = ids(targets.filter((target) => target.kind === kind).map((target) => target.entityId));
    // Do not even query another person's private profile on behalf of this user.
    const allowed = kind === "profile" ? requested.filter((id) => id === user.id) : requested;
    for (const row of await avatarRows(supabase, kind, allowed)) {
      const parts = pathParts(row.avatar_path);
      if (!allowed.includes(row.id) || !parts || parts[1] !== "avatars") continue;
      if (kind === "profile") {
        if (row.id !== user.id || row.owner_id !== user.id || parts[0] !== user.id) continue;
      } else if (!row.household_id || !await memberOf(row.household_id) ||
          parts[0].toLowerCase() !== row.household_id) continue;
      byTarget.set(`${kind}:${row.id}`, issue({ kind, bucket: AVATAR_BUCKET, actorId: user.id,
        entityId: row.id, householdId: row.household_id, ownerId: row.owner_id, path: row.avatar_path! }));
    }
  }
  return [...new Set(targets.map((target) => `${target.kind}:${target.entityId.toLowerCase()}`))]
    .flatMap((key) => byTarget.has(key) ? [byTarget.get(key)!] : []);
}

async function guarded<T>(read: () => Promise<T>): Promise<T> {
  try { return await read(); }
  catch { throw new Error(FAILURE); }
}

export function authorizePhotoReads(photoIds: readonly string[]): Promise<readonly AuthorizedPhotoDescriptor[]> {
  return guarded(() => photoReads(photoIds));
}

export function authorizeAvatarReads(targets: readonly AvatarTarget[]): Promise<readonly AuthorizedAvatarDescriptor[]> {
  return guarded(() => avatarReads(targets));
}

export async function authorizeAvatarRead(kind: AvatarKind, entityId: string): Promise<AuthorizedAvatarDescriptor | null> {
  return (await authorizeAvatarReads([{ kind, entityId }]))[0] ?? null;
}
