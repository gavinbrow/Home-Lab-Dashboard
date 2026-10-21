FROM node:24.22.0-bookworm-slim@sha256:a5f4366e834695d5f363b920c104953a535d3a9864d1bdf74566a0ebe01daee5 AS runtime
WORKDIR /app
COPY . .
RUN npm ci && groupadd --gid 10001 homelab && useradd --uid 10001 --gid 10001 --no-create-home homelab \
    && chmod +x deploy/entrypoint.sh
USER 10001:10001
ENTRYPOINT ["/app/deploy/entrypoint.sh"]
CMD ["npm", "run", "start:api"]

FROM postgres:17.11-bookworm@sha256:3645570cccdfa447589da9f57dd740faa29b30938e861289a5574b6ca6b03826 AS postgres-tools
FROM python:3.12.13-slim-bookworm@sha256:4766d8b510c428e595d74b9cc5bbb2fae8e26316fffb4adc89908d79aacd58a2 AS python-tools
FROM restic/restic:0.18.1@sha256:39d9072fb5651c80d75c7a811612eb60b4c06b32ffe87c2e9f3c7222e1797e76 AS restic-tools
FROM runtime AS backup-worker
USER root
# All tool/runtime libraries come from digest-pinned Debian bookworm images;
# no unpinned apt transaction and no inherited PostgreSQL data VOLUME.
COPY --from=postgres-tools /usr/lib/postgresql/17 /usr/lib/postgresql/17
COPY --from=postgres-tools /usr/lib/x86_64-linux-gnu /usr/lib/x86_64-linux-gnu
COPY --from=python-tools /usr/local /usr/local
COPY --from=python-tools /usr/lib/x86_64-linux-gnu /usr/lib/x86_64-linux-gnu
COPY --from=restic-tools /usr/bin/restic /usr/local/bin/restic
ENV PATH="/usr/lib/postgresql/17/bin:${PATH}"
RUN node --version && python3 --version && pg_dump --version && restic version \
    && python3 -c "import ssl,sqlite3,bz2,tarfile; print('Backup runtime libraries ready')"
USER 10001:10001
CMD ["npm", "run", "start:worker"]

FROM runtime AS web-build
USER root
RUN npm run build --workspace @homelab/web

FROM caddy:2.11.7-alpine@sha256:d8542f48d34a9cf4e4c11a478865229840e87e4c96ea3f439101f31a5d35f75f AS proxy
COPY --from=web-build /app/apps/web/dist /srv/web
COPY deploy/Caddyfile /etc/caddy/Caddyfile
