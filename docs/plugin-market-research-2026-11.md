# Competitive Research — Stash Plugin Ecosystem, November 2026

A survey of the Stash community forum carried out to locate this repository's four
plugins in the wider plugin ecosystem: who else solves the same problem, what users
complain about, which needs remain unmet, and what that implies for our roadmap.

- **Snapshot date:** 2026-11-16
- **Scope:** `discourse.stashapp.cc`, primarily the *Plugins* category (id 18), plus
  the design and release threads it links to. GitHub was used to verify source-level
  facts (native audio support, plugin manifests).
- **Plugins covered:** Questing Adventurer, Mosaic Filter, Scene Versions, Audio Support
- **Status:** research only — no plugin code changed as part of this survey.

## TL;DR

1. **Gamified viewing is now defined by progression, not by novelty mechanics.** Lockdown
   ships runs, heat, cards, scoring and a leaderboard; O Cheevs ships achievements; NNN
   Stats ships streaks. Questing Adventurer still keeps no session state at all, which is
   its largest structural gap.
2. **The privacy-blur space is saturated at page level and empty at region level.** Every
   competitor blurs whole thumbnails or the whole frame. Mosaic Filter is the only
   region-level tool in the player — but the word "mosaic" in this community means
   *Mosaic Poster* (a sprite contact sheet), so the plugin is effectively unfindable
   under its own name.
3. **"Version" and "duplicate" have no boundary in the ecosystem.** Six or more duplicate
   cleaners treat similar-looking scenes as deletable, while the community's proposed
   "recording / cut" model has never been implemented. Versioned scenes are at real risk
   of being cleaned away.
4. **Audio Support's cross-page playback gap has already been taken.** Ear Candy, published
   one day before this survey, replaces AudioPlayer with a docked, persistent player,
   a queue, a sleep timer, lock-screen controls and Group-based "sets".
5. **One platform bug affects all four plugins.** Stash's Settings page rewrites the whole
   plugin configuration from a snapshot taken when the page loaded, silently rolling back
   anything a plugin wrote in the meantime. Two independent plugin authors have hit it.

## Method

- Forum topics were read in full (all replies), not just the first post, using the
  `/t/<id>.json` endpoint and stripping `cooked` HTML. Search used `search.json`.
- Every claim about a competitor's feature set is taken from that plugin's own
  announcement post or release notes, not inferred.
- Quotes are verbatim from users, lightly truncated with `…` where marked.
- GitHub was used for facts that must not be guessed: the native audio PR state, the
  official `CommunityScripts` plugin list, and `AudioPlayerLite`'s implementation.

**Caveat:** forum replies are self-selected. They are strong evidence of *what a vocal
minority wants* and weak evidence of *population-level demand*. Where the two differ, the
document says so.

---

## 1. Questing Adventurer — gamifying what the viewer does

### Competitors

| Plugin | Thread | What it does | Where it beats us |
|---|---|---|---|
| **Lockdown** | `t/18351` (31 posts) | Locks Stash to a performer/studio/tag; Finish, Timer or Edge as ways out; heat conditions; skip budget; roulette; playing cards; score, leaderboard, history, presets; multi-device; Intiface "toy in charge" | Persistent run state, scoring loop, history, presets, phone layout, hardware integration |
| **O Cheevs** | `t/19027` | 22 achievements across watch time, O's and videos watched, with unlock popups over fullscreen video | A progression curve and visible rewards |
| **NNN Stats** | `t/20190` | November tracker: live timer, watch time, calendar of days watched | Streak framing and calendar view |
| **Stash Battle** | `t/5180` (75 posts) | ELO ranking of scenes through head-to-head picks; tiers, records, hall of fame | Long-term retention through ranked progression; state in scene `custom_fields` |
| **Intiface Sync** | `t/16574` | Syncs funscripts to toys over Intiface/Buttplug | Physical output |
| **DiceR** / **Stash Random Button** | `t/5721`, official | No-repeat random selection with a seen-list in `localStorage` | Scene selection, which we do not do at all |

Adjacent but a different axis: `chooseYourAdventurePlayer` (backer-only) plays branching
narrative games; **Stash Curator** (`t/17689`) added a roulette spinner for analysis
paralysis.

### What users actually say

The Lockdown thread is the single best source of feedback in this niche, because the
author shipped roughly twenty versions in a month and users replied in detail.

- On what keeps them coming back: *"the update is great, it really does feel like a game
  now and the stats/history/leaderboard does incentive me to use it pretty much all the
  time."*
- On handing control to another person — the **first reply in the thread**: *"Some kind of
  system to give control of the lock to someone else."*
- On verification with a partner: *"would be great if the run history showed start
  timestamps down to the minute … to verify your lock with a dom/domme or accountability
  partner."*
- On configuration friction: the author removed the Easy→Hardcore presets entirely because
  *"the Easy to Hardcore presets and Fine-tune did the same job twice: changing one rule
  turned your preset into 'custom', and new rules had no obvious place to go."*
- On risk: two users independently asked that scene deletion never be added as a
  punishment (*"I would be too paranoid about turning it on accidently"*), and the author
  agreed it was *"too risky to add as a feature."*

### Gap analysis

Questing Adventurer is the only plugin in this space that gamifies **viewer behaviour**
rather than **library consumption**. Moves and triggers are a vocabulary a person acts
out; Lockdown, O Cheevs and Stash Battle all measure what was watched. That is a genuine,
defensible position — and it is currently invisible, because:

- Nothing is recorded. The code reads and writes `csLib` configuration and never calls
  the Stash API. Close the tab and the session never happened.
- Triggers are decided by the user or by a random button. They have no relationship to
  what is on screen, so the "interactive scene" promise is not delivered.
- There is no way to hand a run to someone else, and no artefact to show afterwards.

### Differentiation

Do not add a second scoring system to compete with Lockdown's heat economy. Position the
plugin as a **behavioural contract layer**: the vocabulary is ours, and the value is in
recording it, delivering it to a partner, and eventually binding it to the timeline and to
hardware.

---

## 2. Mosaic Filter — region-level blur inside the player

### Competitors

| Plugin | Thread | What it does | Relationship to us |
|---|---|---|---|
| **SFW Switch** | `t/4658` (37 posts) | Navbar toggle that blurs covers and text, optionally mutes audio; per-plugin CSS extensions | Page-level; the de facto standard others adapt to |
| **Privacy Blur** | `t/20871` | One switch blurs every cover, thumbnail, photo and video; strength 4–40; names/titles optional; state stored in Stash | Page-level, well specified |
| **Peekaboo** | `t/21027` | Replaces images with generated SVG patterns and masks text; hover/Shift reveal; tested on 0.31 and 0.32 | Page-level, but argues blur is *insufficient* |
| **ImageBlackout** | official | Navbar toggle that blacks out images, hover previews and scrubber sprites | Page-level, absolute |
| **Panic Button** | `t/12699` | Boss key: replaces the screen with a solid colour or an image URL | Emergency hide, very shallow |
| **Mosaic Poster** | `t/12358` | Contact-sheet poster built from a scene sprite | **Name collision, unrelated function** |

### What users actually say

- The strongest argument against blur comes from Peekaboo's author: *"Blur was the usual
  answer and it never felt good enough; a heavy blur still keeps the shape, the framing and
  the colour of the frame, and the text underneath stays readable if anyone bothers to
  look."*
- Demand for a cheaper, stronger primitive shows up as a feature request on Privacy Blur:
  *"instead of Blur Mode, it random image/graphic (svg to be light?) instead."*
- The SFW Switch thread is almost entirely leak reports and state complaints: wall view and
  lightbox not covered, default covers not covered, *"in List mode, the blur is not
  enough! It is very clear that things are NSFW"*, and *"it doesn't preserve state across
  tabs or even when navigating between pages."*
- Performance is a real cost: the Refract theme ships a "Lite mode" specifically because
  blur, shadows and animation hurt integrated GPUs.
- Saturation is acknowledged in public: *"Yet another blur app. But it good to see."*
- On boss keys, a solid screen is not enough — users want a believable decoy: *"blank
  display is still Panic mode. I recommend something more fake like a fake wikipedia
  article or news."*

### Gap analysis

No competitor blurs a *region* inside the player. Mosaic Filter is unique, and it is also
the only tool here whose primary use is not "hide everything":

1. **Redaction** — a fixed watermark, logo, timestamp or face that should not appear in a
   screenshot or a shared clip.
2. **Focus** — invert mode blurs everything except a chosen area, which is an attention
   tool, not a censorship tool.

Its weaknesses are usability and discoverability, not concept:

- One global configuration for the whole library. A user with a studio-corner watermark
  repositions the filter for every scene.
- Blur only. Blur leaks outline, colour and framing — the exact criticism Peekaboo was
  built around — and it is the most expensive option on weak GPUs.
- The name collides with Mosaic Poster, and neither "mosaic" nor "filter" describes
  redaction or focus.

### Differentiation

Stop competing for "hide my library". Own **"hide this one thing, here"**: per-scene and
per-studio presets, a solid/pixelate mode that cannot leak, and a one-click redacted
screenshot, which is the actual workflow (screenshots get downloaded, edited elsewhere and
re-uploaded today).

---

## 3. Scene Versions — linking alternate cuts

### Competitors

| Tool | Thread | Approach | Conflict with us |
|---|---|---|---|
| **DupeFinder** / **DupeFinder Revamp** | `t/6182`, `t/16990` | Dialogue-driven duplicate review; the revamp adds review, split, merge and cleanup | Treats near-identical scenes as candidates for deletion |
| **Smart Resolve** | `t/6680` | Rule-ordered duplicate resolution with protection rules | Same |
| **DupFileManager**, **additionalFilesDeleter** | `t/1331`, `t/1337` | Remove extra files on the same object; `ignore` tag opts out | Same, file-level |
| **PHash Duplicate Tagger** | `t/1634` | Tags duplicate pHashes so they are easier and safer to remove | Same |
| **Native Groups** | Stash ≥ 0.27 | Ordered multi-scene containers for films and series | Models *parts of one work*, not *siblings of one recording* |
| **stash-box "recordings" proposal** | `t/244` | Work → Recording → Release hierarchy for rereleases and cuts | Designed Dec 2024, never implemented |

### What users actually say

The `t/244` design thread is the clearest statement of the underlying need:

- *"It's no secret that a lot of the thought behind stash-box is cribbed from MusicBrainz
  … scenes are analogous to releases, which means groups would be used to group rereleases
  of scenes."*
- *"There are already studios that release multiple versions of the same scene with
  different cuts to emphasize or remove certain acts like water sport, and this can in turn
  end up with cutting performers appearances as well."*
- On why Groups alone do not work: *"if we wanted to use groups for movies or lists, we now
  have groups of groups … an entirely separate scene-group group type."*

Practical pain appears in the JAV threads, where DVD, BluRay and VOD releases of one title
differ in duration and cast credits (`t/13715`, `t/4582`).

### Gap analysis

Versions are the one relationship Stash models nowhere: not in Groups (ordered), not in
tags (flat), not in files (same scene). Scene Versions fills that hole locally with
bidirectional links in `custom_fields` — which is the right storage primitive, and the same
one Stash Battle chose for ELO.

The risks are consequences of that choice:

- **Version data is invisible outside the tab.** No card badge, no library filter, no way
  to ask "show me every scene that has an alternate cut".
- **Duplicate cleaners cannot see the links.** A user running Smart Resolve or
  additionalFilesDeleter can delete a different cut believing it is a duplicate.
- **Choosing a version is unsupported.** Nothing shows duration, resolution, codec or date
  side by side.

### Differentiation

Be the **protective** layer, not another container: mark versioned scenes so cleanup tools
skip them, surface them on cards and in filters, and let the user compare before choosing.
Do not rebuild Groups — that race is already lost and the semantics do not fit.

---

## 4. Audio Support — audio as scenes

### Competitors

| Plugin | Thread | Approach | Notable |
|---|---|---|---|
| **Ear Candy** | `t/21284` | Audio page, docked player that survives navigation, queue, sleep timer, lock-screen/media keys, Group-based "sets", listening state written back to Stash | Newest entrant (Nov 15, 2026); requires 0.32; explicitly *"replaces AudioPlayer"* |
| **AudioPlayer** | `t/1328` | Audio-only toggle, playback through Stash's HLS transcoder | Transcode cost, slow seek |
| **AudioPlayerLite** | `t/1329` | Patches `ScenePlayer` when `video_codec === ""` and forces the HLS stream | ~40 lines; no queue, no metadata work |
| **audioTab** | `t/1782` | Adds a menu entry listing audio-only scenes | Navigation only |
| **audio-transcodes** | `t/1338` | Generates a video transcode from an audio file | Workaround, not a player |

### What users actually say

Audio threads are unusually quiet — `t/1328` and `t/1329` have zero substantive replies —
so the useful signal is in what Ear Candy chose to build and in the one reply it drew:

- *"I was looking something like this, especially to use with the pmv generator plugin."*
- A request that points at a gap none of us fill: *"would it make sense to add … a music
  video page in stash for xxx related music videos? … a special page for music videos imo
  would make sense, to keep them visually clearly separated."*

Ear Candy's feature list reads as a checklist of what the previous generation lacked:
persistent docked playback, queue with play-next, sleep timer with fade-out, lock-screen
controls, Continue listening on the front page, filters and sorts that live in the URL,
listening state stored in Stash, and per-creator/per-set organisation where a set is a
Stash Group.

### Gap analysis

Against Ear Candy, our advantages are narrow but real:

- **Synced LRC lyrics.** Nobody else in the ecosystem does lyrics; the whole forum returns
  a single topic for the word.
- **Metadata hygiene.** Inline tag editing per folder, cover-art extraction, the setup
  wizard, the `Scene.Create.Post` hook, and the generate task that skips audio scenes so
  preview/sprite generation stops erroring.
- **Version tolerance.** We run on the 0.31 line; Ear Candy requires 0.32.

What we have lost:

- Playback stops when the page changes. The overlay is mounted on the scene page.
- No resume point, play count or last-played written back to Stash.
- No queue persistence across navigation, no media keys, no sleep timer.

**Architectural risk:** native audio support (PR `#6824`, ~17k lines) is still open with
unresolved review comments and a conflicted branch. The audio-as-scene workaround therefore
has a long runway, but it is a workaround, and the migration path should stay explicit in
the design rather than discovered later.

### Differentiation

Ear Candy is a music player. Long-form audio — podcasts, audiobooks, lectures — is
unclaimed, and it needs exactly what we already have: a queue, positions, and per-item
metadata. Pair that with lyrics and metadata write-back, and the plugin has a defensible
identity that does not depend on winning a docked-player feature race.

---

## 5. Cross-cutting findings

### 5.1 Plugin configuration can be silently rolled back

From Suite Data (`t/19034`), written by the Lockdown author after being bitten:

> *"Stash's Settings > Plugins page keeps a copy of every plugin's settings from when you
> opened it, and when you change any setting there it saves that whole copy back. Anything
> a plugin wrote in between (a task added, a Lockdown run finished, a minute of watch time)
> gets rolled back."*

Peekaboo's 1.0.0 release notes describe the same failure from the user side: flipping the
shield, then saving an unrelated plugin's settings, silently reverted the shield.

All four of our plugins keep their entire state in `csLib` configuration, so all four are
exposed. The remedy used by Suite Data is to store *data* (not settings) as revision-checked
JSON files under `<config>/plugin-data/<plugin>/<key>.json`, where the Settings page cannot
reach them.

### 5.2 None of our plugins has a forum thread

Searching the forum for `"Questing Adventurer"` returns nothing; the same is true for the
other three names. By contrast, Lockdown went from 1.0 to 2.23.2 in a month on the strength
of 13 substantive replies, and Ear Candy drew feedback within a day of posting. Discovery is
not a marketing detail in this ecosystem — it is the feedback loop.

### 5.3 0.32 and mobile are the new baseline

Ear Candy requires 0.32. Peekaboo advertises testing on 0.31 and 0.32. Lockdown added a
phone layout and a "hold to peek" equivalent for touch. Our README still states that the
functional baseline is 0.31.x on Windows/Chromium, which is now visibly behind.

### 5.4 A single hosted source is fragile

Lockdown's repository was unreachable for several days after the author's GitHub account was
flagged, forcing a move to GitLab; the forum topic was closed by a moderator with
"Repository is no longer reachable" and users reported breakage. We publish a single
`index.yml` from GitHub Pages.

### 5.5 Blur is expensive, and users notice

The Refract theme ships a "Lite mode" that strips blur, shadows and animation for integrated
GPUs. Any feature that adds blur layers to the player should be opt-in and measured, not
assumed free.

---

## 6. Prioritised backlog

Effort: **S** ≤ half a day, **M** 1–3 days, **L** roughly a week. Priorities reflect
evidence strength, not enthusiasm.

### P0 — close gaps that competitors have already proven

| # | Feature | Plugin | Why | Effort |
|---|---|---|---|---|
| 1 | **Quest Log** — per-session record of triggers fired, moves completed, Penalty/Reward counts, with history and streaks | Questing Adventurer | The plugin currently keeps no state; progression is what retains users in every comparable plugin | M |
| 2 | **Docked player + cross-page queue**, writing resume point and play count back to Stash | Audio Support | Directly closes Ear Candy's headline advantage and the "it stops when I leave the page" complaint | L |
| 3 | **Per-studio / per-scene region presets** and a **solid / pixelate** fill mode | Mosaic Filter | One global rectangle is the biggest usability tax; blur leaks shape and colour, which is the documented criticism of blur | M |
| 4 | **Move plugin data out of `csLib` config** into revision-checked files under `plugin-data/` | all four | Settings-page rollback is silent data loss, already observed in two plugins | M |

### P1 — build the actual differentiators

| # | Feature | Plugin | Why | Effort |
|---|---|---|---|---|
| 5 | **Deal to a partner** — one-time code/link that lets someone else draw the trigger | Questing Adventurer | The first reply in Lockdown's thread asks for exactly this; our vocabulary is the natural fit | M |
| 6 | **Scene-aware triggers** — trigger pools by tag, and timeline-timed prompts from markers | Questing Adventurer | Today triggers are unrelated to the picture, so the interactive-scene promise is unfulfilled | L |
| 7 | **Version protection** — opt-out tag understood by cleanup plugins, card badge, library filter | Scene Versions | Prevents deletion of alternate cuts and makes versions visible outside the tab | M |
| 8 | **Long-form mode** — markers as chapters, speed control, sleep timer, bookmarks | Audio Support | Unclaimed niche; Ear Candy is music-shaped, and we already own the queue and position model | M |
| 9 | **One-click redacted screenshot** (copy/export the filtered frame) | Mosaic Filter | Screenshot sharing is the documented reason people use these tools; today it requires download → edit → re-upload | S |
| 10 | **SFW Switch interop** and a believable **panic screen** | Mosaic Filter | Adapting to SFW Switch is already an ecosystem convention; Panic Button proves demand but ships a blank screen | S |

### P2 — hardening and reach

| # | Feature | Plugin | Why | Effort |
|---|---|---|---|---|
| 11 | Intiface/Buttplug bridge — a move dispatches a hardware command | Questing Adventurer | Two plugins already prove the demand; it is the physical extension of "moves" | M |
| 12 | Version comparison view (duration, resolution, codec, date, cover) and pHash-based "same shoot" suggestions | Scene Versions | Choosing a version needs decision data; folder suggestions only understand naming | M |
| 13 | Lyrics upgrades — offset calibration, bilingual pairs, karaoke highlight | Audio Support | The one feature no competitor offers; worth deepening rather than widening | S |
| 14 | 0.32 + mobile validation matrix, and one forum announcement thread per plugin | all four | Competitors are competing on 0.32 and phones; no thread means no feedback loop | S |
| 15 | Mirrored plugin source with a stable fallback `index.yml` URL | all four | Lockdown's outage is the cautionary case | S |

### Sequencing

1–4 first: each closes a gap a competitor has already validated, and #4 is a data-safety
foundation that gets more expensive to add later. Then 5–6, which is where Questing
Adventurer becomes something Lockdown cannot copy — it has no behaviour vocabulary. Item 14
should run in parallel with development, not after it.

## 7. Non-goals

Explicit decisions to *not* build, so the backlog does not drift:

- **A page-wide SFW blur.** SFW Switch, Privacy Blur, Peekaboo and ImageBlackout own that
  surface, and users are openly tired of new entrants (*"Yet another blur app"*).
- **A second scoring economy.** Lockdown's heat/cards/leaderboard is mature and iterating
  weekly; competing head-on wastes the one asset we have that it lacks.
- **Deletion as a consequence.** Two users asked for it to be left out on safety grounds;
  the Lockdown author refused it too.
- **A Groups clone in Scene Versions.** Ordered containers solve a different problem, and
  re-implementing them would duplicate native behaviour for no gain.
- **A native-audio fork or PR.** The upstream PR is stalled on review, not on scope; our
  budget is better spent keeping the workaround clean and migratable.

---

## 8. Sources

Forum topics (all `https://discourse.stashapp.cc/t/<id>`):

| ID | Title | Used for |
|---|---|---|
| 18351 | Lockdown | Gamified runs, heat, cards, leaderboard; the richest user feedback in the niche |
| 19027 | O Cheevs | Achievements and unlock feedback |
| 20190 | NNN Stats | Streaks and calendar framing |
| 5180 | Stash Battle | ELO in `custom_fields`, tiers, records |
| 16574 | IntifaceSync (fork) | Hardware integration demand |
| 5721 | DiceR | No-repeat random selection with a seen-list |
| 17689 | Stash Curator | Roulette for analysis paralysis |
| 20871 | Privacy Blur | Page-level blur spec, strength, state storage |
| 21027 | Peekaboo | Why blur is considered insufficient; 0.31/0.32 testing |
| 4658 | SFW Switch | Leak reports, state persistence, ecosystem adaptation |
| 12699 | Panic Button | Boss-key demand and its current weakness |
| 12358 | Mosaic Poster | Name collision with "mosaic" |
| 6182 / 16990 / 6680 / 1634 | DupeFinder, DupeFinder Revamp, Smart Resolve, PHash Duplicate Tagger | Duplicate-cleanup behaviour that conflicts with version links |
| 244 | Scene groups and recordings | The unimplemented recording/cut model |
| 13715 / 4582 | Multiple studio codes; JAV standards | Practical rerelease pain |
| 19034 | Suite Data | Settings-page rollback; `plugin-data` storage pattern |
| 21284 | Ear Candy | Current audio bar: docked player, queue, sets, listening state |
| 1328 / 1329 / 1782 / 1338 | AudioPlayer, AudioPlayerLite, audioTab, audio-transcodes | Prior audio approaches |

Repositories checked:

- `stashapp/stash` — PR `#6824` *Audio Backend*, open, ~17k additions, unresolved review
  comments, latest activity 2026-09-10.
- `stashapp/CommunityScripts` — official plugin list and manifests for `AudioPlayerLite`,
  `SFWSwitch`, `ImageBlackout`, `StashRandomButton`, `MosaicPoster`,
  `chooseYourAdventurePlayer`.
