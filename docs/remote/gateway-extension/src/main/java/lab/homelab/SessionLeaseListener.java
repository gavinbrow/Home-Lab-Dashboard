package lab.homelab;

import java.net.HttpURLConnection;
import java.net.URL;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Paths;
import java.util.Map;
import java.util.Set;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.Executors;
import java.util.concurrent.ScheduledExecutorService;
import java.util.concurrent.TimeUnit;
import javax.crypto.Mac;
import javax.crypto.spec.SecretKeySpec;
import org.apache.guacamole.GuacamoleException;
import org.apache.guacamole.GuacamoleSecurityException;
import org.apache.guacamole.net.GuacamoleTunnel;
import org.apache.guacamole.net.event.TunnelConnectEvent;
import org.apache.guacamole.net.event.listener.Listener;

/** Uses only the documented Guacamole 1.6.0 listener/tunnel API. */
public final class SessionLeaseListener implements Listener {
    private final URL checkUrl;
    private final String authorization;
    private final Map<GuacamoleTunnel, String> tunnels = new ConcurrentHashMap<>();
    private final Set<GuacamoleTunnel> checking = ConcurrentHashMap.newKeySet();
    private final ScheduledExecutorService scheduler = Executors.newScheduledThreadPool(17, task -> {
        Thread thread = new Thread(task, "homelab-desktop-session-lease");
        thread.setDaemon(true);
        return thread;
    });

    public SessionLeaseListener() throws Exception {
        checkUrl = new URL(required("HOMELAB_SESSION_CHECK_URL"));
        if (!checkUrl.getProtocol().equals("http") && !checkUrl.getProtocol().equals("https"))
            throw new IllegalArgumentException("Invalid session check scheme");
        String hex = new String(Files.readAllBytes(Paths.get(required("HOMELAB_JSON_KEY_FILE"))), StandardCharsets.UTF_8).trim();
        if (!hex.matches("[a-fA-F0-9]{32}")) throw new IllegalArgumentException("Invalid gateway key file");
        byte[] key = new byte[16];
        for (int index = 0; index < key.length; index++) key[index] = (byte) Integer.parseInt(hex.substring(index * 2, index * 2 + 2), 16);
        Mac mac = Mac.getInstance("HmacSHA256");
        mac.init(new SecretKeySpec(key, "HmacSHA256"));
        StringBuilder token = new StringBuilder();
        for (byte value : mac.doFinal("homelab-guacamole-session-lease-v1".getBytes(StandardCharsets.UTF_8))) token.append(String.format("%02x", value & 0xff));
        authorization = "Bearer " + token;
        scheduler.scheduleWithFixedDelay(() -> check(null), 0, 1, TimeUnit.SECONDS);
        scheduler.scheduleWithFixedDelay(() -> {
            for (Map.Entry<GuacamoleTunnel, String> item : tunnels.entrySet()) {
                GuacamoleTunnel tunnel = item.getKey();
                if (!tunnel.isOpen()) { tunnels.remove(tunnel); continue; }
                if (checking.add(tunnel)) scheduler.execute(() -> {
                    try {
                        if (!check(item.getValue())) {
                            try { tunnel.close(); } catch (GuacamoleException ignored) { }
                            tunnels.remove(tunnel);
                        }
                    } finally { checking.remove(tunnel); }
                });
            }
        }, 0, 1, TimeUnit.SECONDS);
    }

    private static String required(String name) {
        String value = System.getenv(name);
        if (value == null || value.isEmpty()) throw new IllegalArgumentException("Missing gateway extension configuration: " + name);
        return value;
    }

    private boolean check(String sessionId) {
        HttpURLConnection request = null;
        try {
            request = (HttpURLConnection) checkUrl.openConnection();
            request.setConnectTimeout(750); request.setReadTimeout(750); request.setInstanceFollowRedirects(false);
            request.setRequestMethod("POST"); request.setDoOutput(true);
            request.setRequestProperty("Authorization", authorization);
            request.setRequestProperty("Content-Type", "application/json");
            String json = "{\"session_id\":" + (sessionId == null ? "null" : "\"" + sessionId + "\"")
                + ",\"extension_version\":\"1.0.0\",\"guacamole_version\":\"1.6.0\"}";
            try (java.io.OutputStream output = request.getOutputStream()) { output.write(json.getBytes(StandardCharsets.UTF_8)); }
            return request.getResponseCode() == 204;
        } catch (Exception ignored) { return false; }
        finally { if (request != null) request.disconnect(); }
    }

    @Override public void handleEvent(Object event) throws GuacamoleException {
        if (!(event instanceof TunnelConnectEvent)) return;
        TunnelConnectEvent connection = (TunnelConnectEvent) event;
        String username = connection.getAuthenticatedUser() == null ? "" : connection.getAuthenticatedUser().getIdentifier();
        if (username == null || !username.matches("dashboard-[a-fA-F0-9-]{36}")) {
            connection.getTunnel().close(); throw new GuacamoleSecurityException("Desktop session lease required");
        }
        String sessionId = username.substring("dashboard-".length());
        if (!check(sessionId)) {
            connection.getTunnel().close(); throw new GuacamoleSecurityException("Desktop session lease denied");
        }
        synchronized (tunnels) {
            if (tunnels.size() >= 16) {
                connection.getTunnel().close(); throw new GuacamoleSecurityException("Desktop session capacity reached");
            }
            tunnels.put(connection.getTunnel(), sessionId);
        }
    }
}
