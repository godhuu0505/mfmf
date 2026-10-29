FROM mfmf-db-tools:20261028 AS tools
FROM node:22-bookworm-slim AS node
FROM mfmf-gcp-postgres-test:17
COPY --from=tools /usr/local/bin/postgrest /usr/local/bin/postgrest
COPY --from=node /usr/local/bin/node /usr/local/bin/node
