# gk-labs archive

every version of everything i've made, slapped in one place.

each project gets a shelf in a sector. every branch it ever had is filed next to it as a full copy of its files,
so nothing depends on the original repo still being around. onyx is the exception: its shelf has the demo
installed, so it runs straight from the archive.

**browse it:** [gkson-lab.github.io/archive](https://gkson-lab.github.io/archive/). read any file in any version,
download files one at a time, and follow every commit and pull request in the activity logbook.

## it keeps itself up to date

`.github/workflows/sync.yml` runs every 30 minutes (and by hand from the actions tab). for every repo in
`sources.json` it checks the branches and pull requests, and when anything moved it files that shelf again,
commits it to main and republishes the site:

- **new commits or branches** show up as updated or new versions.
- **open pull requests** are filed as versions too (`pr #12`), forks included. their activity (opened, merged,
  closed) goes in the logbook.
- **onyx syncs partly:** the demo is refreshed from main and its activity and pull requests are logged, but its
  shelf stays the demo, not the whole repo.
- **new repos** you make (not forks) get added to `sources.json` and filed in the **intake** sector by themselves.
  move one to a proper sector by changing its `sector` in `sources.json`.

a project that's in `sources.json` but not on main yet is waiting for its pull request, so sync leaves it alone.

to sync straight after a push instead of waiting up to 30 minutes, a source repo can ping it (needs a token with
access to this repo):

```bash
gh api repos/gkson-lab/archive/dispatches -f event_type=source-updated
```

## the sectors

| sector | what's on it |
|---|---|
| a · ai | onyx, with the demo installed |
| b · desktop | apps that sit on a pc: gk control center (every expansion pack, linux and mac builds), omnitool |
| c · browser | things that run in a page: long shot 10, windsim, race watch |
| d · sites | gk-labs, in every draft it went through |
| e · intake | new repos, filed automatically until they get a sector |

## how it's laid out

```
sectors/
  <sector>/
    sector.json              name and blurb for the sector
    <project>/
      manifest.json          every version, its branch, last commit and file list
      activity.json          every commit and pull request
      history.txt            the full commit log, every branch
      <version>/             a complete copy of one branch
      demo/                  onyx only: the installed demo
sources.json                 every repo the archive follows, and where it's shelved
tools/
  sync.py                    check every source and file again whatever moved
  accession.py               file a project (every branch and open pr becomes a version)
  catalog.py                 rebuild catalog.json from the manifests
  check.py                   make sure every manifest matches what's on disk
index.html, assets/          the site
```

branches with exactly the same files as one already filed are recorded as "same as" that version instead of being
copied twice.

## filing something new

```bash
python3 tools/accession.py https://github.com/gkson-lab/<repo> <sector> --title "<name>" --summary "what it is"
```

```bash
python3 tools/check.py
```

then open a pull request with the new shelf. one project per pull request keeps each review small.

to have sync follow it too, add it to `sources.json`.

`catalog.json` and `activity.json` aren't committed. the publish workflow builds them on every push to main, so two
shelves filed in two pull requests never conflict.

## looking at it locally

```bash
python3 tools/catalog.py
```

```bash
python3 -m http.server 8000
```

then open `http://localhost:8000`.

## publishing

settings → pages → source: **github actions**. `.github/workflows/pages.yml` builds the catalog and the activity feed
and publishes the site on every push to main, and after every sync that changed something. `.github/workflows/check.yml` runs `tools/check.py` on every pull request.

## licenses

every shelf keeps the license files of the project it came from. the fonts (instrument serif, recursive) are under
the sil open font license, in `assets/fonts/`.
