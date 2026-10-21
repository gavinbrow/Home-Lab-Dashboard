# Deployment versions and provenance

Recorded October 20, 2026 (local implementation date). These are explicit reviewed-baseline pins, not claims of being the newest patches or of having passed a vulnerability scan. Before a release, review advisories and update affected patch pins/digests together with evidence. No `latest` image is used.

| Component | Exact pin | Registry manifest/index digest | Verification |
|---|---|---|---|
| Node runtime/build | `node:24.22.0-bookworm-slim` | `sha256:a5f4366e834695d5f363b920c104953a535d3a9864d1bdf74566a0ebe01daee5` | Actual Linux runtime/worker builds and API runs |
| PostgreSQL | `postgres:17.11-bookworm` | `sha256:3645570cccdfa447589da9f57dd740faa29b30938e861289a5574b6ca6b03826` | Actual fresh init, migration, capture and restore |
| Caddy | `caddy:2.11.7-alpine` | `sha256:d8542f48d34a9cf4e4c11a478865229840e87e4c96ea3f439101f31a5d35f75f` | Actual CA startup; full proxy rehearsal tracked separately |
| Guacamole web/JSON extension | `guacamole/guacamole:1.6.0` | `sha256:f344085e618bb05e22b964b0208dbd06d3468275bac70206f93805245e067b40` | Actual isolated VNC/session listener proof; no live homelab claim |
| guacd | `guacamole/guacd:1.6.0` | `sha256:8974eaa9ba32f713daf311e7cc8cd7e4cdfba1edea39eed75524e78ef4b08f4f` | Apache official image; no published port |
| Python worker | `python:3.12.13-slim-bookworm` | `sha256:4766d8b510c428e595d74b9cc5bbb2fae8e26316fffb4adc89908d79aacd58a2` | Actual worker import/snapshot smoke test |
| restic worker | `restic/restic:0.18.1` | `sha256:39d9072fb5651c80d75c7a811612eb60b4c06b32ffe87c2e9f3c7222e1797e76` | Actual encrypted seal/read-check and restore drills |
| Listener builder | `maven:3.9.9-eclipse-temurin-17` | `sha256:f58d59b6273e785ac0a4477f6e9b5ba1d7731c75b906c0f7b34076f1851318cc` | Fresh source JAR build and baked Guacamole image passed |
| Docker observed | Windows CLI `27.3.1`; existing WSL Engine `29.7.2` | Host installations | WSL isolated fixtures ran; Desktop startup socket failure retained |
| Compose | minimum `2.24.4` for `!override` restore overlay | Host installation | Actual tested CLI version recorded in EVIDENCE.md |
| Python observed | `3.12.10` | Host installation | Stdlib-only tooling tested on Windows |

Registry metadata came from `registry-1.docker.io/v2/{repository}/manifests/{exact-tag}`, with OCI/Docker index Accept headers and `Docker-Content-Digest` response headers. Index pins permit supported platform resolution while fixing the multiarch set. A digest is content identity, not a security review. Local app image tags are `homelab-control:0.1.0` and `homelab-control-proxy:0.1.0`; build from the lockfile and record the actual built image IDs with the application revision before deployment/upgrade. Registry publication and signing are not configured.

Primary sources:

- [Node official image](https://hub.docker.com/_/node) and [Node release schedule](https://nodejs.org/en/about/previous-releases).
- [PostgreSQL official image](https://hub.docker.com/_/postgres), [PostgreSQL 17 pg_dump](https://www.postgresql.org/docs/17/app-pgdump.html), and [PostgreSQL 17 pg_restore](https://www.postgresql.org/docs/17/app-pgrestore.html).
- [Caddy official image](https://hub.docker.com/_/caddy) and [Caddy reverse_proxy](https://caddyserver.com/docs/caddyfile/directives/reverse_proxy).
- [Apache Guacamole 1.6.0 release](https://guacamole.apache.org/releases/1.6.0/), [versioned Docker manual](https://guacamole.apache.org/doc/1.6.0/gug/guacamole-docker.html), and [versioned JSON authentication](https://guacamole.apache.org/doc/1.6.0/gug/json-auth.html). The matching JSON extension is bundled in the official web image; enable only in the proof harness. No separate unverified JAR is downloaded by this deployment.
- [restic 0.18.1 release](https://restic.net/blog/2025-09-21/restic-0.18.1-released/), [restic repository checks](https://restic.readthedocs.io/en/stable/045_working_with_repos.html), and [SQLite Online Backup API](https://www.sqlite.org/backup.html).
- [Compose merge and override behavior](https://docs.docker.com/reference/compose-file/merge/) and [Docker bind-mount ownership/location](https://docs.docker.com/engine/storage/bind-mounts/).

No Linux/Windows service installation, real Guacamole/browser connection, provider model version, execution-account permission result, backup snapshot, or restore time is implied by this table. Record those actual deployed versions in the acceptance inventory.
