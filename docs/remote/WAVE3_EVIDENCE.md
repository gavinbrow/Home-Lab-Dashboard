# Strict remote-access proof after resume

2026-10-21 UTC. This supersedes the unresolved delayed-handshake gate in the historical wave2 record. It does not change that record's confounded result.

## Actual Guacamole lifecycle proof

Actual isolated PostgreSQL 17.11, Guacamole/guacd 1.6.0, installed `homelab-session-lease-1.0.0.jar`, and Xvfb/x11vnc were restarted from the preserved owned `homelab-ops-wave2` project. No external host was guessed or contacted. The required listener artifact/configuration remained installed; no private Guacamole administration endpoint was introduced.

The monitor now uses the vendored official Apache 1.6.0 Parser. It follows official Client.js behavior: reply to server sync with the timestamp only, and send nop keep-alives every five seconds even when the screen is quiet. An initial corrected run failed the fresh-sync assertion because an idle screen need not produce periodic sync. That assertion was replaced with actual open/error-free stream state, completed sync acknowledgements, continued successful keep-alive writes and explicit elapsed target lifetime. The liveness gate was retained.

The strict actual run passed: one test, zero failures, 29.689 seconds (30.138 seconds including runner). The actual VNC target remained alive for **20,250 ms before lease revocation**, with two completed sync acknowledgements and four keep-alives. The gateway's normal twenty-second connect request had already timed out without learning the private upstream tunnel UUID/token. Only then was the durable session lease closed. The independent installed Guacamole listener ended that still-live unknown-ID upstream stream **524 ms after lease closure**. This proves termination was not merely the earlier idle timeout or a browser facade close.

The same run also passed atomic one-use launch replay/session binding, active HTTP revoke, active WebSocket logout, database-only restore-mode closure and denial, immediate unknown-ID lease closure, late-connect event veto after lease closure, and authoritative callback API outage closing a tunnel outside the API transport registry. These branches use actual upstream Guacamole/guacd/VNC, not just the loopback protocol fixture.

Raw secret-free result: [guacamole-wave3-strict.txt](evidence/guacamole-wave3-strict.txt), SHA256 `142c4ae313d9c8bdb83d24e8e4c30f9c19dc5d370b4a2e7bf0460dea1f4019e3`. The driver ran with a unique disposable database, protected key/admin files, no published fixture port, read-only code/vendor mounts, dropped capabilities and `--rm`; it exited. Production browser launches still require current owner session, single-use ticket, enabled connection, durable maintenance/restore checks and fresh listener heartbeat.

## Packaged image recheck after final migration cut

The source-built production Guacamole image was tested again after the final 018 application cut. Operations replaced only Guacamole, retaining the isolated PostgreSQL, guacd, VNC target and protected keys. The test used packaged Guacamole image SHA256 `a3821688bd3d9ef9120ed9605608e0b46e32fba2485202c000a681aa6ef56424` and application image `homelab-control:core018-output-host9b`, SHA256 `ccfe50162597c9c279eaa7c5413d1bad3eb3711a3b8cde342540e75f3c522a6a`, with no application source overlay.

The same actual gateway test passed: one test, zero failures, 35.362 seconds including runner. The unknown-ID target remained alive for 20,250 ms before revocation, with two sync acknowledgements and four keep-alives; authoritative lease closure ended its upstream stream in 523 ms. The disposable test driver exited successfully and was removed. Raw result: [guacamole-packaged-check.txt](evidence/guacamole-packaged-check.txt), SHA256 `e768554a20f7b32e1166be2a595f87631edf3dfb53d6856c407dfdb71d223ad4`. This verifies the packaged listener as well as the earlier mounted-JAR proof. No browser desktop consumer was active during replacement.

## Connection lifecycle regression

Actual disposable loopback PostgreSQL 18.4 integration passed in `connections.test.ts`: encrypted credential replacement increments version and revokes both issued/active sessions; stale expected versions fail; disabled connections cannot launch; three concurrent issuance-versus-disable cases leave no usable issued/active ticket; cross-owner disable/replacement is denied; SFTP verification and observed-desktop proof are invalidated; client-supplied verification time is denied; affected machine capability returns unverified. No SSH/desktop destination was contacted by this metadata test.

Credential replacement changes the backend-held credential only. It does not rotate a password/key on the target host. Disabled connection records/history remain retained. Ticket creation serializes on the connection revision so an old authorized request cannot mint a fresh unrevoked ticket after the disable transaction.

## Scope of verification

These are real component/protocol/OS fixtures. The prior actual OpenSSH Linux chroot proof remains valid. They do not certify a user's actual Windows/Linux account, an RDP certificate policy, a physical screen, keyboard/mouse behavior on a real desktop, local-screen locking, or a home-network route. Those require configured endpoint observations. Native human SSH remains broad; restricted workspace PTY/ConPTY is a separate host/job transport.

Sources: [official Client.js 1.6.0 sync and keep-alive behavior](https://github.com/apache/guacamole-client/blob/1.6.0/guacamole-common-js/src/main/webapp/modules/Client.js), [documented listener API](https://guacamole.apache.org/doc/1.6.0/gug/event-listeners.html), [TunnelConnectEvent veto semantics](https://github.com/apache/guacamole-client/blob/1.6.0/guacamole-ext/src/main/java/org/apache/guacamole/net/event/TunnelConnectEvent.java).
