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
    echo "[setup] Next steps:"; \
    echo "  1. Create a user in Supabase Studio (http://127.0.0.1:54323)"; \
    echo "  2. (Optional) For Google login: set GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET in .env.local"; \
    echo "     and configure supabase/config.toml [auth.external.google] — see docs/guides/google-drive-setup.md"; \
    echo "  3. Run 'just up' (or 'just dev')"
