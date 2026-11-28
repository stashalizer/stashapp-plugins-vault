/**
 * Tests for ExternalLinkGroupsShared — the config schema and the URL partition.
 *
 *   node --test tests/
 *
 * ExternalLinkGroupsShared.js is a browser IIFE that only touches `window`, so
 * it runs unchanged in a node:vm sandbox. Values that cross the realm boundary
 * are converted with `snap()` before a strict comparison, because a deep
 * equality also compares prototypes and the sandbox has its own Object/Array.
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import vm from "node:vm";
import { fileURLToPath } from "node:url";
import test from "node:test";
import assert from "node:assert/strict";

const here = path.dirname(fileURLToPath(import.meta.url));
const sharedPath = path.join(here, "..", "plugins", "ExternalLinkGroups", "ExternalLinkGroupsShared.js");

function loadShared() {
  const sandbox = { window: {} };
  vm.runInNewContext(readFileSync(sharedPath, "utf8"), sandbox, { filename: sharedPath });
  return sandbox.window.ExternalLinkGroupsShared;
}

const S = loadShared();
const snap = (value) => JSON.parse(JSON.stringify(value));

const entry = (domains, enabled = true, separate = true) => ({
  domains: Array.isArray(domains) ? domains : [domains],
  enabled,
  separate,
});

/** Expected partition group for a row that lists one domain. */
const solo = (domain, urls) => ({
  key: "d:" + domain,
  name: domain,
  iconDomain: domain,
  domains: [domain],
  urls,
});

/** Expected partition group for a row that lists several domains. */
const merged = (domains, urls) => ({
  key: "d:" + domains[0],
  name: domains[0],
  iconDomain: domains[0],
  domains,
  urls,
});

test("normalizeDomain accepts the shapes users actually paste", () => {
  assert.equal(S.normalizeDomain("onlyfans.com"), "onlyfans.com");
  assert.equal(S.normalizeDomain("  ONLYFANS.COM  "), "onlyfans.com");
  assert.equal(S.normalizeDomain("www.onlyfans.com"), "onlyfans.com");
  assert.equal(S.normalizeDomain("OnlyFans.com."), "onlyfans.com");
  assert.equal(S.normalizeDomain("https://onlyfans.com/u/name?x=1#top"), "onlyfans.com");
  assert.equal(S.normalizeDomain("http://user:pw@onlyfans.com:443/a"), "onlyfans.com");
  assert.equal(S.normalizeDomain("onlyfans.com:443"), "onlyfans.com");
});

test("normalizeDomain rejects what is not a browsable host", () => {
  assert.equal(S.normalizeDomain(""), null);
  assert.equal(S.normalizeDomain("   "), null);
  assert.equal(S.normalizeDomain(null), null);
  assert.equal(S.normalizeDomain(42), null);
  assert.equal(S.normalizeDomain("localhost"), null);
  assert.equal(S.normalizeDomain("not a domain"), null);
  assert.equal(S.normalizeDomain("mailto:me@example.com"), null);
  assert.equal(S.normalizeDomain("tg://resolve?domain=x"), null);
  assert.equal(S.normalizeDomain("-bad.com"), null);
  assert.equal(S.normalizeDomain("bad-.com"), null);
  assert.equal(S.normalizeDomain("a".repeat(300) + ".com"), null);
});

test("hostnameOf reads stored performer URLs, bare hosts included", () => {
  assert.equal(S.hostnameOf("https://www.instagram.com/someone"), "instagram.com");
  assert.equal(S.hostnameOf("onlyfans.com/name"), "onlyfans.com");
  assert.equal(S.hostnameOf("www.onlyfans.com"), "onlyfans.com");
  assert.equal(S.hostnameOf(""), null);
  assert.equal(S.hostnameOf(undefined), null);
});

test("toHref mirrors Stash's https-prefix rule but refuses opaque schemes", () => {
  assert.equal(S.toHref("https://onlyfans.com/a"), "https://onlyfans.com/a");
  assert.equal(S.toHref("http://onlyfans.com/a"), "http://onlyfans.com/a");
  assert.equal(S.toHref("onlyfans.com/a"), "https://onlyfans.com/a");
  assert.equal(S.toHref("//onlyfans.com/a"), "https://onlyfans.com/a");
  assert.equal(S.toHref("mailto:me@example.com"), null);
  assert.equal(S.toHref(""), null);
});

test("sanitizeConfig coerces, keeps the first claim on a domain and drops junk", () => {
  const config = snap(
    S.sanitizeConfig({
      version: 99,
      domains: [
        { domain: "https://www.OnlyFans.com/name", enabled: "true", separate: "false" },
        { domain: "onlyfans.com", enabled: false, separate: true },
        { domain: "not a domain" },
        null,
        { domain: "tiktok.com" },
      ],
    })
  );

  assert.equal(config.version, S.VERSION);
  // The second onlyfans.com row loses its only domain to the first claim, so it
  // disappears entirely rather than becoming an empty row.
  assert.deepEqual(config.domains, [
    { domains: ["onlyfans.com"], enabled: true, separate: false },
    { domains: ["tiktok.com"], enabled: true, separate: true },
  ]);
});

test("sanitizeConfig accepts the old single-domain shape, a list and a delimited string", () => {
  // Pre-0.3 configs store `domain`; a hand-edited one may store a string.
  assert.deepEqual(snap(S.sanitizeConfig([{ domain: "x.com" }])).domains, [
    { domains: ["x.com"], enabled: true, separate: true },
  ]);
  assert.deepEqual(snap(S.sanitizeConfig([{ domains: ["x.com", "twitter.com"] }])).domains, [
    { domains: ["x.com", "twitter.com"], enabled: true, separate: true },
  ]);
  assert.deepEqual(snap(S.sanitizeConfig([{ domains: "x.com; https://www.Twitter.com/a" }])).domains, [
    { domains: ["x.com", "twitter.com"], enabled: true, separate: true },
  ]);

  assert.deepEqual(snap(S.sanitizeConfig(null)), { version: S.VERSION, domains: [] });
  assert.deepEqual(snap(S.sanitizeConfig("nope")), { version: S.VERSION, domains: [] });
  assert.deepEqual(snap(S.sanitizeConfig({ domains: "nope" })), { version: S.VERSION, domains: [] });
});

test("sanitizeConfig gives a domain to the first row that claims it", () => {
  const config = snap(
    S.sanitizeConfig({
      domains: [
        { domains: ["x.com", "twitter.com"] },
        { domains: ["twitter.com", "tiktok.com"] },
        { domains: ["x.com", "onlyfans.com"] },
      ],
    })
  );

  assert.deepEqual(
    config.domains.map((d) => d.domains),
    [
      ["x.com", "twitter.com"],
      ["tiktok.com"],
      ["onlyfans.com"],
    ]
  );
});

test("parseDomainList splits on semicolons, commas and pasted newlines", () => {
  assert.deepEqual(snap(S.parseDomainList("x.com; twitter.com")), {
    domains: ["x.com", "twitter.com"],
    invalid: [],
  });
  assert.deepEqual(snap(S.parseDomainList("x.com,twitter.com\nhttps://tiktok.com/@a")), {
    domains: ["x.com", "twitter.com", "tiktok.com"],
    invalid: [],
  });
  // Repeated domains collapse; surrounding space is not a domain.
  assert.deepEqual(snap(S.parseDomainList("x.com ; X.com ;  tiktok.com ")), {
    domains: ["x.com", "tiktok.com"],
    invalid: [],
  });
  // Bad tokens come back verbatim so the settings page can name them.
  assert.deepEqual(snap(S.parseDomainList("x.com; not a domain; mailto:me@x.com")), {
    domains: ["x.com"],
    invalid: ["not a domain", "mailto:me@x.com"],
  });
  assert.deepEqual(snap(S.parseDomainList("")), { domains: [], invalid: [] });
  assert.deepEqual(snap(S.parseDomainList(null)), { domains: [], invalid: [] });
});

test("formatDomainList is the text the settings page shows and re-parses", () => {
  assert.equal(S.formatDomainList(["x.com", "twitter.com"]), "x.com; twitter.com");
  assert.equal(S.formatDomainList(["x.com"]), "x.com");
  assert.equal(S.formatDomainList([]), "");
  assert.equal(S.formatDomainList(null), "");
  assert.deepEqual(snap(S.parseDomainList(S.formatDomainList(["x.com", "twitter.com"]))).domains, [
    "x.com",
    "twitter.com",
  ]);
});

test("sanitizeConfig caps the total number of domains at MAX_DOMAINS", () => {
  const many = [];
  for (let i = 0; i < S.MAX_DOMAINS + 10; i += 1) many.push({ domain: `site${i}.com` });

  const config = S.sanitizeConfig(many);
  const total = config.domains.reduce((sum, d) => sum + d.domains.length, 0);
  assert.equal(total, S.MAX_DOMAINS);

  // The cap counts domains, not rows: two rows of two are four domains.
  const merged = S.sanitizeConfig({ domains: [{ domains: ["a.com", "b.com"] }, { domains: ["c.com"] }] });
  assert.equal(merged.domains.length, 2);
  assert.equal(merged.domains[0].domains.length, 2);
});

test("partition leaves unconfigured URLs to Stash", () => {
  const parts = snap(S.partition(["https://example.com/a", "other.net"], S.makeDefaultConfig()));
  assert.deepEqual(parts, { separate: [], bucket: [], rest: ["https://example.com/a", "other.net"] });
});

test("partition pulls enabled-and-separate domains into their own groups", () => {
  const config = S.sanitizeConfig({ domains: [entry("onlyfans.com"), entry("tiktok.com")] });
  const parts = snap(
    S.partition(
      ["https://onlyfans.com/a", "https://www.tiktok.com/@x", "https://example.com/a", "onlyfans.com/b"],
      config
    )
  );

  assert.deepEqual(parts.separate, [
    solo("onlyfans.com", ["https://onlyfans.com/a", "onlyfans.com/b"]),
    solo("tiktok.com", ["https://www.tiktok.com/@x"]),
  ]);
  assert.deepEqual(parts.bucket, []);
  assert.deepEqual(parts.rest, ["https://example.com/a"]);
});

test("partition groups follow config order, not URL order", () => {
  const config = S.sanitizeConfig({ domains: [entry("b.com"), entry("a.com")] });
  const parts = snap(S.partition(["https://a.com/x", "https://b.com/y"], config));
  assert.deepEqual(
    parts.separate.map((g) => g.name),
    ["b.com", "a.com"]
  );
});

test("partition sends disabled domains back to Stash", () => {
  const config = S.sanitizeConfig({ domains: [entry("onlyfans.com", false, true)] });
  const parts = snap(S.partition(["https://onlyfans.com/a"], config));
  assert.deepEqual(parts.separate, []);
  assert.deepEqual(parts.bucket, []);
  assert.deepEqual(parts.rest, ["https://onlyfans.com/a"]);
});

test("partition buckets enabled domains that are not separate", () => {
  const config = S.sanitizeConfig({ domains: [entry("twitter.com", true, false)] });
  const parts = snap(S.partition(["https://twitter.com/a", "https://x.com/b"], config));
  assert.deepEqual(parts.separate, []);
  assert.deepEqual(parts.bucket, ["https://twitter.com/a"]);
  assert.deepEqual(parts.rest, ["https://x.com/b"]);
});

test("partition does not match subdomains", () => {
  const config = S.sanitizeConfig({ domains: [entry("onlyfans.com")] });
  const parts = snap(S.partition(["https://fan.onlyfans.com/a"], config));
  assert.deepEqual(parts.separate, []);
  assert.deepEqual(parts.rest, ["https://fan.onlyfans.com/a"]);
});

test("partition collapses exact duplicates and drops junk entries", () => {
  const config = S.sanitizeConfig({ domains: [entry("onlyfans.com")] });
  const parts = snap(
    S.partition(
      ["https://onlyfans.com/a", " https://onlyfans.com/a ", "", null, 42, "https://onlyfans.com/b"],
      config
    )
  );
  assert.deepEqual(parts.separate, [solo("onlyfans.com", ["https://onlyfans.com/a", "https://onlyfans.com/b"])]);
});

test("partition tolerates missing or non-array urls", () => {
  const config = S.sanitizeConfig({ domains: [entry("onlyfans.com")] });
  assert.deepEqual(snap(S.partition(undefined, config)), { separate: [], bucket: [], rest: [] });
  assert.deepEqual(snap(S.partition(null, config)), { separate: [], bucket: [], rest: [] });
});

test("partition omits configured domains with no matching URL", () => {
  const config = S.sanitizeConfig({ domains: [entry("onlyfans.com"), entry("tiktok.com")] });
  const parts = snap(S.partition(["https://tiktok.com/@x"], config));
  assert.deepEqual(parts.separate, [solo("tiktok.com", ["https://tiktok.com/@x"])]);
});

test("partition never mutates the input config or list", () => {
  const config = S.sanitizeConfig({ domains: [entry("onlyfans.com")] });
  const urls = ["https://onlyfans.com/a"];
  S.partition(urls, config);
  assert.deepEqual(urls, ["https://onlyfans.com/a"]);
  assert.deepEqual(snap(config).domains, [{ domains: ["onlyfans.com"], enabled: true, separate: true }]);
});

// --- several domains in one row -------------------------------------------

test("one row with two domains renders one button carrying both", () => {
  const config = S.sanitizeConfig({ domains: [entry(["x.com", "twitter.com"])] });
  const parts = snap(S.partition(["https://x.com/a", "https://twitter.com/b", "https://example.com/c"], config));

  assert.deepEqual(parts.separate, [
    merged(["x.com", "twitter.com"], ["https://x.com/a", "https://twitter.com/b"]),
  ]);
  assert.deepEqual(parts.rest, ["https://example.com/c"]);
});

test("the first domain in the row is the label and the icon", () => {
  const config = S.sanitizeConfig({ domains: [entry(["twitter.com", "x.com"])] });
  const parts = snap(S.partition(["https://x.com/a", "https://twitter.com/b"], config));

  assert.equal(parts.separate[0].name, "twitter.com");
  assert.equal(parts.separate[0].iconDomain, "twitter.com");
  // Membership is not order-sensitive: both domains still belong to the row.
  assert.deepEqual(parts.separate[0].domains, ["twitter.com", "x.com"]);
  assert.deepEqual(parts.separate[0].urls, ["https://x.com/a", "https://twitter.com/b"]);
});

test("a disabled multi-domain row hands every one of its URLs back to Stash", () => {
  const config = S.sanitizeConfig({ domains: [entry(["x.com", "twitter.com"], false, true)] });
  const parts = snap(S.partition(["https://x.com/a", "https://twitter.com/b"], config));

  assert.deepEqual(parts.separate, []);
  assert.deepEqual(parts.bucket, []);
  assert.deepEqual(parts.rest, ["https://x.com/a", "https://twitter.com/b"]);
});

test("a multi-domain row that is not separate buckets all of its URLs", () => {
  const config = S.sanitizeConfig({ domains: [entry(["x.com", "twitter.com"], true, false)] });
  const parts = snap(S.partition(["https://x.com/a", "https://twitter.com/b"], config));

  assert.deepEqual(parts.separate, []);
  assert.deepEqual(parts.bucket, ["https://x.com/a", "https://twitter.com/b"]);
});

test("two rows can never claim the same domain", () => {
  const config = S.sanitizeConfig({
    domains: [entry(["x.com"]), entry(["x.com", "twitter.com"])],
  });
  const parts = snap(S.partition(["https://x.com/a", "https://twitter.com/b"], config));

  // The first row owns x.com; the second keeps only twitter.com.
  assert.deepEqual(
    parts.separate.map((g) => g.domains),
    [["x.com"], ["twitter.com"]]
  );
});
