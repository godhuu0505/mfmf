import { describe, expect, it } from "vitest";
import {
  buildStoragePath,
  isPathForRecord,
  sanitizeFileName,
} from "@/lib/storagePath";

// パス規約 {household_id}/{record_id}/{filename} の砦。
// ここが破れると Storage RLS の insert ポリシー（フォルダ先頭 2 セグメント判定）を
// すり抜ける形のパスをクライアントが作れてしまうため、
// 「規約から外れる入力を必ず落とす」ことを敵対的入力で確認する。

const HH = "11111111-1111-4111-8111-111111111111";
const REC = "22222222-2222-4222-8222-222222222222";

describe("sanitizeFileName", () => {
  it("英数字・ドット・ハイフン・アンダースコアはそのまま通す", () => {
    expect(sanitizeFileName("photo_2026-08-01.jpg")).toBe(
      "photo_2026-08-01.jpg",
    );
  });

  it("パス区切り（/）を潰し、../ による走査をディレクトリとして解釈できない形にする", () => {
    expect(sanitizeFileName("../../etc/passwd")).toBe(".._.._etc_passwd");
    expect(sanitizeFileName("a/b/c.png")).toBe("a_b_c.png");
  });

  it("Windows 形式のパス区切り（\\）も潰す", () => {
    expect(sanitizeFileName("..\\..\\boot.ini")).toBe(".._.._boot.ini");
  });

  it("NUL 文字を潰す", () => {
    expect(sanitizeFileName("evil\u0000.jpg")).toBe("evil_.jpg");
  });

  it("拡張子偽装に使われる RTL 制御文字（U+202E）を潰す", () => {
    // 表示上 "photoexe.jpg" に見せかけて実体は .exe、という偽装の常套手段
    expect(sanitizeFileName("photo\u202Egpj.exe")).toBe("photo_gpj.exe");
  });

  it("日本語など許可外の文字はすべて _ に置換される", () => {
    expect(sanitizeFileName("写真.jpg")).toBe("__.jpg");
  });

  it("% を潰す（%00 等のエンコード済みバイパスを無効化）", () => {
    expect(sanitizeFileName("a%00.php")).toBe("a_00.php");
  });

  it("どんな入力でも出力は許可文字のみになる", () => {
    const inputs = [
      "../../etc/passwd",
      "写真 /..\\évil%2F.jpg",
      "\u202E //\\\\",
      "",
      "a".repeat(500) + "/../x.jpg",
    ];
    for (const input of inputs) {
      expect(sanitizeFileName(input)).toMatch(/^[a-zA-Z0-9._-]*$/);
    }
  });
});

describe("buildStoragePath", () => {
  it("{household_id}/{record_id}/{uuid}-{filename} 形式を生成する", () => {
    const path = buildStoragePath(HH, REC, "photo.jpg");
    expect(path).toMatch(
      new RegExp(
        `^${HH}/${REC}/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}-photo\\.jpg$`,
      ),
    );
  });

  it("敵対的なファイル名でもセグメント数は 3 のまま（先頭 2 つが household/record）", () => {
    const evil = [
      "../../etc/passwd",
      "a/b/c.png",
      "\u0000",
      "写真/夏.jpg",
      "..\\..\\x.jpg",
      "x".repeat(300) + "/y.jpg",
    ];
    for (const name of evil) {
      const path = buildStoragePath(HH, REC, name);
      const segments = path.split("/");
      expect(segments.length).toBe(3);
      expect(segments[0]).toBe(HH);
      expect(segments[1]).toBe(REC);
    }
  });

  it("生成したパスは常に自分の record の検証を通る（規約との往復）", () => {
    const path = buildStoragePath(HH, REC, "../evil.jpg");
    expect(isPathForRecord(path, HH, REC)).toBe(true);
  });

  it("同じ入力でも uuid によりパスが衝突しない", () => {
    expect(buildStoragePath(HH, REC, "a.jpg")).not.toBe(
      buildStoragePath(HH, REC, "a.jpg"),
    );
  });
});

describe("isPathForRecord", () => {
  const path = `${HH}/${REC}/file.jpg`;

  it("scope と record が両方一致すれば通る", () => {
    expect(isPathForRecord(path, HH, REC)).toBe(true);
  });

  it("別の record 配下のパスは落とす（scope 一致だけでは不十分）", () => {
    const otherRec = "33333333-3333-4333-8333-333333333333";
    expect(isPathForRecord(path, HH, otherRec)).toBe(false);
  });

  it("別の scope（世帯）のパスは落とす", () => {
    const otherHh = "44444444-4444-4444-8444-444444444444";
    expect(isPathForRecord(path, otherHh, REC)).toBe(false);
  });

  it("record セグメントを欠いたパスは落とす", () => {
    expect(isPathForRecord(`${HH}/file.jpg`, HH, REC)).toBe(false);
  });

  it("前方一致の部分文字列では通らない（hh1 と hh12、rec1 と rec10）", () => {
    expect(isPathForRecord("hh12/rec1/f.jpg", "hh1", "rec1")).toBe(false);
    expect(isPathForRecord("hh1/rec10/f.jpg", "hh1", "rec1")).toBe(false);
  });

  it("他 record 用に生成されたパスの紐付けは落とす", () => {
    const otherRec = "33333333-3333-4333-8333-333333333333";
    const otherPath = buildStoragePath(HH, otherRec, "a.jpg");
    expect(isPathForRecord(otherPath, HH, REC)).toBe(false);
  });
});
