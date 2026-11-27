/**
 * ExternalLinkGroupsShared — the data model for External Link Groups.
 *
 * Pure: no DOM, no storage, no network. It is listed first in the manifest so
 * the page patch and the settings page read the same schema, and it also runs
 * unchanged under `node --test` (see tests/external-link-groups.test.mjs).
 *
 * The persisted config is one object, stored as the whole plugin config map:
 *
 *   {
 *     version: 1,
 *     domains: [
 *       { domain: "onlyfans.com", enabled: true,  separate: true  },
 *       { domain: "twitter.com",  enabled: true,  separate: false },
 *       { domain: "tiktok.com",   enabled: false, separate: true  }
 *     ]
 *   }
 *
 * `domain` is a bare hostname — never a URL, never a port, never a path. It is
 * normalized on write and on read, so a pasted profile URL also works.
 *
 * The two flags are not synonyms:
 *   - `enabled: false`   → the entry is ignored. Its URLs are handed back to
 *                          Stash untouched and no icon is requested.
 *   - `enabled: true` and `separate: true`
 *                        → that domain's URLs are pulled out of Stash's groups
 *                          and rendered as their own icon button.
 *   - `enabled: true` and `separate: false`
 *                        → the URLs are still owned by the plugin, but share one
 *                          "configured sites" button instead of getting a
 *                          button (and an icon fetch) of their own.
 *
 * Matching is an exact hostname comparison after normalization (lowercase,
 * trailing dot and a leading `www.` removed). Subdomains are deliberately NOT
 * matched: `onlyfans.com` does not claim `fan.onlyfans.com`. Anything the
 * plugin does not claim ends up in `rest` and is rendered by Stash exactly as
 * it was before the plugin was installed.
 *
 * The settings page does not make the user type every domain by hand.
 * `summarizeUrls` ranks the domains a library actually links to,
 * `suggestDomains` subtracts the ones already configured, and the page appends
 * the rest to the draft — the user reviews them and still presses Save. This
 * module stays pure: reading the library is ExternalLinkGroupsScan.js,
 * persisting is ExternalLinkGroupsStore.js.
 *
 * License: AGPL-3.0
 */
(function () {
  "use strict";

  var CONFIG_KEY = "ExternalLinkGroups";
  var CONFIG_STORAGE_KEY = "externalLinkGroups.config.v1";
  var ICON_CACHE_KEY = "externalLinkGroups.icons.v1";

  var VERSION = 1;
  var MAX_DOMAINS = 32;
  var MAX_DOMAIN_LENGTH = 253;
  // How many suggestions the settings page offers at once, and how many of them
  // start checked. Both are UI budgets, not limits of the model: the library
  // summary itself is never truncated.
  var SUGGEST_LIMIT = 25;
  var SUGGEST_PRESELECT = 5;

  // Paging bounds for ExternalLinkGroupsScan. A Stash library is small enough
  // that these are a guard against a runaway loop (a bad `count`, a server that
  // keeps answering) rather than a ceiling users should meet.
  var SCAN_PAGE_SIZE = 200;
  var SCAN_MAX_PAGES = 25;

  // The three Stash entities that carry a URL list and whose detail pages render
  // `ExternalLinkButtons`. Kept here so the scan query, the flattening and the
  // per-entity totals all read the same names.
  var LIBRARY_SOURCES = [
    { query: "findPerformers", field: "performers" },
    { query: "findStudios", field: "studios" },
    { query: "findGroups", field: "groups" },
  ];

  // How long a resolved icon URL is trusted. A hit is a URL, not image bytes:
  // the browser does the byte caching, we only remember which candidate worked.
  var ICON_TTL_MS = 30 * 24 * 60 * 60 * 1000;
  // Negative results expire faster — a site that was down this morning is
  // usually worth retrying the same day.
  var ICON_FAIL_TTL_MS = 6 * 60 * 60 * 1000;
  // Per-candidate budget. A host that black-holes the request never fires
  // onload or onerror, so the probe needs its own deadline.
  var ICON_PROBE_TIMEOUT_MS = 4000;

  // One hostname label: 1–63 chars, alphanumeric at both ends, hyphens inside.
  var LABEL = "[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?";
  var HOSTNAME_RE = new RegExp("^" + LABEL + "(?:\\." + LABEL + ")+$");
  var SCHEME_RE = /^([a-z][a-z0-9+.-]*):\/\//i;
  // A scheme never contains a dot, so "onlyfans.com:443" is a host and port
  // while "mailto:me@example.com" is not a browsable profile link.
  var OPAQUE_SCHEME_RE = /^([a-z][a-z0-9+.-]*):/i;

  function hasOpaqueScheme(value) {
    var match = value.match(OPAQUE_SCHEME_RE);
    return !!match && match[1].indexOf(".") === -1;
  }

  function makeDefaultConfig() {
    return { version: VERSION, domains: [] };
  }

  /**
   * Reduce anything a user may paste to a bare hostname, or null.
   *
   * Accepts `onlyfans.com`, `www.OnlyFans.com/username?x=1`,
   * `https://user:pw@onlyfans.com:443/a/b#top`. Rejects non-http schemes
   * (`mailto:`, `tg:`), single-label hosts and anything with a space.
   */
  function normalizeDomain(value) {
    if (typeof value !== "string") return null;

    var raw = value.trim().toLowerCase();
    if (!raw || raw.length > MAX_DOMAIN_LENGTH * 4) return null;
    if (/\s/.test(raw)) return null;

    var scheme = raw.match(SCHEME_RE);
    if (scheme && scheme[1] !== "http" && scheme[1] !== "https") return null;
    if (!scheme && hasOpaqueScheme(raw)) return null;

    var rest = scheme ? raw.slice(scheme[0].length) : raw;
    var authority = rest.split(/[/?#]/)[0];
    if (!authority) return null;

    // userinfo@host:port — keep the host, drop the rest.
    var host = authority.slice(authority.lastIndexOf("@") + 1);
    host = host.split(":")[0];
    host = host.replace(/\.+$/, "");
    if (host.indexOf("www.") === 0) host = host.slice(4);

    if (!host || host.length > MAX_DOMAIN_LENGTH) return null;
    if (!HOSTNAME_RE.test(host)) return null;

    return host;
  }

  /** Hostname of a stored performer/studio URL, normalized the same way. */
  function hostnameOf(url) {
    if (typeof url !== "string") return null;
    var value = url.trim();
    if (!value) return null;
    return normalizeDomain(value);
  }

  /**
   * Turn a stored URL into something an <a href> can open.
   *
   * Mirrors Stash's `TextUtils.sanitiseURL` for the no-siteURL case (Stash
   * links bare hosts with https://), but refuses opaque schemes instead of
   * prefixing them with https:// — "mailto:me@example.com" is not a profile.
   */
  function toHref(url) {
    if (typeof url !== "string") return null;

    var value = url.trim();
    if (!value) return null;
    if (/^https?:\/\//i.test(value)) return value;
    if (hasOpaqueScheme(value)) return null;

    return "https://" + value.replace(/^\/+/, "");
  }

  function toBool(value, fallback) {
    if (typeof value === "boolean") return value;
    if (value === 1 || value === "1" || value === "true") return true;
    if (value === 0 || value === "0" || value === "false") return false;
    return fallback;
  }

  function sanitizeEntry(raw) {
    if (!raw || typeof raw !== "object") return null;

    var domain = normalizeDomain(raw.domain);
    if (!domain) return null;

    return {
      domain: domain,
      enabled: toBool(raw.enabled, true),
      separate: toBool(raw.separate, true),
    };
  }

  /**
   * Coerce anything stored (including hand-edited or pre-0.1 configs) into the
   * current schema. Accepts a bare array of entries as a convenience, drops
   * unparseable entries instead of throwing, keeps the first of two entries for
   * the same domain (config order is display order) and caps the list.
   */
  function sanitizeConfig(raw) {
    var source = Array.isArray(raw) ? raw : raw && typeof raw === "object" ? raw.domains : null;

    var domains = [];
    var seen = {};

    if (Array.isArray(source)) {
      for (var i = 0; i < source.length; i += 1) {
        var entry = sanitizeEntry(source[i]);
        if (!entry) continue;
        if (seen[entry.domain]) continue;
        seen[entry.domain] = true;
        domains.push(entry);
        if (domains.length >= MAX_DOMAINS) break;
      }
    }

    return { version: VERSION, domains: domains };
  }

  function findEntry(config, domain) {
    if (!domain) return null;
    var domains = sanitizeConfig(config).domains;
    for (var i = 0; i < domains.length; i += 1) {
      if (domains[i].domain === domain) return domains[i];
    }
    return null;
  }

  /**
   * Split a detail page's URL list into the three render buckets.
   *
   * Returns `{ separate, bucket, rest }`:
   *   separate → [{ domain, urls }] in config order, empty groups omitted
   *   bucket   → urls of enabled-but-not-separate domains, page order
   *   rest     → everything Stash keeps rendering, page order
   *
   * Exact duplicate URLs are collapsed (Stash keys its menu by URL), blank and
   * non-string entries are dropped rather than passed through.
   */
  function partition(urls, config) {
    var entries = sanitizeConfig(config).domains;

    var groups = [];
    var groupByDomain = {};
    var entryByDomain = {};
    var bucket = [];
    var rest = [];
    var seenUrl = {};

    for (var i = 0; i < entries.length; i += 1) {
      entryByDomain[entries[i].domain] = entries[i];
      if (!entries[i].enabled || !entries[i].separate) continue;
      groupByDomain[entries[i].domain] = { domain: entries[i].domain, urls: [] };
      groups.push(groupByDomain[entries[i].domain]);
    }

    var list = Array.isArray(urls) ? urls : [];
    for (var j = 0; j < list.length; j += 1) {
      var url = list[j];
      if (typeof url !== "string") continue;

      var trimmed = url.trim();
      if (!trimmed || seenUrl[trimmed]) continue;
      seenUrl[trimmed] = true;

      var entry = entryByDomain[hostnameOf(trimmed)] || null;
      if (!entry || !entry.enabled) {
        rest.push(trimmed);
      } else if (entry.separate && groupByDomain[entry.domain]) {
        groupByDomain[entry.domain].urls.push(trimmed);
      } else {
        bucket.push(trimmed);
      }
    }

    return {
      separate: groups.filter(function (group) {
        return group.urls.length > 0;
      }),
      bucket: bucket,
      rest: rest,
    };
  }

  /**
   * Flatten the URL lists of a Stash library payload into one array.
   *
   * `data` is what a GraphQL query built from `LIBRARY_SOURCES` returns
   * (`{ findPerformers: { performers: [{ urls }] }, … }`); a bare array of
   * entities is accepted too, which is what a test or a single page looks like.
   * Missing, non-array and non-string pieces are skipped instead of throwing —
   * Stash pads its own responses with nulls and an old performer may have no
   * `urls` field at all.
   */
  function urlsFromLibrary(data) {
    var out = [];

    function take(list) {
      if (!Array.isArray(list)) return;
      for (var i = 0; i < list.length; i += 1) {
        var entity = list[i];
        if (!entity || typeof entity !== "object" || !Array.isArray(entity.urls)) continue;
        for (var j = 0; j < entity.urls.length; j += 1) {
          if (typeof entity.urls[j] === "string") out.push(entity.urls[j]);
        }
      }
    }

    if (Array.isArray(data)) {
      take(data);
      return out;
    }
    if (!data || typeof data !== "object") return out;

    for (var i = 0; i < LIBRARY_SOURCES.length; i += 1) {
      var page = data[LIBRARY_SOURCES[i].query];
      if (page && typeof page === "object") take(page[LIBRARY_SOURCES[i].field]);
    }

    return out;
  }

  /**
   * Count how many distinct links each domain owns.
   *
   * Returns `[{ domain, count, sample }]`, sorted by count descending and then
   * by domain, so the order is identical across scans and the settings page can
   * pre-select the head of the list.
   *
   * `count` is a count of **distinct links**, not of entities: Stash happily
   * stores the same profile URL on a performer and on the studio that owns the
   * account, and two rows pointing at one page are one link. Links the plugin
   * cannot parse (opaque schemes, hostless strings, junk) are dropped rather
   * than grouped under a placeholder — a suggestion nobody can act on is worse
   * than a shorter list. `sample` is the first link seen for the domain, for the
   * tooltip.
   */
  function summarizeUrls(urls) {
    var byDomain = {};
    var order = [];
    var seen = {};
    var list = Array.isArray(urls) ? urls : [];

    for (var i = 0; i < list.length; i += 1) {
      if (typeof list[i] !== "string") continue;

      var url = list[i].trim();
      if (!url || seen[url]) continue;
      seen[url] = true;

      var domain = hostnameOf(url);
      if (!domain) continue;

      if (!byDomain[domain]) {
        byDomain[domain] = { domain: domain, count: 0, sample: url };
        order.push(domain);
      }
      byDomain[domain].count += 1;
    }

    var summary = [];
    for (var j = 0; j < order.length; j += 1) summary.push(byDomain[order[j]]);

    summary.sort(function (a, b) {
      if (a.count !== b.count) return b.count - a.count;
      if (a.domain === b.domain) return 0;
      return a.domain < b.domain ? -1 : 1;
    });

    return summary;
  }

  /**
   * Domains from a summary that the config does not already own, most used
   * first, at most `limit` of them and never more than `MAX_DOMAINS` allows.
   *
   * The filter is deliberately about **presence, not enablement**: a domain the
   * user configured and then switched off is a decision, and re-suggesting it
   * would overwrite that decision with a default. Entries are returned as new
   * objects — nothing here writes to the config or to the summary, the caller
   * decides what to do with the result.
   */
  function suggestDomains(config, candidates, limit) {
    var entries = sanitizeConfig(config).domains;
    var taken = {};
    for (var i = 0; i < entries.length; i += 1) taken[entries[i].domain] = true;

    var capacity = MAX_DOMAINS - entries.length;
    if (capacity <= 0) return [];

    var max = typeof limit === "number" && isFinite(limit) && limit > 0 ? Math.floor(limit) : SUGGEST_LIMIT;
    if (max > capacity) max = capacity;

    var pool = Array.isArray(candidates) ? candidates : [];
    var fresh = [];
    var seen = {};

    for (var j = 0; j < pool.length; j += 1) {
      var raw = pool[j];
      var domain = normalizeDomain(typeof raw === "string" ? raw : raw && raw.domain);
      if (!domain || taken[domain] || seen[domain]) continue;
      seen[domain] = true;
      fresh.push({
        domain: domain,
        count: raw && typeof raw.count === "number" && raw.count > 0 ? Math.floor(raw.count) : 0,
        sample: raw && typeof raw.sample === "string" ? raw.sample : null,
      });
    }

    fresh.sort(function (a, b) {
      if (a.count !== b.count) return b.count - a.count;
      if (a.domain === b.domain) return 0;
      return a.domain < b.domain ? -1 : 1;
    });

    return fresh.slice(0, max);
  }

  /**
   * Append domains to a config without touching what is already there.
   *
   * This is the "accept the suggestions" rule, kept pure so it can be tested:
   * new entries get the same defaults the manual form uses (`enabled`,
   * `separate`), an existing entry is never rewritten — not its order, not its
   * flags — and the result is capped at `MAX_DOMAINS`.
   *
   * Returns `{ added, rejected, overflow }`:
   *   added    — the new entries, in input order
   *   rejected — domains that were invalid, duplicated or already configured
   *   overflow — valid domains that did not fit under the cap
   *
   * The caller writes `added`; nothing here mutates `config`.
   */
  function appendDomains(config, domains) {
    var entries = sanitizeConfig(config).domains;
    var taken = {};
    for (var i = 0; i < entries.length; i += 1) taken[entries[i].domain] = true;

    var room = MAX_DOMAINS - entries.length;
    var added = [];
    var rejected = 0;
    var overflow = 0;
    var seen = {};

    var list = Array.isArray(domains) ? domains : [];
    for (var j = 0; j < list.length; j += 1) {
      var raw = list[j];
      var domain = normalizeDomain(typeof raw === "string" ? raw : raw && raw.domain);
      if (!domain || taken[domain] || seen[domain]) {
        rejected += 1;
        continue;
      }
      seen[domain] = true;

      if (added.length >= room) {
        overflow += 1;
        continue;
      }
      added.push({ domain: domain, enabled: true, separate: true });
    }

    return { added: added, rejected: rejected, overflow: overflow };
  }

  /**
   * Icon sources tried in order, first hit wins.
   *
   * The site's own /favicon.ico comes first: it is the most accurate, needs no
   * third party, and works wherever the profile itself is reachable. The two
   * services after it cover sites that only publish icons via <link rel=icon>
   * (or block the bare .ico path). DuckDuckGo is ahead of Google because the
   * Google endpoint is unreachable in some regions; neither is required.
   */
  function iconCandidates(domain) {
    var host = normalizeDomain(domain);
    if (!host) return [];

    return [
      "https://" + host + "/favicon.ico",
      "https://icons.duckduckgo.com/ip3/" + host + ".ico",
      "https://www.google.com/s2/favicons?sz=64&domain=" + encodeURIComponent(host),
    ];
  }

  window.ExternalLinkGroupsShared = {
    CONFIG_KEY: CONFIG_KEY,
    CONFIG_STORAGE_KEY: CONFIG_STORAGE_KEY,
    ICON_CACHE_KEY: ICON_CACHE_KEY,
    VERSION: VERSION,
    MAX_DOMAINS: MAX_DOMAINS,
    SUGGEST_LIMIT: SUGGEST_LIMIT,
    SUGGEST_PRESELECT: SUGGEST_PRESELECT,
    SCAN_PAGE_SIZE: SCAN_PAGE_SIZE,
    SCAN_MAX_PAGES: SCAN_MAX_PAGES,
    LIBRARY_SOURCES: LIBRARY_SOURCES,
    ICON_TTL_MS: ICON_TTL_MS,
    ICON_FAIL_TTL_MS: ICON_FAIL_TTL_MS,
    ICON_PROBE_TIMEOUT_MS: ICON_PROBE_TIMEOUT_MS,
    makeDefaultConfig: makeDefaultConfig,
    normalizeDomain: normalizeDomain,
    hostnameOf: hostnameOf,
    toHref: toHref,
    toBool: toBool,
    sanitizeEntry: sanitizeEntry,
    sanitizeConfig: sanitizeConfig,
    findEntry: findEntry,
    partition: partition,
    urlsFromLibrary: urlsFromLibrary,
    summarizeUrls: summarizeUrls,
    suggestDomains: suggestDomains,
    appendDomains: appendDomains,
    iconCandidates: iconCandidates,
  };
})();
