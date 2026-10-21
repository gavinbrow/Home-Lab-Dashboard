# Compatibility and version evidence

Runtime production target Node 24 LTS; local current Node 22.12.0. Root pins Fastify 5.12.7, PostgreSQL client pg 8.23.1, Zod 4.6.7, TypeScript 5.9.3, tsx 4.23.15, cookie plugin 11.1.3. npm registry queried during implementation; lockfile is authoritative. PostgreSQL 18 is a supported stable line; do not adopt release candidate 19.

Upstream verification: [Node releases](https://nodejs.org/en/about/previous-releases), [Fastify TypeScript](https://fastify.dev/docs/latest/Reference/TypeScript/), [PostgreSQL version policy](https://www.postgresql.org/support/versioning/). Container exact versions/digests are recorded by operations. Go toolchain and platform dependency versions are recorded by host owner. Installed version does not imply tested machine compatibility.

Actual Windows/Linux OS versions, Guacamole session behavior, GPU support and provider APIs: unverified pending setup. Per-component tests must report fixtures distinctly. Released dependency pins are reproducible choices, not a live feature claim.
