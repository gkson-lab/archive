# BulkBot

A free Pokémon TCG bulk scanner that runs in the phone's browser and installs to the home screen (PWA).
Point the camera at a card and it is recognized on the device in well under a second. It is added to a running
total and the scanner is ready for the next card. You don't press a button or line the card up. There are
no paid APIs, no login and no ads.

- **Recognizes every English card**: 21,463 cards in 202 sets (WotC through Mega Evolution, promos, Trainer Gallery,
  Galarian Gallery, Shiny Vault, Classic Collection...), including new sets as they come out.
- **Shows the era on every result** (WotC, EX, DP/Platinum, HGSS, BW, XY, SM, SWSH, SV, Mega Evolution, and any future
  series picked up from the API) and uses era cues (border color, regulation mark, set code, number format) to tell
  reprints apart.
- **Prices**: TCGplayer market/low/mid/high from the Pokémon TCG API, Cardmarket via TCGdex, per printing
  (normal, holo, reverse, 1st Edition, Shadowless, Poké Ball / Master Ball reverse, stamped), adjusted for
  condition, with a bulk floor and gold "hit" alerts.
- **Sessions** (name, save, reopen), sort and filter, duplicate counting, collection and set completion, CSV and
  TCGplayer Mass Entry export, swipe-to-undo, manual search, price sparklines.

## How recognition works

```
camera frame ──► card detector (worker, ~10 ms) ──► corner refinement on the full-res frame
                                                       │
                     ┌─────────────────────────────────┴──────────────────┐
                     ▼                                                    ▼
          upright 224×320 warp                              number strip + name line
                     │                                                    │
     MobileNetV3 (TF.js, WebGL) + regional GeM                  Tesseract (on-device)
     → PCA-whitened 256-d vector                        "045/198", "PAL EN", "G", name
                     │                                                    │
     cosine search over 19,840 int8 vectors (~5 ms)                       │
                     └──────────────► fusion + confidence ◄───────────────┘
                                             │
                          lock (buzz + sound) │ or one-tap fix strip
```

- **No aligning**: the detector finds the card anywhere in the frame, at any angle or distance and with moderate
  tilt. It uses edges plus three card-specific cues: the uniform yellow or silver border band, edges that stop at
  the corners (wood grain and tile lines don't), and a color model of the table, so a card on a busy desk still
  stands out. If the first crop matches poorly, the recognizer checks the detector's next-best rectangles itself
  instead of asking you to move the card.
- **Locks on quickly**: recognition starts as soon as two frames agree (about 150 ms of holding still). Evidence
  from the next frames accumulates automatically, so a glare spot or a blurry frame gets outvoted. OCR runs in
  parallel and only delays the lock when two printings share identical art (Base Set vs Base Set 2, for example).
  Then the number (`58/102` vs `87/130`) decides.
- **Never blocks**: when it isn't sure, it adds the best guess with a `?` and shows a one-tap strip with the
  alternatives while you keep scanning. To scan the next card, swap it in or lift the current one. Scanning the same
  card again adds another copy.

Offline benchmark (`scripts/dev/eval-recognition.ts`): 400 random cards are rendered from a *different* image source
into synthetic phone-camera scenes (random pose, tilt, distance, wood/tile/fabric backgrounds, light gradients,
glare, blur, noise). The real pipeline is then run on them, before OCR:

| | detected | top-1 | top-1 (identical-art reprints count) | top-3 |
|---|---|---|---|---|
| perfect corners | 100% | 96.5% | 99.5% | 100% |
| full pipeline (detector) | 96.8% | 94.0% | 96.0% | 96.8% |

An end-to-end browser test feeds a camera clip of three cards to headless Chromium. In it, each card locks
0.4–1.1 s after it appears, and repeat copies are counted. These are synthetic numbers; real phones, lighting and
sleeves will differ, so please report misses.

## Quick start

```bash
npm install
npm run build:data   # card catalog + visual index -> public/data (first run ~15 min, then incremental)
npm run dev          # http://localhost:5173
```

The camera needs HTTPS on a phone. To test on a phone, deploy (see below) or use a tunnel (for example
`npx vite --host` plus any HTTPS tunnel).

| command | what it does |
|---|---|
| `npm run catalog` | pulls every English set and card from pokemontcg.io (primary) and TCGdex (fallback, Cardmarket, detailed variants, newest sets) and writes `public/data/{manifest,sets}.json`, `cards/<set>.json`, `prices/<era>.json` |
| `npm run index` | downloads each card image once, embeds it with the on-device model, quantizes and writes `public/data/index/` |
| `npm run build` | type-checks and builds the PWA into `dist/` (includes `public/data`) |
| `npm test` | unit tests (OCR parsing, pricing, fusion, eras, detector) |

Useful flags: `npm run catalog -- --ptcg-budget-min 25 --ptcg-cache-only --sets base1,sv1` and
`npm run index -- --refit-projection --dims 256`. Set `POKEMONTCG_API_KEY` (free at dev.pokemontcg.io) for higher
pokemontcg.io rate limits. Everything is cached in `.cache/`: API responses (20 h), images and embeddings (permanent).
pokemontcg.io is often flaky, so requests are paced and retried, and the last good copy of each set is kept. Card
ids are TCGdex ids so they never change when one API has a bad day.



## How new sets get added automatically

1. **Weekly rebuild**: the scheduled workflow rebuilds the catalog from both APIs. Only cards that are new or
   changed get downloaded and embedded, so new sets land in the static catalog and visual index within a week,
   with no code change.
2. **In-app live sync**: once a day the app asks pokemontcg.io (then TCGdex) for the newest sets. Any set it
   doesn't know yet is pulled straight from the API into IndexedDB, so it is searchable immediately.
3. **On-device indexing**: cards from sets newer than the downloaded index are embedded on the phone in the
   background (both image CDNs allow CORS), so they become scannable the same day.
4. **OCR rescue**: if a card isn't in the visual index yet, the printed number + set total (`045/198`) still
   finds it in the catalog.
5. **New eras**: a series name the app has never seen (the API's `series`) becomes its own era automatically.
   Known series map to the fixed eras in `src/shared/era.ts`.

The client only downloads catalog chunks whose hash changed, so a weekly price refresh costs a few hundred KB.

## Pricing details

- **TCGplayer** numbers come from the Pokémon TCG API's `tcgplayer` field when it has them. TCGdex fills gaps
  (Shadowless, Poké Ball / Master Ball reverse, stamps, missing sets) and is marked "via TCGdex". **Cardmarket**
  (EUR) comes from TCGdex; tap *Show Cardmarket €* or switch the source in Settings.
- When you open or scan a card while online, its prices are refreshed from both APIs (at most once a day).
- Printings with no price of their own are estimated from a related printing with an editable multiplier and
  marked **est.**
- **Condition multipliers** (editable): NM 1.0, LP 0.85, MP 0.70, HP 0.50, DMG 0.35.
- **Bulk floor** (optional): cards under the threshold (default $0.25) count at buylist rates per class: common or
  uncommon $0.01, rare $0.05, holo $0.10, reverse $0.05, ultra $0.25. All editable.
- **Hits**: anything worth at least the hit threshold (default $1) gets a gold flash, a chime and a HIT tag.
- **Price history**: every sync stores a snapshot per card, which feeds the sparkline. Until a few snapshots exist,
  the sparkline uses Cardmarket's 30/7/1-day averages.
- Prices are estimates, not offers.

## Exports

- **CSV**: every column you'd want (name, set, set code, number, rarity, era, printing, condition, qty, market,
  low, unit and line value, currency, price date, est./bulk flags, card id, TCGplayer link).
- **TCGplayer Mass Entry**: `qty Name [SETCODE] number` lines, merged per printing, as a download or copied to the
  clipboard. Set codes are the official TCG Online codes. For a set TCGplayer abbreviates differently, fix the
  code in the Mass Entry box (*Show Set Codes* lists them).

## Project structure

```
src/
  app/          state (Preact signals), boot sequence, haptics + sound
  data/         IndexedDB schema, catalog sync + search, live API sync, API clients
  recognition/  TF.js embedder, vector index, OCR, fusion/confidence
  scan/         scan loop (tracking, evidence accumulation, locking), capture/warp
  vision/       camera, card detector (Hough + border/termination/color cues), refinement, homography
  pricing/      price engine (variants, conditions, bulk floor, hits)
  sessions/     CSV + Mass Entry export
  ui/           screens and sheets
  shared/       code shared by the app and the build scripts (types, eras, normalizers, numbers, resampling, projection)
  workers/      detection worker
  sw.ts         service worker (offline shell, model/OCR/index/image caching)
scripts/
  build-catalog.ts  build-index.ts   data builders
  model/            export_model.py (re-exports the committed TF.js model)
  dev/              benchmarks and browser tests (detector, recognition, OCR, parity, e2e)
public/models/cardnet-v1/  the on-device model (MobileNetV3-Large + regional GeM, float16, 5.9 MB) + PCA projection
tests/                      vitest unit tests
```

### The model

`scripts/model/export_model.py` builds the model from Keras' ImageNet MobileNetV3-Large. It pools the final feature
map three ways (whole card, artwork window, footer strip) with GeM and L2-normalizes each. It is exported to TF.js
with float16 weights; the exported files are committed, so you don't need Python. `npm run index` fits a 2,880→256
PCA-whitening projection on the card images (saved as `projection.bin`) and reuses it after that. Parity check:
`npx tsx scripts/dev/parity.ts`.

### Load budget

First load is about 270 KB gzipped (app, TF.js, UI). In the background, after first paint, it fetches the model
(5.9 MB), projection (3 MB), index (5.3 MB), OCR (about 6 MB, only one core variant per device) and catalog (about
3 MB gzipped). All of it is cached by the service worker and IndexedDB, so scanning works offline.

## Dev tools

```bash
npx tsx scripts/dev/test-detector.ts 80          # detector accuracy on synthetic scenes
npx tsx scripts/dev/eval-recognition.ts 400      # end-to-end recognition benchmark (--oracle, --no-alts)
npx tsx scripts/dev/ocr-probe.ts card.png        # what Tesseract reads on the number strip
npx vite preview --port 4173 & node scripts/dev/e2e-scan.mjs clip.y4m out/   # headless browser + fake camera
```

Add `?debug` to the URL to log every recognition decision to the console.

## Tips

- A plain, dark surface and even light give the fastest locks. Use the flashlight button in dim rooms.
- Sleeves are fine. Heavy glare on holos can need a slight tilt, and evidence from the next frames usually covers it.
- WotC 1st Edition, Shadowless and stamped promos: tap the printing chips in the card sheet. Prices follow the
  printing.

## Disclaimer

Card data and images come from the [Pokémon TCG API](https://pokemontcg.io) and [TCGdex](https://tcgdex.dev).
BulkBot is not affiliated with Nintendo, The Pokémon Company, Creatures, GAME FREAK, TCGplayer or Cardmarket.
Pokémon and all card names and images are trademarks of their respective owners.
