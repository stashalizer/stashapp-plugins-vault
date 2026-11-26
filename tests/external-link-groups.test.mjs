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

const entry = (domain, enabled = true, separate = true) => ({ domain, enabled, separate });

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

test("sanitizeConfig coerces, dedupes by first occurrence and caps the list", () => {
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
  assert.deepEqual(config.domains, [
    { domain: "onlyfans.com", enabled: true, separate: false },
    { domain: "tiktok.com", enabled: true, separate: true },
  ]);
});

test("sanitizeConfig accepts a bare array and an absent config", () => {
  assert.deepEqual(snap(S.sanitizeConfig([{ domain: "x.com" }])).domains, [
    { domain: "x.com", enabled: true, separate: true },
  ]);
  assert.deepEqual(snap(S.sanitizeConfig(null)), { version: S.VERSION, domains: [] });
  assert.deepEqual(snap(S.sanitizeConfig("nope")), { version: S.VERSION, domains: [] });
  assert.deepEqual(snap(S.sanitizeConfig({ domains: "nope" })), { version: S.VERSION, domains: [] });
});

test("sanitizeConfig caps the list at MAX_DOMAINS", () => {
  const many = [];
  for (let i = 0; i < S.MAX_DOMAINS + 10; i += 1) many.push({ domain: `site${i}.com` });
  assert.equal(S.sanitizeConfig(many).domains.length, S.MAX_DOMAINS);
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
    { domain: "onlyfans.com", urls: ["https://onlyfans.com/a", "onlyfans.com/b"] },
    { domain: "tiktok.com", urls: ["https://www.tiktok.com/@x"] },
  ]);
  assert.deepEqual(parts.bucket, []);
  assert.deepEqual(parts.rest, ["https://example.com/a"]);
});

test("partition groups follow config order, not URL order", () => {
  const config = S.sanitizeConfig({ domains: [entry("b.com"), entry("a.com")] });
  const parts = snap(S.partition(["https://a.com/x", "https://b.com/y"], config));
  assert.deepEqual(
    parts.separate.map((g) => g.domain),
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
  assert.deepEqual(parts.separate, [{ domain: "onlyfans.com", urls: ["https://onlyfans.com/a", "https://onlyfans.com/b"] }]);
});

test("partition tolerates missing or non-array urls", () => {
  const config = S.sanitizeConfig({ domains: [entry("onlyfans.com")] });
  assert.deepEqual(snap(S.partition(undefined, config)), { separate: [], bucket: [], rest: [] });
  assert.deepEqual(snap(S.partition(null, config)), { separate: [], bucket: [], rest: [] });
});

test("partition omits configured domains with no matching URL", () => {
  const config = S.sanitizeConfig({ domains: [entry("onlyfans.com"), entry("tiktok.com")] });
  const parts = snap(S.partition(["https://tiktok.com/@x"], config));
  assert.deepEqual(parts.separate, [{ domain: "tiktok.com", urls: ["https://tiktok.com/@x"] }]);
});

test("partition never mutates the input config or list", () => {
  const config = S.sanitizeConfig({ domains: [entry("onlyfans.com")] });
  const urls = ["https://onlyfans.com/a"];
  S.partition(urls, config);
  assert.deepEqual(urls, ["https://onlyfans.com/a"]);
  assert.deepEqual(snap(config).domains, [{ domain: "onlyfans.com", enabled: true, separate: true }]);
});

test("iconCandidates tries the site first, then two services", () => {
  const candidates = S.iconCandidates("www.OnlyFans.com");
  assert.equal(candidates.length, 3);
  assert.equal(candidates[0], "https://onlyfans.com/favicon.ico");
  assert.equal(candidates[1], "https://icons.duckduckgo.com/ip3/onlyfans.com.ico");
  assert.equal(
    candidates[2],
    "https://www.google.com/s2/favicons?sz=64&domain=" + encodeURIComponent("onlyfans.com")
  );
  assert.deepEqual(snap(S.iconCandidates("nope")), []);
});
