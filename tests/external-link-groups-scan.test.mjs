/**
 * Tests for the library scan: domain aggregation in ExternalLinkGroupsShared and
 * the GraphQL sweep in ExternalLinkGroupsScan.
 *
 *   node --test tests/
 *
 * Both files are browser IIFEs that only touch `window` (plus `document` and
 * `fetch` inside the scan call itself), so they run unchanged in a node:vm
 * sandbox with those stubbed. Values crossing the realm boundary are copied with
 * `snap()` before a strict comparison, because the sandbox has its own
 * Object/Array prototypes.
 *
 * What is worth proving here: the numbers the settings page shows. A scan that
 * counts a domain twice, ranks it wrongly, suggests a domain the user already
 * configured, or silently reports a truncated sweep as complete would make the
 * user accept a config they did not choose — that is the failure this file is
 * about, not the HTTP call itself.
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import vm from "node:vm";
import { fileURLToPath } from "node:url";
import test from "node:test";
import assert from "node:assert/strict";

const here = path.dirname(fileURLToPath(import.meta.url));
const dir = path.join(here, "..", "plugins", "ExternalLinkGroups");
const read = (name) => readFileSync(path.join(dir, name), "utf8");

const sharedSrc = read("ExternalLinkGroupsShared.js");
const scanSrc = read("ExternalLinkGroupsScan.js");

/** Fresh sandbox per test: the modules keep no state, but `window.fetch` differs. */
function load(options = {}) {
  const window = {};
  const sandbox = { window, document: options.document, URL, console };
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(sharedSrc, sandbox, { filename: "ExternalLinkGroupsShared.js" });
  vm.runInContext(scanSrc, sandbox, { filename: "ExternalLinkGroupsScan.js" });
  if (options.fetch) window.fetch = options.fetch;
  return { S: window.ExternalLinkGroupsShared, Scan: window.ExternalLinkGroupsScan, window, sandbox };
}

const snap = (value) => JSON.parse(JSON.stringify(value));

const { S } = load();

// --- aggregation -----------------------------------------------------------

test("summarizeUrls normalizes, dedupes and ranks by distinct links", () => {
  const summary = snap(
    S.summarizeUrls([
      "https://www.OnlyFans.com/anna",
      "onlyfans.com/anna2",
      "https://x.com/a",
      "https://x.com/a", // the same link stored twice is one link
      " https://x.com/b ",
      "https://fan.onlyfans.com/x", // a subdomain is its own domain, as in partition()
    ])
  );

  assert.deepEqual(summary, [
    { domain: "onlyfans.com", count: 2, sample: "https://www.OnlyFans.com/anna" },
    { domain: "x.com", count: 2, sample: "https://x.com/a" },
    { domain: "fan.onlyfans.com", count: 1, sample: "https://fan.onlyfans.com/x" },
  ]);
});

test("summarizeUrls drops links that are not browsable hosts", () => {
  const summary = snap(
    S.summarizeUrls([
      "mailto:me@example.com",
      "tg://resolve?domain=x",
      "not a domain",
      "localhost",
      "",
      "   ",
      null,
      undefined,
      42,
      {},
      "https://ok.example/a",
    ])
  );

  assert.deepEqual(summary, [{ domain: "ok.example", count: 1, sample: "https://ok.example/a" }]);
});

test("summarizeUrls returns an empty list for missing or malformed input", () => {
  assert.deepEqual(snap(S.summarizeUrls(undefined)), []);
  assert.deepEqual(snap(S.summarizeUrls(null)), []);
  assert.deepEqual(snap(S.summarizeUrls("https://x.com/a")), []);
});

test("summarizeUrls sorts ties by domain so the order is stable", () => {
  const summary = snap(S.summarizeUrls(["https://b.com/x", "https://a.com/x", "https://c.com/x"]));
  assert.deepEqual(
    summary.map((item) => item.domain),
    ["a.com", "b.com", "c.com"]
  );
});

test("urlsFromLibrary flattens the three entity lists and skips junk", () => {
  const urls = snap(
    S.urlsFromLibrary({
      findPerformers: {
        count: 3,
        performers: [{ urls: ["https://onlyfans.com/a", null, 42] }, { urls: [] }, { urls: undefined }],
      },
      findStudios: { count: 1, studios: [{ urls: ["https://x.com/b"] }] },
      findGroups: { count: 1, groups: [{ urls: ["https://tiktok.com/@c"] }] },
    })
  );

  assert.deepEqual(urls, ["https://onlyfans.com/a", "https://x.com/b", "https://tiktok.com/@c"]);
});

test("urlsFromLibrary accepts a bare array and tolerates missing sections", () => {
  assert.deepEqual(snap(S.urlsFromLibrary([{ urls: ["https://a.com/1"] }, null])), ["https://a.com/1"]);
  assert.deepEqual(snap(S.urlsFromLibrary({})), []);
  assert.deepEqual(snap(S.urlsFromLibrary(null)), []);
  assert.deepEqual(snap(S.urlsFromLibrary({ findPerformers: null })), []);
});

// --- suggestions -----------------------------------------------------------

const entry = (domain, enabled = true, separate = true) => ({ domains: [domain], enabled, separate });

test("suggestDomains keeps the most used domains that are not configured", () => {
  const config = S.sanitizeConfig({ domains: [entry("x.com", true, false)] });
  const candidates = [
    { domain: "onlyfans.com", count: 9, sample: "https://onlyfans.com/a" },
    { domain: "x.com", count: 7, sample: "https://x.com/a" },
    { domain: "tiktok.com", count: 4, sample: "https://tiktok.com/a" },
  ];

  assert.deepEqual(snap(S.suggestDomains(config, candidates, 5)), [
    { domain: "onlyfans.com", count: 9, sample: "https://onlyfans.com/a" },
    { domain: "tiktok.com", count: 4, sample: "https://tiktok.com/a" },
  ]);
});

test("suggestDomains skips every domain of a multi-domain row", () => {
  const config = S.sanitizeConfig({ domains: [{ domains: ["x.com", "twitter.com"] }] });
  const summary = [
    { domain: "x.com", count: 9 },
    { domain: "twitter.com", count: 4 },
    { domain: "onlyfans.com", count: 3 },
  ];

  assert.deepEqual(
    snap(S.suggestDomains(config, summary, 10)).map((item) => item.domain),
    ["onlyfans.com"]
  );
});

test("suggestDomains never re-offers a domain the user switched off", () => {
  // Presence, not enablement: disabling a domain is a decision, and a suggestion
  // would come back with `enabled: true` and silently undo it.
  const config = S.sanitizeConfig({ domains: [entry("onlyfans.com", false, false)] });
  const summary = [{ domain: "onlyfans.com", count: 12, sample: "https://onlyfans.com/a" }];
  assert.deepEqual(snap(S.suggestDomains(config, summary, 10)), []);
});

test("suggestDomains sorts by count, then by domain, and honours the limit", () => {
  const candidates = [
    { domain: "c.com", count: 1 },
    { domain: "a.com", count: 5 },
    { domain: "b.com", count: 1 },
  ];
  assert.deepEqual(
    snap(S.suggestDomains(S.makeDefaultConfig(), candidates, 2)).map((item) => item.domain),
    ["a.com", "b.com"]
  );
});

test("suggestDomains normalizes strings and drops unparseable candidates", () => {
  const suggested = snap(
    S.suggestDomains(S.makeDefaultConfig(), ["https://www.OnlyFans.com/a", "not a domain", "x.com", "x.com"], 10)
  );

  assert.deepEqual(suggested, [
    { domain: "onlyfans.com", count: 0, sample: null },
    { domain: "x.com", count: 0, sample: null },
  ]);
});

test("suggestDomains stops at MAX_DOMAINS", () => {
  const full = [];
  for (let i = 0; i < S.MAX_DOMAINS; i += 1) full.push(entry(`site${i}.com`));
  const config = S.sanitizeConfig({ domains: full });

  assert.deepEqual(snap(S.suggestDomains(config, [{ domain: "extra.com", count: 3 }], 10)), []);

  const almost = S.sanitizeConfig({ domains: full.slice(0, S.MAX_DOMAINS - 1) });
  assert.equal(S.suggestDomains(almost, [{ domain: "extra.com", count: 3 }], 10).length, 1);
});

test("suggestDomains does not mutate the config or the summary", () => {
  const config = S.sanitizeConfig({ domains: [entry("x.com")] });
  const summary = [{ domain: "onlyfans.com", count: 2, sample: "https://onlyfans.com/a" }];
  S.suggestDomains(config, summary, 5);

  assert.deepEqual(snap(config.domains), [{ domains: ["x.com"], enabled: true, separate: true }]);
  assert.deepEqual(snap(summary), [{ domain: "onlyfans.com", count: 2, sample: "https://onlyfans.com/a" }]);
});

// --- accepting a suggestion ------------------------------------------------

test("appendDomains adds new entries with the manual form's defaults", () => {
  const config = S.sanitizeConfig({ domains: [entry("tiktok.com", false, false)] });
  const result = snap(S.appendDomains(config, ["onlyfans.com", "https://www.x.com/a"]));

  assert.deepEqual(result.added, [
    { domains: ["onlyfans.com"], enabled: true, separate: true },
    { domains: ["x.com"], enabled: true, separate: true },
  ]);
  assert.equal(result.rejected, 0);
  assert.equal(result.overflow, 0);
  // The existing entry keeps its order and its flags: accepting a suggestion
  // must never re-enable something the user switched off.
  assert.deepEqual(snap(config.domains), [
    { domains: ["tiktok.com"], enabled: false, separate: false },
  ]);
});

test("appendDomains skips a domain that is already configured, however it is spelled", () => {
  const config = S.sanitizeConfig({ domains: [entry("onlyfans.com", false, false)] });
  const result = snap(S.appendDomains(config, ["https://www.OnlyFans.com/u/x", "onlyfans.com"]));

  assert.deepEqual(result.added, []);
  assert.equal(result.rejected, 2);
});

test("appendDomains rejects junk and stops at MAX_DOMAINS", () => {
  const full = [];
  for (let i = 0; i < S.MAX_DOMAINS - 1; i += 1) full.push(entry(`site${i}.com`));
  const config = S.sanitizeConfig({ domains: full });

  const result = snap(S.appendDomains(config, ["not a domain", "https://a.com", "b.com"]));
  assert.deepEqual(result.added, [{ domains: ["a.com"], enabled: true, separate: true }]);
  assert.equal(result.rejected, 1);
  assert.equal(result.overflow, 1, "the domain that did not fit must be reported, not silently dropped");
});

test("appendDomains tolerates a missing list", () => {
  assert.deepEqual(snap(S.appendDomains(S.makeDefaultConfig(), undefined)), {
    added: [],
    rejected: 0,
    overflow: 0,
  });
});

// --- the sweep -------------------------------------------------------------

/** One GraphQL page; every list reports the same total, which is enough here. */
function libPage({ count = 0, performers = [], studios = [], groups = [] } = {}) {
  const wrap = (urls) => ({ urls });
  return {
    findPerformers: { count, performers: performers.map(wrap) },
    findStudios: { count, studios: studios.map(wrap) },
    findGroups: { count, groups: groups.map(wrap) },
  };
}

/** `fetch` stub: one payload per requested page, recording every request. */
function pageFetch(pages) {
  const calls = [];
  const fn = (endpoint, init) => {
    const body = JSON.parse(init.body);
    const page = body.variables.filter.page;
    calls.push({ endpoint, page, perPage: body.variables.filter.per_page });
    if (!pages[page]) {
      return Promise.resolve({ ok: false, status: 599, json: () => Promise.resolve({}) });
    }
    return Promise.resolve({ ok: true, json: () => Promise.resolve({ data: pages[page] }) });
  };
  fn.calls = calls;
  return fn;
}

test("scan reads one page when the library fits and ranks what it found", async () => {
  const fetch = pageFetch({
    1: libPage({
      count: 2,
      performers: [
        ["https://onlyfans.com/a", "https://x.com/a"],
        ["https://onlyfans.com/b"],
      ],
      studios: [["https://onlyfans.com/c"]],
    }),
  });

  const { Scan } = load({ fetch, document: null });
  const result = await Scan.scan({ endpoint: "/graphql", pageSize: 200 });

  assert.equal(result.pages, 1);
  assert.equal(result.links, 4);
  assert.equal(result.truncated, false);
  assert.deepEqual(snap(result.totals), { performers: 2, studios: 2, groups: 2 });
  assert.deepEqual(snap(result.summary), [
    { domain: "onlyfans.com", count: 3, sample: "https://onlyfans.com/a" },
    { domain: "x.com", count: 1, sample: "https://x.com/a" },
  ]);
  assert.deepEqual(
    fetch.calls.map((call) => [call.page, call.perPage, call.endpoint]),
    [[1, 200, "/graphql"]]
  );
});

test("scan pages until the largest list is exhausted", async () => {
  const fetch = pageFetch({
    1: libPage({ count: 450, performers: [["https://a.com/1"]], studios: [["https://a.com/2"]] }),
    2: libPage({ count: 450, performers: [["https://b.com/1"]] }),
    3: libPage({ count: 450, performers: [["https://c.com/1"]] }),
  });

  const { Scan } = load({ fetch, document: null });
  const result = await Scan.scan({ endpoint: "/graphql", pageSize: 200 });

  assert.equal(result.pages, 3);
  assert.equal(result.truncated, false);
  assert.deepEqual(
    fetch.calls.map((call) => call.page),
    [1, 2, 3]
  );
  assert.deepEqual(
    snap(result.summary).map((item) => item.domain),
    ["a.com", "b.com", "c.com"]
  );
});

test("scan reports a truncated sweep instead of pretending it saw everything", async () => {
  const fetch = pageFetch({
    1: libPage({ count: 1000, performers: [["https://a.com/1"]] }),
    2: libPage({ count: 1000, performers: [["https://b.com/1"]] }),
  });

  const { Scan } = load({ fetch, document: null });
  const result = await Scan.scan({ endpoint: "/graphql", pageSize: 100, maxPages: 2 });

  assert.equal(result.pages, 2);
  assert.equal(result.truncated, true);
  assert.equal(fetch.calls.length, 2, "the page cap must stop the sweep, not just report it");
});

test("scan reports progress as pages complete", async () => {
  const fetch = pageFetch({
    1: libPage({ count: 400, performers: [["https://a.com/1"]] }),
    2: libPage({ count: 400, performers: [["https://b.com/1"]] }),
  });

  const { Scan } = load({ fetch, document: null });
  const seen = [];
  await Scan.scan({
    endpoint: "/graphql",
    pageSize: 200,
    onProgress: (progress) => seen.push([progress.pages, progress.links]),
  });

  assert.deepEqual(seen, [
    [1, 1],
    [2, 2],
  ]);
});

test("scan surfaces an HTTP failure with the status and the endpoint", async () => {
  const { Scan } = load({ fetch: () => Promise.resolve({ ok: false, status: 500 }), document: null });
  await assert.rejects(Scan.scan({ endpoint: "/stash/graphql" }), /500.*\/stash\/graphql/);
});

test("scan surfaces a GraphQL error message", async () => {
  const fetch = () =>
    Promise.resolve({
      ok: true,
      json: () => Promise.resolve({ errors: [{ message: "Cannot query field \"urls\"" }] }),
    });

  const { Scan } = load({ fetch, document: null });
  await assert.rejects(Scan.scan({ endpoint: "/graphql" }), /Cannot query field/);
});

test("scan surfaces a response without data", async () => {
  const fetch = () => Promise.resolve({ ok: true, json: () => Promise.resolve({ data: null }) });
  const { Scan } = load({ fetch, document: null });
  await assert.rejects(Scan.scan({ endpoint: "/graphql" }), /no data/);
});

// --- endpoint resolution ---------------------------------------------------

test("the endpoint follows the base path Stash serves the plugin from", () => {
  const document = {
    baseURI: "http://localhost:9999/settings",
    querySelector: () => ({ getAttribute: () => "http://localhost:9999/stash/plugin/ExternalLinkGroups/css" }),
  };

  const { Scan } = load({ document });
  assert.equal(Scan.basePath(), "/stash");
  assert.equal(Scan.graphQLEndpoint(), "/stash/graphql");
});

test("without the plugin's own link the endpoint is the root one", () => {
  const document = { baseURI: "http://localhost:9999/settings", querySelector: () => null };
  const { Scan } = load({ document });

  assert.equal(Scan.basePath(), "");
  assert.equal(Scan.graphQLEndpoint(), "/graphql");
});

test("a relative href is resolved against the document before the prefix is read", () => {
  const document = {
    baseURI: "http://localhost:9999/stash/",
    querySelector: () => ({ getAttribute: () => "plugin/ExternalLinkGroups/css" }),
  };

  const { Scan } = load({ document });
  assert.equal(Scan.graphQLEndpoint(), "/stash/graphql");
});

test("a sandbox without a document still answers a root endpoint", () => {
  const { Scan } = load({ document: undefined });
  assert.equal(Scan.graphQLEndpoint(), "/graphql");
});
