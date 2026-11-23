# archival: plan and blueprints

name: **archival**. a gk labs tool.

one line: a local-first archive for everything you build with ai. projects, design files, docs and
scattered snippets go into one vault, get a real file tree and version history, can be opened, edited
and run in place, and can be committed or turned into a pr on github in one step.

status: plan only. nothing built yet.

---

## 1. the problem it solves

developers working with ai coding tools end up with work spread across:

- ai chat outputs, coding agent sessions, gists, downloaded zips
- half-finished repos in random folders, `~/Downloads`, `~/Desktop/test2`
- figma links, svg exports, screenshots, pdf specs, markdown notes
- google drive, notion, dropbox, s3 buckets, several github accounts

there is no single place that holds all of it, knows where each piece came from, and lets you act on it
(run it, edit it, ship it). archival is that place.

## 2. core ideas

1. **one vault.** a single storage container on disk (`~/archival` by default, movable). everything lives
   under it, organised as a browsable file tree.
2. **archive, not just folders.** every item keeps its origin, its history, and can be snapshotted,
   restored, deduplicated and exported. deleting is soft; nothing is lost by accident.
3. **act in place.** open, edit, preview and run what's in the vault without copying it elsewhere.
4. **ship in one step.** commit, push, open a pr, or publish a brand new repo from any item.
5. **connected, not locked in.** connectors pull from github, git remotes, cloud drives and design
   tools, and push back out. the vault is plain files plus an index: readable without archival.
6. **ai-native.** coding agents read and write the vault through a built-in mcp server
   and a cli, so ai output lands in the archive instead of being scattered.
7. **every os.** macos, windows, linux from one codebase, with devices syncing the same vault.

## 3. what lives in the vault

| kind | examples | opens in |
|---|---|---|
| project | a repo, an ai agent output folder, a zip of an app | tree + editor + runner + git |
| document | md, txt, pdf, docx, html | editor / viewer |
| design | svg, png, fig links, sketch exports, design tokens json | viewer with zoom, compare, tokens table |
| snippet | a single file or paste from a chat | editor, can be promoted to a project |
| asset | fonts, video, audio, binaries | viewer / metadata |
| link | a url, figma file, notion page, gist | live preview card + cached snapshot |

each item has: id, kind, title, origin (connector + source path/url), tags, created/updated, snapshots,
linked remotes (e.g. `github.com/gkson-lab/windsim`), and run config if it's runnable.

## 4. architecture

### 4.1 stack

| layer | choice | why |
|---|---|---|
| shell | **tauri 2** | one rust core + web ui, native on mac/win/linux, small binaries, auto-update, mobile path later |
| core | **rust** workspace | file io, hashing, git, process spawning and sync need to be fast and safe |
| ui | **typescript + react + vite** | biggest ecosystem for editors, terminals, pdf, diff views |
| editor | **codemirror 6** | light, accessible, extensible, good for both code and markdown |
| terminal | **xterm.js** + rust `portable-pty` | real pty on every os |
| index | **sqlite** (+ fts5 full text search) | one file, fast queries, works offline |
| objects | content-addressed blobs, **blake3** hash, **zstd** compression | dedup across the whole vault, cheap snapshots, easy sync |
| git | **gitoxide / git2-rs**, fall back to system git for edge cases | commit, branch, diff, push without requiring git installed |
| github | rest + graphql via **octocrab** | prs, repos, gists, device-flow login |
| secrets | os keychain via **keyring** crate | tokens never stored in plain files |
| shaders | **@paper-design/shaders**, vendored + pinned | liquid metal mark, empty states (see design) |

### 4.2 on-disk layout

```
~/archival/
  vault/                  # the human-readable tree. plain files. this is what you browse.
    projects/
      windsim/            # a real git working tree
    docs/
    designs/
    snippets/
    inbox/                # anything ingested but not yet filed
  .archival/
    index.sqlite          # items, tags, origins, search, run configs
    objects/ab/cdef...    # blake3-addressed, zstd-compressed snapshot blobs
    snapshots/            # snapshot manifests (tree of hashes per item per point in time)
    trash/                # soft-deleted items, restorable for 30 days (configurable)
    connectors/           # per-connector sync state (cursors, etags). no secrets.
    logs/
```

rule: `vault/` must always make sense without archival installed. `.archival/` is rebuildable from `vault/`
except for history and trash.

### 4.3 rust workspace

```
archival/
  apps/
    desktop/              # tauri app (rust side + web ui)
  crates/
    archival-core/            # vault, items, index, snapshots, dedup, trash, search
    archival-ingest/          # importers: folder, zip, url, paste, drag-drop, file watcher (notify)
    archival-git/             # local git ops, diff, status, history
    archival-github/          # auth, repos, prs, gists, issues (read)
    archival-run/             # toolchain detection, process supervisor, ports, sandbox modes
    archival-connectors/      # connector trait + built-ins
    archival-sync/            # device-to-device and bucket sync
    archival-mcp/             # mcp server exposing the vault to ai agents
    archival-cli/             # `archival` command
  packages/
    ui/                   # design system: tokens, components, motion
    glass/                # liquid glass svg filter + displacement map builder
    viewers/              # pdf, image, svg, design, markdown, diff
  vendor/
    paper-shaders@<pinned>/
  docs/
```

the desktop app, cli and mcp server all call the same `archival-core`, so behaviour is identical everywhere.

### 4.4 connector interface

every connector implements one trait:

```rust
trait Connector {
    fn id(&self) -> &str;                       // "github", "gdrive", "local-folder"
    async fn auth(&mut self) -> Result<Auth>;   // oauth device flow / token / none
    async fn list(&self, cursor: Option<Cursor>) -> Result<Page<RemoteEntry>>;
    async fn pull(&self, entry: &RemoteEntry, into: &ItemPath) -> Result<Snapshot>;
    async fn push(&self, item: &Item, target: &RemoteTarget) -> Result<PushResult>; // optional
    fn watch(&self) -> Option<EventStream>;     // optional live updates
}
```

built in, in priority order:

1. **local folder** (watch a folder, ingest on change, or one-time import)
2. **git** (any remote over ssh/https)
3. **github** (repos, gists, prs, releases; multiple accounts)
4. **agent workspaces** (ingest output folders from any ai coding agent; see 4.7)
5. **google drive**, **dropbox**, **s3 / r2 / any s3-compatible**
6. **figma** (link items with thumbnails + exported frames)
7. **notion** (pages as markdown snapshots)
8. **url** (save a page or file with a cached snapshot)

third-party connectors later via a sandboxed wasm plugin api using the same trait.

### 4.5 running programs

goal: press run on any project and it works, without the user writing config (tesler's law: the system
absorbs the complexity).

1. **detect**: read `package.json` scripts, `pyproject.toml`, `requirements.txt`, `Cargo.toml`,
   `go.mod`, `Makefile`, `justfile`, `deno.json`, `index.html`, `docker-compose.yml`,
   `.devcontainer/devcontainer.json`. propose a run command and a setup command.
2. **resolve toolchain**: use what's installed; if missing, offer to install a pinned version per
   project (via mise / uv / rustup / fnm) into `.archival/toolchains`, never touching the system.
3. **run modes** (pick per project, default shown first):
   - **local**: process on the host in a per-project env. fastest.
   - **container**: docker / podman if available, or devcontainer.json if present. isolated.
   - **wasm**: quick run for single-file snippets (python via pyodide, js in a worker). no install.
4. **supervise**: start, stop, restart, logs, env vars, exit codes. integrated terminal per project.
5. **preview**: detect opened ports and show a live preview pane (embedded webview) with reload and
   open-in-browser. static html runs instantly.
6. **safety**: first run of anything ingested from outside shows the exact commands before running.
   network and file access limits in container mode.

### 4.6 git and github flow

from any item:

- **commit**: staged diff view, message field, commit. ai message suggestion optional.
- **push**: to the linked remote, or pick one.
- **open pr**: choose base branch, title + body (pr template detected and pre-filled), opens on github.
- **publish as new repo**: item is not a repo yet → `git init`, create repo on github (private by
  default), first commit, push. one button, one confirmation.
- **pull / sync**: fetch, fast-forward, show conflicts in a three-pane diff.
- **history**: per-item timeline merging git commits and archival snapshots.

multiple github accounts supported; each item remembers which account it uses. commit author is set
per account (e.g. `gkson`).

### 4.7 ai integration

- **mcp server** (`archival mcp`): tools like `vault.search`, `vault.read`, `vault.write`, `item.create`,
  `item.snapshot`, `item.run`, `git.commit`, `github.open_pr`. writes from agents land as new
  snapshots, so any agent change can be reverted. add it to any mcp-capable agent with one command.
- **cli**: `archival add <path|url>`, `archival open <item>`, `archival run <item>`, `archival ship <item> --pr`,
  `archival search <query>`. so terminal and agent workflows feed the vault directly.
- **agent workspace connector**: watch chosen working directories; when a session produces a project,
  offer to file it.
- **optional in-app assistant** off by default, bring your own model
  provider and key. used for: commit messages, pr descriptions, auto-tagging, "what is this
  folder" summaries.

### 4.8 cross-device sync

all os connected = the same vault on every machine.

- objects are content-addressed, so sync is "send the hashes the other side lacks".
- metadata syncs as a crdt (cr-sqlite or automerge) so offline edits merge cleanly.
- transports, in order: **lan** (mdns discovery, direct), **bring your own bucket** (s3 / r2 / drive),
  later an optional hosted gk labs relay.
- end-to-end encrypted (xchacha20-poly1305, keys derived from a vault passphrase, stored in keychain).
- per-item "local only" flag for things that should never leave a machine.
- git working trees sync through their remotes where they have one; archival syncs only untracked state.

## 5. design system

follows gk's design rules: the chrome look, antislop filter, and the 17 laws.

### 5.1 tokens (from the formula)

- canvas `#0b0b0d`, glass `#1a1a1f`, text `#f3f1ec`, muted `#a6a3ab`, line `#3a3a42`, edge `#7a7782`
- accent `#d7dde6` (silver). declared exception: the oil-slick rim gradient, used only on rims and the
  logo, never on fills.
- fonts: instrument serif (display, lowercase) + recursive variable (`CASL 1` body, `MONO 1` code).
  self-hosted woff2, bundled in the app.
- light theme: "print" variant (paper `#f4f1ea`, ink neutrals, multiply). both themes ship and are
  checked for wcag aa.

### 5.2 layout

```
┌──────────────────────────────────────────────────────────────────────┐
│ ◐ gk   archival / projects / windsim                        ⌘k   ●  sync │  titlebar (native drag)
├────────────┬─────────────────────────────────────────┬───────────────┤
│ vault tree │  editor / viewer / preview              │ inspector     │
│            │                                         │ (collapsed by │
│ ▸ inbox 3  │                                         │  default)     │
│ ▾ projects │                                         │               │
│   windsim  │                                         │               │
│   onyx     │                                         │               │
│ ▸ docs     │                                         │               │
│ ▸ designs  │                                         │               │
├────────────┴─────────────────────────────────────────┴───────────────┤
│              ( files · run · git · connectors )   [ commit & push ]  │  glass dock
└──────────────────────────────────────────────────────────────────────┘
```

- **content stays flat.** glass only on the bottom dock and on modals / the command palette (max 2
  glass surfaces, per the formula).
- **one primary action per view** (von restorff): the chrome-text button on the right of the dock.
  it changes with context: `commit & push`, `run`, `file it`, `open pr`. everything else is quiet.
- **inspector** holds advanced metadata (origin, hashes, run config, remotes). collapsed by default
  (progressive disclosure).
- **command palette** (`⌘k` / `ctrl k`): every action is searchable (recognition over recall).
- separation by whitespace and single hairlines (`line` token). one bordered group per viewport max.

### 5.3 screens

1. **shelf (home)**: one dominant panel (about 60%) showing the item you were last working on with its
   unfinished state ("3 uncommitted files", "pr draft not sent"). below it, compact rows: inbox,
   recent, pinned. (zeigarnik, serial position, antislop 3+ items rule.)
2. **vault**: tree + item view. the main workspace.
3. **run**: terminal, logs, preview pane, ports, env.
4. **git**: changes, diff, history timeline, branches, pr form.
5. **connectors**: list of connected sources with last sync, errors and a retry, plus "add connector".
6. **inbox triage**: newly ingested items, suggested location + tags, one key to accept.
7. **settings**: vault location, themes, accounts, sync, run modes, mcp setup. gk labs credit lives here.
8. **first run**: no tour. a single drop zone: "drop a folder to start your vault." the user learns by
   doing it (paradox of the active user).

### 5.4 gk labs branding (subtle)

- the liquid-metal gk mark, 16px, top-left of the titlebar. static by default; the shader only runs on
  hover and on the about screen.
- splash / empty vault: liquid metal mark via paper shaders, pausable, css fallback without webgl2.
- "a gk labs tool" line in settings > about. nowhere else.
- app icon: chrome "a" with a thin oil rim, matching the gk mark family.

### 5.5 motion catalogue

every animation has a reason (antislop purpose test). all are input-driven, 150 to 300ms, stop when
input stops, and collapse to instant changes under `prefers-reduced-motion` in both css and js.
dials: energy 3 / rhythm 4 / motion 3 (a tool, calmer than a portfolio).

| animation | trigger | duration | reason / law |
|---|---|---|---|
| tree expand: children slide 4px and fade in | click / arrow key | 180ms | shows which children belong to which parent (proximity, common region) |
| dock lens: liquid glass pill slides between tabs, draggable | tab click / drag | 220ms spring | shows where you are and where you're going; press lifts the lens (scale 1.15) |
| drop target: oil-slick rim appears on the folder you hover | file drag over | 150ms | tells you exactly where a drop will land |
| ingest progress: thin chrome ring fills around the item icon, with "12 of 40 files" | ingest running | live | progress is visible and shrinking (zeigarnik, goal-gradient) |
| commit seal: changed-file count ticks down to 0, chrome button shines once | commit succeeds | 280ms | confirms the work is saved, once, then stops |
| pr sent: dock button morphs into a link chip "pr #12 open" | pr created | 240ms | turns the result into the next useful thing (a link) |
| diff reveal: changed lines fade from line colour to their state colour | open diff | 200ms | draws the eye to what changed first |
| run status dot: pulses only while a process is starting, solid when ready | run | loop inside canvas, ends at ready | the only loop; it has a stop control (the stop button) |
| palette open: glass panel scales 0.98 → 1 with blur in | ⌘k | 160ms | ties the palette to the keystroke |
| sync: small arrow rotates once per sync batch, not continuously | sync activity | 300ms per batch | shows sync happened without a spinning distraction |
| shader mark on splash | idle on splash / about | canvas loop, pause button, paused off screen | the one branded moment |

implementation rules from the formula: don't animate css variables per frame behind clipped text;
animated layers get `will-change: transform` + `contain: paint`; chrome text uses `background-image`
not the `background` shorthand.

### 5.6 states

every dynamic surface ships with loading, empty, error (with retry), success and default. examples:

- connector list: empty → "no sources yet. add github to pull your repos." error → "github token
  expired. sign in again" + button.
- run: no detected command → "couldn't find how to run this. pick a command" with the detected
  candidates listed.
- search: no results → shows the query and offers "search file contents" if it was a name search.

### 5.7 copy

all lowercase, short, plain. no buzzwords, no em dashes, no "get started" / "learn more". buttons say
what they do: `commit & push`, `open pr`, `run`, `file it`, `restore`.

### 5.8 accessibility

- wcag aa in both themes, 3:1 for control edges.
- full keyboard: tree uses aria treeview patterns, dock is a tablist, palette is a combobox.
- 44px targets on touch / small screens, visible focus rings (silver, 2px offset).
- screen reader labels for every icon button; live region for ingest / run / sync status.
- zoom never disabled; ui scales with os text size.

## 6. how the 17 laws land

| law | where |
|---|---|
| aesthetic-usability | finished chrome details, consistent motion, real empty states |
| proximity | tree indentation, item metadata grouped under its title |
| von restorff | one chrome primary button per view |
| zeigarnik | shelf shows unfinished work; inbox count |
| tesler | auto-detected run commands, auto-filed ingest, pr template prefill |
| prägnanz | three-column layout, one dock, simple shapes |
| serial position | dock order: files first, connectors last; most-used commands top of palette |
| progressive disclosure | inspector collapsed; advanced run options behind "more" |
| common region | the dock is the only grouped control region |
| goal-gradient | ingest ring, "2 steps left" on publish-as-repo |
| similarity | every primary action looks the same, every secondary looks the same |
| recognition over recall | command palette, recent items, connector picker with icons |
| pareto | ingest, open, run, commit & push get the best polish and shortest paths |
| occam's razor | no dashboards or stats screens in v1 |
| parkinson | one-click publish, defaults everywhere, no forms over 3 fields |
| uniform connectedness | an item's linked remote shown as a hairline connector to its origin badge |
| active user | first run is a drop zone, not a tour |

## 7. milestones

each milestone ends with: render check at 320 / 375 / 768 / 1280, both themes, keyboard pass, console
clean, built and launched on macos, windows and linux in ci.

- **m0: foundation.** monorepo, tauri shell, design tokens, fonts, glass dock, command palette, theme
  switch, ci builds for all three oses.
- **m1: the vault.** `archival-core` (index, objects, snapshots, trash), local folder + zip + drag-drop
  ingest, vault tree, inbox triage, search, editor for code + markdown, viewers for image / svg / pdf.
- **m2: ship it.** `archival-git` + `archival-github`: status, diff, commit, push, open pr, publish as new
  repo, multiple accounts, history timeline.
- **m3: run it.** `archival-run`: detection, local mode, terminal, logs, port detection, preview pane,
  container mode, wasm snippets.
- **m4: connect it.** connector trait, git, github import, agent workspaces, google drive, s3/r2, figma,
  notion, url. cli + mcp server.
- **m5: everywhere.** `archival-sync`: lan sync, bucket sync, e2e encryption, conflict ui.
- **m6: finish.** signed + notarised builds, auto-update, a11y audit, performance pass (100k-file
  vault), docs site in the chrome style on github pages, wasm connector plugin api.

v1 = m0 to m4. sync and plugins follow.

## 8. risks and how they're handled

| risk | mitigation |
|---|---|
| running untrusted code from imported folders | show commands before first run; container mode; never auto-run |
| huge vaults (node_modules, build output) | default ignore list, honour `.gitignore`, dedup, lazy tree loading |
| webview differences across oses (glass filter is chromium-only) | svg lens on chromium-based webviews (windows), frosted blur fallback on webkit (mac, linux) |
| token leakage | keychain only, scoped github tokens, no secrets in index or logs |
| sync conflicts | crdt metadata, file conflicts kept side by side, never silently overwritten |
| scope creep (it can do everything) | v1 limited to m0 to m4; pareto list decides polish order |

## 9. open questions for gk

1. open source (like onyx) or closed? affects license and the plugin story.
2. sync: bring-your-own-bucket only, or should gk labs host a relay later?
3. in-app ai assistant in v1, or rely on mcp + external agents only?
4. mobile (ios / android viewer) on the roadmap, or desktop only?
5. default vault location and whether to offer importing existing `~/code` style folders on first run.
