# archive design contract

the design contract for the gk-labs archive (`index.html`, `404.html`, `assets/`). it follows the antislop template
and takes its identity straight from the gk-labs site contract (`gkson-lab/gkson-lab/DESIGN.md`): same palette,
same type, same split. this file only records what's different.

Mode: EDITORIAL
Dial: ENERGY 3 / RHYTHM 4 / MOTION 1
(`prefers-reduced-motion: reduce` turns off the pointer-driven fringe and every transition.)

## 1. context

- **who it's for:** gk, and anyone who wants to read an old version of something gk made.
- **where it lives:** github pages, from `gkson-lab/archive`. static files. the only build step is
  `tools/catalog.py`, run by the publish workflow.
- **what it has to do:** list every project by sector, open any version of any project, read any file in it,
  and run the onyx demo. it has to keep working as shelves get added, with no hand-edited index.

## 2. personality & what we are not

- **idea:** the stacks of a library, seen through the gk-labs glass. sectors are aisles with a big italic letter,
  projects are entries in a ledger with an accession number, versions are strata you pick from, and the file view
  is the reading room.
- **voice:** all lowercase, relaxed, first person, short sentences. no hype words, no em dashes.
- **not:** a dashboard, a card grid, a stat-tile row, a github clone. the counts on the front desk are one plain
  sentence of real numbers from the catalog.

### purpose of every technique

| technique | why it's here |
|---|---|
| rgb split on display type | the gk-labs identity, carried over so the archive reads as part of the same site. |
| 1px fringe on body text | same as gk-labs. the split slider at 0 removes it. code in the reading room never gets it, so it stays sharp. |
| big italic sector letter | an aisle sign. it tells you where you are while you scroll the stacks. |
| accession numbers | archive language, and a stable way to refer to a project. assigned oldest first. |
| ledger rows with hairlines | a register, not cards. content radius is 0, like gk-labs. |
| "demo installed" stamp | the one place a project is different (onyx), marked once. |
| strata buttons for versions | a branch is a layer of the same project. the pressed one is lifted glass. |
| pointer-driven fringe direction | the cursor is the light source, same as gk-labs. |

## 3. color

identical tokens to the gk-labs contract, all three themes (prism, print, thermal), with the same measured
contrast pairs. the theme and split are stored under the same keys (`gk-theme`, `gk-split`), so a choice made on
gk-labs carries over. dispersion colors are only used for fringes and the split, never for text or fills.

## 4. type & touch

- instrument serif for display (lowercase), recursive for body (`CASL 1`) and code (`MONO 1`). two families,
  self-hosted.
- archive title `clamp(4.25rem, 13vw, 12rem)` over body `1.0625rem`. smallest text `0.75rem` (stamps).
- every control is at least 44px tall, or has a 44px hit area (small buttons extend theirs with `::after`).
- radius: `999px` for controls, `0` for content.

## 5. states

- **catalog:** loading shows the archive title with "opening the drawers...". failure explains how to build the
  catalog, with a "try again" button; opened from `file://` it explains how to serve the folder instead.
- **search:** empty query hides results. while manifests load, a skeleton. no matches says so with the query.
- **shelf:** skeleton for versions while its manifest loads; error with "try again".
- **file:** skeleton while it loads. images are shown. binary or over 1.5 mb says why and offers download and raw.
  a failed read says what failed, with "try again".
- **copy:** success says "copied". failure says "couldn't copy, it's selected for you" and selects the text.
- **unknown shelf or path:** "not here", with a way back.
