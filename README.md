# gk-labs archive

every version of everything i've made, slapped in one place.

each project gets a shelf in a sector. every branch it ever had is filed next to it as a full copy of its files,
so nothing depends on the original repo still being around. onyx is the exception: its shelf has the demo
installed, so it runs straight from the archive.

**browse it:** [gkson-lab.github.io/archive](https://gkson-lab.github.io/archive/)

## the sectors

| sector | what's on it |
|---|---|
| a · ai | onyx, with the demo installed |
| b · desktop | apps that sit on a pc: gk control center (every expansion pack, linux and mac builds), omnitool |
| c · browser | things that run in a page: long shot 10, windsim, race watch |
| d · sites | gk-labs, in every draft it went through |

## how it's laid out

```
sectors/
  <sector>/
    sector.json              name and blurb for the sector
    <project>/
      manifest.json          every version, its branch, last commit and file list
      history.txt            the full commit log, every branch
      <version>/             a complete copy of one branch
      demo/                  onyx only: the installed demo
tools/
  accession.py               file a project (every branch becomes a version)
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

`catalog.json` isn't committed. the publish workflow builds it on every push to main, so two shelves filed in two
pull requests never conflict.

## looking at it locally

```bash
python3 tools/catalog.py
```

```bash
python3 -m http.server 8000
```

then open `http://localhost:8000`.

## publishing

settings → pages → source: **github actions**. `.github/workflows/pages.yml` builds the catalog and publishes the
site on every push to main. `.github/workflows/check.yml` runs `tools/check.py` on every pull request.

## licenses

every shelf keeps the license files of the project it came from. the fonts (instrument serif, recursive) are under
the sil open font license, in `assets/fonts/`.
