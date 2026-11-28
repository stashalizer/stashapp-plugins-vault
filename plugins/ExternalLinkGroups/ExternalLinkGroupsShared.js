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
 *       { domains: ["x.com", "twitter.com"], enabled: true,  separate: true  },
 *       { domains: ["onlyfans.com"],         enabled: true,  separate: true  },
 *       { domains: ["tiktok.com"],           enabled: false, separate: true  }
 *     ]
 *   }
 *
 * Each entry owns a **list** of domains. One domain is the common case; several
 * mean "these are the same account" — x.com and twitter.com — and produce a
 * single button whose icon and label come from the first domain in the list.
 * Every domain in an entry is a bare hostname, normalized on write and on read,
 * so a pasted profile URL also works.
 *
 * The two flags are not synonyms:
 *   - `enabled: false`   → the entry is ignored. Its URLs are handed back to
 *                          Stash untouched and no icon is requested.
 *   - `enabled: true` and `separate: true`
 *                        → the entry's URLs are pulled out of Stash's groups and
 *                          rendered as their own icon button (one per entry, so
 *                          a several-domain entry gets one button, not several).
 *   - `enabled: true` and `separate: false`
 *                        → the URLs are still owned by the plugin, but share one
 *                          "configured sites" button instead of getting a
 *                          button (and an icon fetch) of their own.
 *
 * A domain belongs to at most one entry: `sanitizeConfig` keeps the first claim
 * and drops it from later rows, so two buttons can never fight over one URL.
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
  // One row may list several domains — x.com and twitter.com are the same
  // account, and two buttons for one account is noise. They are separated the
  // way people actually type a list: semicolon, comma or a newline from a paste.
  var DOMAIN_SEPARATOR_RE = /[;,\n\r]+/;
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

  /**
   * Parse what the user typed into a row's domain field.
   *
   * One row can carry several domains ("x.com; twitter.com"): they are one
   * account, so they share one button, the first domain's icon and the first
   * domain's label. Splitting happens before normalization, so a pasted list
   * with newlines or commas works as well as the semicolon the placeholder
   * shows, and repeated domains collapse instead of producing two buttons.
   *
   * Returns `{ domains, invalid }`: `invalid` carries the tokens exactly as
   * typed so the settings page can name the one that was rejected.
   */
  function parseDomainList(value) {
    var domains = [];
    var invalid = [];
    var seen = {};

    if (typeof value !== "string") return { domains: domains, invalid: invalid };

    var tokens = value.split(DOMAIN_SEPARATOR_RE);
    for (var i = 0; i < tokens.length; i += 1) {
      var token = tokens[i].trim();
      if (!token) continue;

      var domain = normalizeDomain(token);
      if (!domain) {
        invalid.push(token);
        continue;
      }
      if (seen[domain]) continue;
      seen[domain] = true;
      domains.push(domain);
    }

    return { domains: domains, invalid: invalid };
  }

  /** Canonical text for a domain list, the form the settings page edits. */
  function formatDomainList(domains) {
    if (!Array.isArray(domains)) return "";
    var out = [];
    for (var i = 0; i < domains.length; i += 1) {
      if (typeof domains[i] === "string" && domains[i]) out.push(domains[i]);
    }
    return out.join("; ");
  }

  /**
   * One config entry from anything that has been stored.
   *
   * `domains` is the current shape; `domain` (a single bare hostname) is what
   * every config written before 0.3 has, and a delimited string is accepted so a
   * hand-edited config still loads. The first domain in the list is the primary
   * one: its icon represents the row.
   */
  function sanitizeEntry(raw) {
    if (!raw || typeof raw !== "object") return null;

    var source;
    if (Array.isArray(raw.domains)) source = raw.domains.join(";");
    else if (raw.domains !== undefined && raw.domains !== null) source = raw.domains;
    else source = raw.domain;

    var parsed = parseDomainList(typeof source === "string" ? source : "");
    if (!parsed.domains.length) return null;

    return {
      domains: parsed.domains,
      enabled: toBool(raw.enabled, true),
      separate: toBool(raw.separate, true),
    };
  }

  /**
   * Coerce anything stored (including hand-edited or pre-0.1 configs) into the
   * current schema. Accepts a bare array of entries as a convenience, drops
   * unparseable entries instead of throwing, keeps the first claim on a domain
   * when two rows list it (config order is display order) and caps the total
   * number of domains at `MAX_DOMAINS`.
   */
  function sanitizeConfig(raw) {
    var source = Array.isArray(raw) ? raw : raw && typeof raw === "object" ? raw.domains : null;

    var entries = [];
    var claimed = {};
    var total = 0;

    if (Array.isArray(source)) {
      for (var i = 0; i < source.length && total < MAX_DOMAINS; i += 1) {
        var entry = sanitizeEntry(source[i]);
        if (!entry) continue;

        var keep = [];
        for (var j = 0; j < entry.domains.length && total < MAX_DOMAINS; j += 1) {
          var domain = entry.domains[j];
          if (claimed[domain]) continue;
          claimed[domain] = true;
          keep.push(domain);
          total += 1;
        }

        // A row whose every domain was already claimed elsewhere disappears.
        if (!keep.length) continue;
        entries.push({ domains: keep, enabled: entry.enabled, separate: entry.separate });
      }
    }

    return { version: VERSION, domains: entries };
  }

  function findEntry(config, domain) {
    if (!domain) return null;
    var entries = sanitizeConfig(config).domains;
    for (var i = 0; i < entries.length; i += 1) {
      if (entries[i].domains.indexOf(domain) !== -1) return entries[i];
    }
    return null;
  }

  /**
   * Split a detail page's URL list into the three render buckets.
   *
   * Returns `{ separate, bucket, rest }`:
   *   separate → [{ key, name, iconDomain, domains, urls }] in config order
   *   bucket   → urls of enabled-but-not-separate entries, page order
   *   rest     → everything Stash keeps rendering, page order
   *
   * One entry may own several domains — x.com and twitter.com are the same
   * account — and they produce **one** group here: `domains` is the entry's list,
   * `name` and `iconDomain` are its first domain (the label and the icon the user
   * chose by putting it first), and `urls` interleaves both domains in page
   * order. Entries with no matching URL are omitted, so a row whose domains do
   * not appear on this page renders nothing.
   *
   * Exact duplicate URLs are collapsed (Stash keys its menu by URL), blank and
   * non-string entries are dropped rather than passed through.
   */
  function partition(urls, config) {
    var entries = sanitizeConfig(config).domains;

    var groups = [];
    var groupByOwner = {};
    var entryByDomain = {};
    var bucket = [];
    var rest = [];
    var seenUrl = {};

    for (var i = 0; i < entries.length; i += 1) {
      var entry = entries[i];
      for (var d = 0; d < entry.domains.length; d += 1) {
        entryByDomain[entry.domains[d]] = entry;
      }
      if (!entry.enabled || !entry.separate) continue;

      var group = {
        key: "d:" + entry.domains[0],
        name: entry.domains[0],
        iconDomain: entry.domains[0],
        domains: entry.domains.slice(),
        urls: [],
      };
      groupByOwner[entry.domains[0]] = group;
      groups.push(group);
    }

    var list = Array.isArray(urls) ? urls : [];
    for (var j = 0; j < list.length; j += 1) {
      var url = list[j];
      if (typeof url !== "string") continue;

      var trimmed = url.trim();
      if (!trimmed || seenUrl[trimmed]) continue;
      seenUrl[trimmed] = true;

      var owner = entryByDomain[hostnameOf(trimmed)] || null;
      if (!owner || !owner.enabled) {
        rest.push(trimmed);
      } else if (owner.separate && groupByOwner[owner.domains[0]]) {
        groupByOwner[owner.domains[0]].urls.push(trimmed);
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
    var used = 0;
    for (var i = 0; i < entries.length; i += 1) {
      for (var d = 0; d < entries[i].domains.length; d += 1) {
        taken[entries[i].domains[d]] = true;
        used += 1;
      }
    }

    var capacity = MAX_DOMAINS - used;
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
    var used = 0;
    for (var i = 0; i < entries.length; i += 1) {
      for (var d = 0; d < entries[i].domains.length; d += 1) {
        taken[entries[i].domains[d]] = true;
        used += 1;
      }
    }

    var room = MAX_DOMAINS - used;
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
      // One domain per new row: the suggestions never invent a merged row, the
      // user decides that by editing the row afterwards.
      added.push({ domains: [domain], enabled: true, separate: true });
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
   *
   * Both services answer "I do not know this domain" with **404 plus a PNG of
   * their own** — DuckDuckGo a 48×48 grey circle with a chevron, Google a 16×16
   * globe. An `<img>` never sees the status code, so that placeholder arrives
   * as a successful load; `isPlaceholderIcon` is what keeps it out of the icon
   * cache. See that function for why only DuckDuckGo is recognised.
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

  // DuckDuckGo's "no icon" artwork: a grey circle with a white chevron, always
  // 48×48 PNG, served with a 404 (verified 2026-11-28 against simpcity.cr and a
  // domain that does not exist). Google's equivalent is 16×16 and deliberately
  // NOT listed: real icons that small exist (r18.dev serves one), and Google is
  // the last source, so rejecting it would replace a correct icon with a letter
  // tile. DuckDuckGo is not the last source — a false positive only costs one
  // more probe, and the 48×48 case is also how Linktree's real mark is served.
  var DDG_PLACEHOLDER_SIZE = 48;

  /**
   * Is this "successful" icon load actually the service's own placeholder?
   *
   * Intrinsic width/height is the only thing a cross-origin image exposes — the
   * canvas is tainted (neither service sends `Access-Control-Allow-Origin`) and
   * Stash's CSP keeps `fetch` off them — so the placeholder is recognised by
   * the size the service always renders it at.
   */
  function isPlaceholderIcon(src, width, height) {
    if (typeof src !== "string" || !src) return false;
    if (width !== DDG_PLACEHOLDER_SIZE || height !== DDG_PLACEHOLDER_SIZE) return false;
    return src.indexOf("//icons.duckduckgo.com/ip3/") !== -1;
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
    parseDomainList: parseDomainList,
    formatDomainList: formatDomainList,
    sanitizeEntry: sanitizeEntry,
    sanitizeConfig: sanitizeConfig,
    findEntry: findEntry,
    partition: partition,
    urlsFromLibrary: urlsFromLibrary,
    summarizeUrls: summarizeUrls,
    suggestDomains: suggestDomains,
    appendDomains: appendDomains,
    iconCandidates: iconCandidates,
    isPlaceholderIcon: isPlaceholderIcon,
  };
})();
