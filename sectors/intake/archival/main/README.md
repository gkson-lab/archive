# archival

one vault for everything you build. projects, docs, designs and snippets from ai chats, coding
agents, github and cloud drives go into one folder with a real file tree and history. open, edit
and run them in place, then commit, push or open a pull request in one step.

a gk labs tool. macos, windows and linux.

## what it does

- **one vault.** `~/archival` by default (movable). `vault/` is plain folders you can read without
  archival: `projects`, `docs`, `designs`, `snippets`, `assets`, `links`, `inbox`.
- **archive, not just folders.** every item keeps where it came from and has snapshots. contents
  are stored once (blake3 + zstd), so snapshots are cheap. deleting goes to trash for 30 days.
- **inbox.** anything imported lands in the inbox with a suggested folder and tags. enter files it.
- **open in place.** code and text editor, markdown and html preview, pdf, images and svg with
  zoom, video and audio, design tokens as a table, link cards for saved urls and figma files.
- **run it.** archival reads `package.json`, `Cargo.toml`, `pyproject.toml`, `go.mod`,
  `Makefile`, `justfile`, `deno.json`, compose files and devcontainers and offers the commands.
  runs happen in a real terminal; dev server ports open in a preview pane. local, container
  (docker or podman) or webassembly for single js and python files. imported code always shows its
  commands before the first run. missing toolchains are fetched with mise into the vault.
- **ship it.** status, diffs, staging, commit, push, pull with a three pane conflict view,
  branches, one timeline of commits and snapshots, pull requests (with the repo's template), and
  publish as a new github repo in one step. several github accounts, each item remembers its own.
- **connectors.** local folders (import or watch), any git remote, github repos and gists, an
  agent workspace folder (new projects show up in the inbox), google drive, dropbox, s3 / r2,
  figma and notion. secrets stay in the os keychain.
- **for agents.** an mcp server (`archival mcp`) with tools to search, read, write, create,
  snapshot, run, commit and open prs. every agent write is snapshotted first so it can be undone.

## build

needs rust (stable), node 22 and pnpm. on linux also the webkit packages tauri needs:

```bash
sudo apt-get install -y libwebkit2gtk-4.1-dev libgtk-3-dev libsoup-3.0-dev libayatana-appindicator3-dev librsvg2-dev
```

```bash
pnpm install
```

```bash
pnpm tauri dev
```

release build (installers for the current os):

```bash
pnpm tauri build
```

tests:

```bash
cargo test --workspace --exclude archival-desktop
```

## cli

```bash
cargo install --path crates/archival-cli
```

```text
archival init [path]            create or open a vault and make it the default
archival add <folder|file|zip|url> [--file]
archival ls [category]
archival search <query> [--contents]
archival open <item>
archival run <item> [--command ...]
archival ship <item> -m "message" [--pr]
archival snapshot <item>
archival mcp                    mcp server on stdio
archival serve [--ui dist]      local bridge for the ui in a browser (127.0.0.1, token protected)
archival api <method> [json]    call any api method
```

the desktop app also runs the mcp server: `archival-desktop mcp`. settings → agents shows the
config to paste into an agent.

## ui in a browser

for working on the ui without the desktop shell:

```bash
cargo run -p archival-cli -- serve
```

```bash
pnpm dev
```

vite proxies `/api` to the bridge and adds the token from `<vault>/.archival/bridge-token`.

## layout

```text
crates/
  archival-core        vault, sqlite index, objects, snapshots, trash, search
  archival-ingest      folders, zips, files, pastes, urls
  archival-git         git through libgit2
  archival-github      accounts, repos, pull requests, gists, keychain secrets
  archival-run         run detection and the pty supervisor
  archival-connectors  the connector trait and built-in connectors
  archival-service     one json api used by every front end
  archival-mcp         mcp server
  archival-cli         the `archival` command
apps/desktop           tauri app (src-tauri) and the react ui
packages/ui            tokens, chrome text, components, motion
packages/glass         liquid glass dock and lens filter
packages/viewers       editor, markdown, pdf, images, tokens, diff
vendor/                pinned paper shaders
docs/                  architecture notes
```

## not yet

- syncing one vault across devices (lan, your own bucket, end to end encrypted)
- third party connectors as wasm plugins
- signed builds and auto update
