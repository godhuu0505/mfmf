---
description: コミット/プッシュ前の検証ゲート（lint + typecheck + build）を実行する
allowed-tools: Bash(npm run lint), Bash(npm run typecheck), Bash(npm run build)
---

mfmf の検証ゲートを順に実行し、結果を報告してください。CI（`.github/workflows/ci.yml`）と同一です。

1. `npm run lint`
2. `npm run typecheck`
3. `NEXT_PUBLIC_SUPABASE_URL=https://placeholder.supabase.co NEXT_PUBLIC_SUPABASE_ANON_KEY=placeholder npm run build`

いずれか失敗したら、原因と修正案を示してください。すべて成功したら「プッシュ可能」と報告してください。
これらは公開前提のプレースホルダ env なので秘密情報の心配はありません。
