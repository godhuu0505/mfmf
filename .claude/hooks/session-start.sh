#!/bin/bash
# SessionStart hook — Claude Code on the web で新しいコンテナにクローンされた直後に
# 依存をインストールし、lint / typecheck / build をすぐ実行できる状態にする。
#
# - 同期実行（async ではない）。セッション開始前に依存を確実に用意し、
#   Claude が依存未インストールの状態で lint/build を叩くレースを防ぐ。
# - 冪等（何度実行しても安全）。
# - コンテナ状態はフック完了後にキャッシュされるため、キャッシュを活かせる
#   `npm install`（ロックがあれば `npm ci`）を使う。
set -euo pipefail

cd "${CLAUDE_PROJECT_DIR:-.}"

# node_modules が既にあり package-lock より新しければスキップ（冪等＋高速）
if [ -d node_modules ] && [ node_modules -nt package-lock.json ]; then
  echo "[session-start] 依存は最新です。スキップします。"
  exit 0
fi

echo "[session-start] 依存をインストールします..."
if [ -f package-lock.json ]; then
  npm ci --no-audit --no-fund || npm install --no-audit --no-fund
else
  npm install --no-audit --no-fund
fi

echo "[session-start] 完了。"
