/**
 * ExternalLinkGroupsScan — read the URLs already in the library.
 *
 * This is the only network code in the plugin, and it is deliberately thin: one
 * same-origin GraphQL query, paged, flattened by
 * `ExternalLinkGroupsShared.urlsFromLibrary` and ranked by `summarizeUrls`. All
 * the interesting logic (normalization, filtering, ordering, what counts as
 * already configured) lives in the pure module and is tested there.
 *
 * Why `fetch` and not an Apollo client: the plugin must work with or without
 * csLib, and csLib's GQL wrapper is the only client the two runtimes share —
 * making the scan depend on it would mean the suggestions disappear for exactly
 * the users who have not installed it. `connect-src` in Stash's CSP is
 * `'self'`, which is all a same-origin POST to /graphql needs.
 *
 * Endpoint resolution: the settings page can be mounted at `/settings` or at
 * `/plugins/<id>`, so a bare relative "graphql" would resolve against the wrong
 * directory. Stash injects this plugin's own `<link rel=stylesheet>` with the
 * full base path (`/plugin/ExternalLinkGroups/css`, or
 * `/prefix/plugin/ExternalLinkGroups/css` behind a reverse proxy), and that is
 * the one absolute anchor available on any page. Without it the default `/`
 * base is used, which is right for every non-proxied install.
 *
 * Failure is not fatal anywhere: every rejection carries a message the settings
 * page shows next to the manual add form, which keeps working.
 *
 * License: AGPL-3.0
 */
(function () {
  "use strict";

  var S = window.ExternalLinkGroupsShared;
  if (!S) {
    console.error("ExternalLinkGroups scan: shared module missing; library scan unavailable.");
    return;
  }

  // Page p of each list, in one round trip: all three entities accept the same
  // `FindFilterType`, so a single page number covers the whole sweep.
  var SCAN_QUERY =
    "query ExternalLinkGroupsScan($filter: FindFilterType) {" +
    " findPerformers(filter: $filter) { count performers { urls } }" +
    " findStudios(filter: $filter) { count studios { urls } }" +
    " findGroups(filter: $filter) { count groups { urls } }" +
    "}";

  /**
   * Base path prefix shared by every Stash route, e.g. "" or "/stash".
   * Derived from this plugin's stylesheet link; see the header.
   */
  function basePath() {
    var doc = typeof document !== "undefined" ? document : null;
    if (!doc || typeof doc.querySelector !== "function") return "";

    var link = doc.querySelector('link[href*="/plugin/ExternalLinkGroups/"]');
    if (!link) return "";

    var href = link.getAttribute ? link.getAttribute("href") || "" : "";
    if (!href) return "";

    var path = href;
    try {
      // Resolve a relative href against the document; an absolute one passes
      // through unchanged. Only the pathname is kept, the origin is implied by
      // the fact that this is a same-origin request.
      path = new URL(href, doc.baseURI || undefined).pathname;
    } catch (err) {
      /* fall through with the raw attribute */
    }

    var index = path.indexOf("/plugin/");
    return index > 0 ? path.slice(0, index) : "";
  }

  function graphQLEndpoint() {
    return basePath() + "/graphql";
  }

  function request(endpoint, page, pageSize) {
    var init = {
      method: "POST",
      credentials: "same-origin",
      headers: { "Content-Type": "application/json", Accept: "application/json" },
      body: JSON.stringify({
        query: SCAN_QUERY,
        variables: { filter: { page: page, per_page: pageSize } },
      }),
    };

    return Promise.resolve()
      .then(function () {
        return window.fetch(endpoint, init);
      })
      .then(function (response) {
        if (!response || !response.ok) {
          throw new Error("Stash answered " + (response ? response.status : "nothing") + " for " + endpoint);
        }
        return response.json();
      })
      .then(function (payload) {
        if (payload && Array.isArray(payload.errors) && payload.errors.length) {
          var first = payload.errors[0];
          throw new Error(first && first.message ? first.message : "GraphQL query failed");
        }
        if (!payload || !payload.data) throw new Error("Stash returned no data");
        return payload.data;
      });
  }

  function countOf(data, key) {
    var page = data && data[key];
    var count = page && typeof page.count === "number" ? page.count : 0;
    return count > 0 ? count : 0;
  }

  /**
   * Walk the library and return the ranked domain summary.
   *
   * Resolves `{ urls, summary, totals, links, pages, truncated }`:
   *   urls      — every URL read, in page order (the raw material, for counts)
   *   summary   — `Shared.summarizeUrls(urls)`, the useful part
   *   totals    — `{ performers, studios, groups }` entity counts
   *   pages     — how many pages were fetched
   *   truncated — true when the page cap stopped the sweep early, so the page
   *               can say the numbers are a partial view instead of pretending
   *               they are the whole library
   *
   * Options: `endpoint` (test seam), `pageSize`, `maxPages`, `onProgress`.
   * Requests are sequential on purpose: a library sweep must not open a dozen
   * connections against the same Stash that is streaming a video.
   */
  function scan(options) {
    var opts = options || {};
    var endpoint = opts.endpoint || graphQLEndpoint();
    var pageSize =
      typeof opts.pageSize === "number" && opts.pageSize > 0 ? Math.floor(opts.pageSize) : S.SCAN_PAGE_SIZE;
    var maxPages =
      typeof opts.maxPages === "number" && opts.maxPages > 0 ? Math.floor(opts.maxPages) : S.SCAN_MAX_PAGES;
    var onProgress = typeof opts.onProgress === "function" ? opts.onProgress : null;

    var urls = [];
    var totals = {};
    var pages = 0;
    var truncated = false;

    function collect(data) {
      urls = urls.concat(S.urlsFromLibrary(data));
      pages += 1;
      for (var i = 0; i < S.LIBRARY_SOURCES.length; i += 1) {
        var source = S.LIBRARY_SOURCES[i];
        totals[source.field] = countOf(data, source.query);
      }
      if (onProgress) {
        onProgress({ pages: pages, links: urls.length, totals: totals, truncated: truncated });
      }
    }

    return request(endpoint, 1, pageSize)
      .then(function (first) {
        collect(first);

        // All three lists are paged by the same number, so the sweep is as long
        // as the largest of them.
        var largest = 0;
        for (var i = 0; i < S.LIBRARY_SOURCES.length; i += 1) {
          var count = totals[S.LIBRARY_SOURCES[i].field] || 0;
          if (count > largest) largest = count;
        }

        var needed = Math.ceil(largest / pageSize) || 1;
        var target = Math.min(needed, maxPages);
        truncated = needed > target;

        var chain = Promise.resolve();
        for (var page = 2; page <= target; page += 1) {
          chain = chain.then(
            (function (next) {
              return function () {
                return request(endpoint, next, pageSize).then(collect);
              };
            })(page)
          );
        }
        return chain;
      })
      .then(function () {
        return {
          urls: urls,
          summary: S.summarizeUrls(urls),
          totals: totals,
          links: urls.length,
          pages: pages,
          truncated: truncated,
        };
      });
  }

  window.ExternalLinkGroupsScan = {
    SCAN_QUERY: SCAN_QUERY,
    basePath: basePath,
    graphQLEndpoint: graphQLEndpoint,
    scan: scan,
  };
})();
