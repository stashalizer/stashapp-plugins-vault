/**
 * ExternalLinkGroupsIcons — resolve and cache the icon of each configured site.
 *
 * What is cached is the **URL that worked**, not the image bytes:
 *
 *   - `fetch()` cannot read a cross-origin icon (CORS), and Stash's CSP only
 *     allows external images through `img-src`, not `connect-src`;
 *   - the browser already caches the bytes of an <img> request;
 *   - what is expensive and unreliable is *finding* a working source, and that
 *     is exactly what this module remembers.
 *
 * Resolution order is `Shared.iconCandidates()`: the site's own /favicon.ico,
 * then DuckDuckGo, then Google. Candidates are probed one at a time with an
 * <img> (4s budget each) because a host that black-holes the request never
 * fires onload or onerror, and because probing three sources in parallel
 * triples the outbound requests on every cold domain.
 *
 * Invalidation, in the order it happens:
 *   1. `img.onerror` on the rendered icon  → `reportBroken(domain, src)`, which
 *      drops the cache entry, blacklists that source for the session and
 *      re-resolves to the next candidate. When every candidate has failed the
 *      result is cached as a negative entry and the UI falls back to a letter
 *      tile.
 *   2. TTL — 30 days for a hit, 6 hours for a miss, so a site that was down is
 *      retried the same day but a working icon is not re-probed on every page.
 *   3. `clear()` / `refresh(domain)` from the settings page.
 *   4. The `v` field of the stored blob: a schema change bumps it and the old
 *      cache is discarded wholesale.
 *
 * The cache lives in localStorage, not in the plugin config: it is derived,
 * browser-specific data, and syncing it through the server would fight every
 * other device's TTLs for no benefit.
 *
 * License: AGPL-3.0
 */
(function () {
  "use strict";

  var S = window.ExternalLinkGroupsShared;
  if (!S) {
    console.error("ExternalLinkGroups: shared module missing; icons will not resolve.");
    return;
  }

  var CACHE_VERSION = 1;

  var cache = {};
  var failed = {}; // domain -> { [src]: true }, session-only
  var inflight = {};
  var listeners = [];

  function canProbe() {
    return typeof window.Image === "function";
  }

  function readCache() {
    try {
      var raw = window.localStorage.getItem(S.ICON_CACHE_KEY);
      if (!raw) return {};
      var parsed = JSON.parse(raw);
      if (!parsed || parsed.v !== CACHE_VERSION || !parsed.entries) return {};
      return parsed.entries;
    } catch (err) {
      return {};
    }
  }

  function writeCache() {
    try {
      window.localStorage.setItem(
        S.ICON_CACHE_KEY,
        JSON.stringify({ v: CACHE_VERSION, entries: cache })
      );
      return true;
    } catch (err) {
      // Quota or private mode: the in-memory copy still works for this page.
      return false;
    }
  }

  function notify() {
    listeners.slice().forEach(function (fn) {
      try {
        fn();
      } catch (err) {
        console.error("ExternalLinkGroups: icon listener threw", err);
      }
    });
  }

  function isFresh(entry) {
    if (!entry || typeof entry.ts !== "number") return false;
    var ttl = entry.ok ? S.ICON_TTL_MS : S.ICON_FAIL_TTL_MS;
    return Date.now() - entry.ts < ttl;
  }

  /** Cached entry for a domain, or null when absent/expired. */
  function get(domain) {
    var host = S.normalizeDomain(domain);
    if (!host) return null;
    var entry = cache[host];
    return isFresh(entry) ? entry : null;
  }

  function probe(src) {
    return new Promise(function (resolve) {
      if (!canProbe()) {
        resolve(false);
        return;
      }

      var settled = false;
      var img = new window.Image();
      var timer = window.setTimeout(function () {
        finish(false);
      }, S.ICON_PROBE_TIMEOUT_MS);

      function finish(ok) {
        if (settled) return;
        settled = true;
        window.clearTimeout(timer);
        img.onload = null;
        img.onerror = null;
        resolve(ok);
      }

      img.onload = function () {
        // A "successful" response that is not a decodable image (an HTML error
        // page served with 200) reports zero intrinsic size.
        finish(img.naturalWidth > 0 || img.width > 0);
      };
      img.onerror = function () {
        finish(false);
      };

      // Do not leak the Stash URL to the icon service or to the site.
      img.referrerPolicy = "no-referrer";
      img.src = src;
    });
  }

  function chain(candidates, index, host) {
    if (index >= candidates.length) return Promise.resolve(null);

    return probe(candidates[index]).then(function (ok) {
      if (ok) return candidates[index];
      failed[host][candidates[index]] = true;
      return chain(candidates, index + 1, host);
    });
  }

  function entryFor(host, src) {
    var entry = { src: src || null, ts: Date.now(), ok: !!src };
    cache[host] = entry;
    writeCache();
    return entry;
  }

  function resolve(host) {
    if (inflight[host]) return inflight[host];

    var candidates = S.iconCandidates(host).filter(function (src) {
      return !failed[host][src];
    });

    if (!candidates.length) {
      var missed = entryFor(host, null);
      notify();
      return Promise.resolve(missed);
    }

    inflight[host] = chain(candidates, 0, host).then(function (src) {
      delete inflight[host];
      var entry = entryFor(host, src);
      notify();
      return entry;
    });

    return inflight[host];
  }

  /** Resolve if needed; a fresh cache entry (including a negative one) wins. */
  function ensure(domain) {
    var host = S.normalizeDomain(domain);
    if (!host) return Promise.resolve(null);

    var cached = get(host);
    if (cached) return Promise.resolve(cached);

    if (!failed[host]) failed[host] = {};
    return resolve(host);
  }

  /** Force a re-probe, e.g. from the settings page. */
  function refresh(domain) {
    var host = S.normalizeDomain(domain);
    if (!host) return Promise.resolve(null);

    delete cache[host];
    failed[host] = {};
    delete inflight[host];
    return resolve(host);
  }

  /**
   * The rendered <img> failed. Drop the entry, never retry that exact source in
   * this session, and let the caller re-read `get()`/`ensure()` — which now
   * advances to the next candidate or falls back to a letter tile.
   */
  function reportBroken(domain, src) {
    var host = S.normalizeDomain(domain);
    if (!host) return;

    var entry = cache[host];
    if (entry && src && entry.src !== src) return; // stale report, ignore

    delete cache[host];
    if (!failed[host]) failed[host] = {};
    if (src) failed[host][src] = true;
    writeCache();
    notify();
  }

  function clear() {
    cache = {};
    failed = {};
    inflight = {};
    writeCache();
    notify();
  }

  function subscribe(fn) {
    if (typeof fn !== "function") return function () {};
    listeners.push(fn);
    return function () {
      var index = listeners.indexOf(fn);
      if (index !== -1) listeners.splice(index, 1);
    };
  }

  cache = readCache();

  window.ExternalLinkGroupsIcons = {
    get: get,
    ensure: ensure,
    refresh: refresh,
    reportBroken: reportBroken,
    clear: clear,
    subscribe: subscribe,
    canProbe: canProbe,
  };
})();
