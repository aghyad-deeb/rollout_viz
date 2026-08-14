import { useEffect, useState } from 'react';

export interface ServerConfig {
  /** Base URL of the web_chat deployment, or null when not configured
   *  (hides the "Open in web_chat" action entirely). */
  web_chat_base_url: string | null;
}

// Module-level cache: the config is static per server process, so one fetch
// per page load is enough no matter how many components use the hook.
let cached: ServerConfig | null = null;

export function _resetServerConfigCache() {
  cached = null;
}

/**
 * Fetch /api/config once. `enabled` should be false until the user is
 * authenticated — a pre-auth fetch would 401 and never retry.
 */
export function useServerConfig(enabled: boolean): ServerConfig | null {
  const [config, setConfig] = useState<ServerConfig | null>(cached);

  useEffect(() => {
    if (!enabled || cached) return;
    let alive = true;
    fetch('/api/config')
      .then((r) => (r.ok ? r.json() : null))
      .then((data) => {
        if (alive && data) {
          cached = data;
          setConfig(data);
        }
      })
      .catch(() => {
        // Non-fatal: actions gated on config just stay hidden.
      });
    return () => {
      alive = false;
    };
  }, [enabled]);

  return config;
}
