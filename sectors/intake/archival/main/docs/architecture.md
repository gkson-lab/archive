# architecture

## one api

every front end talks to `archival-service` with `call(method, params) -> json`:

- the desktop app through one tauri command, `api`
- the cli directly
- the mcp server, which maps its tools onto service methods
- the browser bridge (`archival serve`) over http on 127.0.0.1

so behaviour is the same everywhere. blocking work runs on tokio's blocking pool; long work
(imports, clones, publishing) runs as a job the ui polls for progress.

## the vault on disk

```text
~/archival/
  vault/                 plain folders. readable without archival.
    projects/ docs/ designs/ snippets/ assets/ links/ inbox/
  .archival/
    index.sqlite         items, snapshots, trash, connectors, settings, fts5 search
    objects/ab/cdef…     blake3-addressed, zstd-compressed file contents
    snapshots/           snapshot records (also in the index)
    trash/<id>/          soft-deleted paths
    toolchains/          mise data dir for per-project toolchains
    tmp/                 scratch space for imports
```

an item is a top-level entry under a category folder: `projects/windsim` or `docs/notes.md`.
`.archival/` can be rebuilt from `vault/` except for history and trash (settings → rebuild index).

## snapshots

a snapshot is a manifest of `(path, blake3, size, exec)` for every file of an item, stored as an
object itself. files go into the object store once, so a snapshot of an unchanged item costs a
manifest. restore makes the folder match the manifest and takes a snapshot of the current state
first. ingest, agent writes, pulls and discards all snapshot automatically.

## ignore rules

walking, snapshots, search and imports skip `.git`, a default list (`node_modules`, `target`,
`dist`, `.venv`, …) and anything in `.gitignore`. imports keep `.git` so history comes along.

## running code

detection reads the project's own manifests. runs go through a pty (portable-pty), output is kept
in a 2 mb ring buffer per run and read by offset, ports are picked up from the output. an item
that came from outside the vault must be approved once before it runs.

## secrets

github tokens, connector tokens and the assistant key live in the os keychain (macos keychain,
windows credential manager, linux kernel keyring). the index only stores which account an item
uses.

## design

chrome on near-black, ink on paper. instrument serif for display, recursive for everything else.
glass only on the dock, the palette and dialogs. one primary action per view, in the dock. motion
is input driven, 150 to 300 ms, and turns off with reduced motion. the only loops live inside
canvases: the run status dot while a process starts, and the liquid metal mark on the about
screen, which has a pause control and stops off screen.
