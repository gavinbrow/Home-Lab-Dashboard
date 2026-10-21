# Desktop deployment and API

Use matching Apache Guacamole webapp, guacd and JSON extension 1.6.0 on internal networks with no direct published webapp/guacd route. API settings:

```text
GUACAMOLE_INTERNAL_URL=http://guacamole:8080/guacamole/
GUACAMOLE_JSON_KEY_FILE=/run/secrets/guacamole_api_key
```

The protected key file contains exactly 32 hexadecimal characters. Guacamole JSON authentication uses the same key. Server-only `GUACAMOLE_JSON_KEY` is an alternative for isolated tests. Request bodies, Authorization and cookies must not be logged.

Build `docs/remote/gateway-extension` with `mvn package`, then install `target/homelab-session-lease-1.0.0.jar` in `GUACAMOLE_HOME/extensions` and restart Guacamole. Configure the extension:

```text
HOMELAB_SESSION_CHECK_URL=http://api:3000/internal/remote/desktop-session-check
HOMELAB_JSON_KEY_FILE=/run/secrets/guacamole_json_key
```

That key file is the same JSON key, readable by Guacamole's service identity. The reviewed builder was Maven 3.9.9/Temurin 17, image digest `sha256:f58d59b6273e785ac0a4477f6e9b5ba1d7731c75b906c0f7b34076f1851318cc`. The extension depends on the provided Guacamole 1.6 API, not private webapp administration endpoints.

The listener derives a domain-separated HMAC authentication header. The internal POST carries a session UUID in the body and checks the actual desktop row, owner relation, originating browser session, expiry, revocation and restore mode. Its fresh heartbeat is required before API launch/attach. Every actual TunnelConnectEvent is checked and vetoed/closed when denied. Retained actual tunnel objects are independently checked each second and closed on denial or network failure. There are at most sixteen retained tunnels, nonoverlapping checks, and 750 ms connect/read limits; failure closure can take approximately 2.5 seconds. A delayed event arriving after the API's 20 second handshake timeout sees the closed lease and is vetoed even when the API never obtained an upstream UUID.

The browser gateway also closes local transports on logout/revoke/state-store failure, idle timeout, maximum lifetime and API preClose. Both WebSocket and HTTP fallback use a backend stock HTTP tunnel: authentication token only in a POST body, upstream tunnel token only in a header. No upstream token or UUID reaches the browser or a URL. Browser tunnel UUIDs are compatibility identifiers requiring the bound app session on every request. Single API-process ownership is intentional; multiple API replicas need transport affinity before deployment.

Routes under `/api/v1`:

- `POST /remote/desktop-connections`: `{machine_id,config:{hostname,port,protocol:"rdp"|"vnc",username?,domain?,session_mode:"physical_screen"|"remote_session"|"unverified",server_type},credential:{password}}`. Explicit blank password supports an intentionally configured no-auth VNC endpoint. Creating a connection cannot pre-certify observed behavior.
- `POST /desktop-sessions` with `{connection_id}` returns `{id,ticket,expires_at,session_mode,session_mode_verified}`. Ticket lifetime 30 seconds.
- `POST /desktop-sessions/:id/attach` with `{ticket,width?,height?}` returns `{id,tunnel_path,session_mode,session_mode_verified}`. Wrong owner, another login, expiry and reuse are denied.
- Use vendored official 1.6 common-js `ChainedTunnel(WebSocketTunnel(tunnel_path+"/websocket"),HTTPTunnel(tunnel_path+"/http",false,{"X-CSRF-Token":csrfToken}))`. Call `client.connect("")`, with no query parameters or tokens. The HttpOnly app cookie authenticates transports.
- `POST /desktop-sessions/:id/revoke` closes the session; call during panel cleanup.
- `POST /remote/desktop-connections/:id/observation`: `{desktop_session_id,operator_observed:true,session_mode,local_screen_behavior:"remains_visible"|"locks"|"other",keyboard:true,mouse:true,resize:true,reconnect:true}`. The same login needs a recent successful connect audit for the exact connection revision. This is explicit human observation, not inferred from protocol names.

Capability jobs capture the submitting browser session explicitly, validate it and allocate a short-lived lease for an authenticated display-handshake probe. They close the lease in `finally`. Without that captured session, they retain unverified/degraded status rather than impersonating another login. A display handshake does not certify real browser controls or physical-screen behavior.

