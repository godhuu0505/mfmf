set shell := ["bash", "-cu"]

# Default: show recipe list
default:
    @just --list

# Local dev server (next dev)
dev:
    npm run dev

# CI gate: lint -> typecheck -> build
check:
    npm run lint
    npm run typecheck
    npm run build

# Start Next.js via Docker
up:
    docker compose up --build

# Stop Docker stack
down:
    docker compose down

# Initial environment setup (run once). Starts Supabase and writes .env.local.
setup:
    @set -e; \
    if [ -f .env.local ]; then \
        echo "[setup] .env.local already exists. Aborting to avoid overwrite."; \
        exit 1; \
    fi; \
    command -v supabase >/dev/null || { \
        echo "[setup] supabase CLI not found. brew install supabase/tap/supabase"; exit 1; \
    }; \
    echo "[setup] Ensuring local Supabase stack is running..."; \
    supabase status >/dev/null 2>&1 || supabase start; \
    echo "[setup] Reading anon key from supabase status..."; \
    ANON_KEY="$(supabase status -o env | awk -F= '/^ANON_KEY=/{print $2}' | tr -d '\"')"; \
    if [ -z "$ANON_KEY" ]; then \
        echo "[setup] Failed to read ANON_KEY from supabase status"; exit 1; \
    fi; \
    echo "[setup] Generating TOKEN_ENC_KEY..."; \
    TOKEN_ENC_KEY="$(node -e "console.log(require('crypto').randomBytes(32).toString('base64'))")"; \
    if [ -z "$TOKEN_ENC_KEY" ]; then \
        echo "[setup] Failed to generate TOKEN_ENC_KEY"; exit 1; \
    fi; \
    echo "[setup] Writing .env.local from .env.local.example..."; \
    cp .env.local.example .env.local; \
    sed -i.bak -E 's#^NEXT_PUBLIC_SUPABASE_URL=.*#NEXT_PUBLIC_SUPABASE_URL=http://127.0.0.1:54321#' .env.local; \
    sed -i.bak -E "s#^NEXT_PUBLIC_SUPABASE_ANON_KEY=.*#NEXT_PUBLIC_SUPABASE_ANON_KEY=$ANON_KEY#" .env.local; \
    sed -i.bak -E "s#^TOKEN_ENC_KEY=.*#TOKEN_ENC_KEY=$TOKEN_ENC_KEY#" .env.local; \
    rm -f .env.local.bak; \
    echo "[setup] Done."; \
    echo "[setup] Next: 'just setup-google' で Google OAuth を設定 → 'just up' (or 'just dev')"

# Configure Google OAuth interactively. Run after Google Cloud OAuth client is created.
# Writes secrets to supabase/.env and .env.local, enables [auth.external.google], restarts Supabase.
setup-google:
    @set -e; \
    if [ ! -f .env.local ]; then \
        echo "[setup-google] .env.local が無い。先に 'just setup' を実行してください。"; exit 1; \
    fi; \
    if [ ! -f supabase/config.toml ]; then \
        echo "[setup-google] supabase/config.toml が無い。"; exit 1; \
    fi; \
    echo "[setup-google] Google Cloud Console で発行した OAuth クライアント情報を入力します。"; \
    echo "[setup-google] リダイレクト URI は http://127.0.0.1:54321/auth/v1/callback を登録済みであること。"; \
    read -r -p "GOOGLE_CLIENT_ID: " GOOGLE_CLIENT_ID; \
    read -rs -p "GOOGLE_CLIENT_SECRET: " GOOGLE_CLIENT_SECRET; echo; \
    if [ -z "$GOOGLE_CLIENT_ID" ] || [ -z "$GOOGLE_CLIENT_SECRET" ]; then \
        echo "[setup-google] 値が空。中止。"; exit 1; \
    fi; \
    echo "[setup-google] supabase/.env に書き込み..."; \
    { \
        echo "SUPABASE_AUTH_EXTERNAL_GOOGLE_CLIENT_ID=$GOOGLE_CLIENT_ID"; \
        echo "SUPABASE_AUTH_EXTERNAL_GOOGLE_SECRET=$GOOGLE_CLIENT_SECRET"; \
    } > supabase/.env; \
    echo "[setup-google] .env.local の Drive 連携用キーを更新..."; \
    sed -i.bak -E "s#^GOOGLE_CLIENT_ID=.*#GOOGLE_CLIENT_ID=$GOOGLE_CLIENT_ID#" .env.local; \
    sed -i.bak -E "s#^GOOGLE_CLIENT_SECRET=.*#GOOGLE_CLIENT_SECRET=$GOOGLE_CLIENT_SECRET#" .env.local; \
    rm -f .env.local.bak; \
    echo "[setup-google] supabase/config.toml の [auth.external.google] を有効化..."; \
    sed -i.bak '/^\[auth\.external\.google\]/,/^\[/ s/^enabled = false/enabled = true/' supabase/config.toml; \
    rm -f supabase/config.toml.bak; \
    echo "[setup-google] Supabase を再起動して設定を反映..."; \
    supabase stop >/dev/null 2>&1 || true; \
    supabase start; \
    echo "[setup-google] Done. ブラウザで /login の Google ログインを試してください。"
