# gonotes

A local web UI for a folder of markdown notes, in the style of gofluence:
search as you type, filter by folder and tag, read rendered markdown, edit in
place. The folder stays the only source of truth: no database and no sidecar
files, so `,cno`, `$EDITOR`, git and sync tools keep working beside it. Changes
made elsewhere show up within about five seconds (gonotes looks at the folder
again when its last look is older than that).

```sh
CGO_ENABLED=0 go build -o gonotes . && ./gonotes            # on 127.0.0.1:8090; the page asks for a folder
./gonotes -dir ~/somewhere/else -addr 127.0.0.1:8091        # or NOTES_DIR / NOTES_ADDR
./gonotes -dir ~/notes -dir work=~/cyon/notes                # several vaults to switch between
```

There is no default folder. The first start (no `-dir`, no config file) opens
a welcome page to pick one, with a folder browser, and then a short tour: make
a note with a name and `Enter`, delete it with `Delete`. *Options → Show the
tour* runs it again.

## Install

gonotes is one program with everything in it (pages, editor, icons): no
database, no runtime, nothing to install beside it. Go 1.27 builds it for any
of these from any machine:

| System | Build | Runs as | Page |
|---|---|---|---|
| Linux | `CGO_ENABLED=0 go build -o gonotes .` | systemd user service, app launcher | [docs/install-linux.md](docs/install-linux.md) |
| macOS | `CGO_ENABLED=0 GOOS=darwin GOARCH=arm64 go build -o gonotes .` (Intel: `amd64`) | launchd agent, Safari/Chrome app | [docs/install-macos.md](docs/install-macos.md) |
| Windows | `CGO_ENABLED=0 GOOS=windows GOARCH=amd64 go build -ldflags -H=windowsgui -o gonotes.exe .` | in the Startup folder, Edge/Chrome app | [docs/install-windows.md](docs/install-windows.md) |
| Android | `CGO_ENABLED=0 GOOS=linux GOARCH=arm64 go build -o gonotes-android .` | in Termux, installed from Chrome | [docs/install-android.md](docs/install-android.md) |

iPhone and iPad cannot run it: iOS lets no app keep a server running beside
the browser.

Everywhere it serves `http://127.0.0.1:8090` to that machine only, and the
page can be installed as an app (its own window and icon) from Chrome, Edge,
or Safari. The first start asks for the notes folder.

No Go installed? With nix: `nix --extra-experimental-features 'nix-command flakes' develop ../gofluence -c go build -o gonotes .`

The editor is CodeMirror, bundled once into `web/static/editor.js` and
embedded like the rest. Only after changing `editor/src/editor.js`:
`cd editor && npm install && npm run build`. The app icons come from
`go run tools/icons.go`.

## Vaults

Give `-dir` more than once (or `NOTES_DIR=~/notes:work=~/cyon/notes`) to serve
several folders and switch between them. Each is a vault of its own, named
after its folder unless given as `name=path`; the first is the default.

The vaults are kept in `~/.config/gonotes/vaults.json` (`-config`,
`NOTES_CONFIG`). The first start writes it from `-dir`; after that the file is
what counts, and the **Vaults** page (Options, or the vault menu) edits it:
names, folders, order, adding and taking off (the folder stays), and each
vault's colour gradient, which the page then wears. *Browse…* next to a folder opens the
desktop's own folder dialog (the XDG desktop portal, over D-Bus), drives
included; where there is none, a folder list served by gonotes, with shortcuts
to home and mounted drives. A vault whose folder is missing, like a drive not plugged in,
shows a message instead of the list (and nothing is made in its place); it
opens again once the folder is back.

A menu next to the logo, above the folders, switches, or press `v`, then
`1`–`9` (or `↑ ↓` and `Enter`); `Alt+1`–`9` switches straight away, even while
typing. The browser remembers the vault last picked. A page that is already
open stays on its own vault: searching, moving and saving there never touch
the vault another tab switched to.

Every vault also lists **gonotes-help.md**, the user guide from
`web/help.md`: built in, read-only and never written to the folder (a file of
that name in the folder takes its place). `?` opens it.

## Search

Everything lives in the one box and in the URL, so a search can be bookmarked.

| Query            | Means                                      |
|------------------|--------------------------------------------|
| `deploy nix`     | all words, anywhere in title, path or body |
| `"exact phrase"` | the phrase                                 |
| `-draft`         | without the word                           |
| `#ops`           | tagged `ops` (or `ops/…`)                  |
| `in:work/infra`  | in that folder (with *Folders include subfolders* in Options, below it too) |
| `sort:title`     | by title instead of relevance, then age    |

Tags come from `#inline` words outside code blocks and from front matter
`tags: [a, b]`. The title is the file name, or front matter `title:`;
headings are sections, never the title. Click the title above a note to
rename it. The sidebar toggles filters: one folder at a time, any number of
tags.

## Keys

On the list page the search box sits on top of the list and has the focus;
elsewhere it is on top of the page, `⌘K` / `Ctrl+K` reaches it from anywhere (the
editor included) and its results open in a dropdown.

Results are one-line rows, each with a faint excerpt after the title, and the
selected note underneath with the search words marked. Click into it to write:
it saves as you type, and `Esc` goes back to the search box.

| Key | Does |
|---|---|
| `↑ ↓` (`j k`), click | pick a row; the preview follows |
| `Enter`, double click | open the note in place: the list folds away, the folders dim, the editor takes the page; `Esc` or Back brings the list back. `/n/<note>` addresses open notes this way too |
| `Enter` with no match | start a new note titled with what you typed; `in:folder` is its folder, `#tags` its tags |
| `Shift+Enter` in the box, `e` | edit the selected note, or the one on screen |
| `Delete` (at the end of the box), `Delete`/`Backspace` elsewhere | delete the selected note, with Undo |
| `←` | into the folders: `↑ ↓` pick, `Enter` open, `m` move the selected note there, `n` new folder in it, `→` opens a closed folder (else back), `←` closes an open one, `Esc` back |
| `Alt+↑ ↓` | the folder above or below, the list following at once; `Alt+→ ←` opens or closes the folder in view |
| `Esc` | close the dropdown, clear the search, or go back |
| `n` | new note: made at once (*Untitled*, in the folder in view) and opened to write in |
| `v` | switch vault, then `1`–`9` or `↑ ↓` `Enter` (with more than one) |
| `Alt+1`–`9`, `Alt+V` | switch to vault 1–9, or open the menu, from anywhere (the editor included) |
| `?` | the help note |
| `Alt+B` | fold the sidebar away, or back (also ◀ at its top, ▶ at the window's edge) |
| `Alt+Enter` (or `Alt+L`) | the list over the whole page, or back (`Esc` too); drag the line under the list to resize it (beside the note: its width) |

In the editor: `Ctrl+S` save and open the note, `Esc` close, `Tab`/`Shift+Tab`
indent, `Enter` continues a list, `Ctrl`+click follows a link, `Ctrl+Z` undo.

**Options**, bottom left, keeps the theme, the **List** layout (above the
note, or beside it on the left; narrow windows keep it above) and **Vim mode**
in this browser.
Vim mode switches at once; a line under the note shows its mode. `i` types,
`Esc` stops typing, `Esc` again closes the note (back to the list); `:w` saves,
`:q` closes, `:wq` both.
Per vault, Options also picks the folder *new notes go to* when none is
picked (kept in `vaults.json`).

## Editing

Drag a note onto a folder in the sidebar to move it there, or onto *All
notes* for the top level: a row from the list or the ⌘K dropdown. A message at the bottom then offers Undo. A note of the same
name already in that folder blocks the move. Folders drag the same way, with
everything in them, onto another folder or *All notes*. Links in other notes
are not rewritten.

`+` next to *Folders* makes a folder, inside the one in view; `a/b` makes both.
Empty folders are listed too, so there is somewhere to drag notes to.

Right-click a note in the list, or a folder, for *Show in Files* (Finder on a
Mac): the file manager opens there, the note selected. A folder's menu also has
*Rename…*, in place, with Undo; notes and searches in it follow. *Exclude from search* leaves a folder, and
the folders in it, out of searches and *All notes*, kept with the vault; it is
grey in the sidebar, and picking it still shows its notes.

Deleting moves the note into `.trash/` in the notes folder; the Undo in the message at the bottom
puts it back.

Notes are written as they read: the markup (`#`, `**`, `[]()`, `- [ ]`, `>`)
shows only on the line the cursor is on, and everywhere else the note looks
rendered, with checkboxes you can tick. *Live* / *Source* at the top right switches the
rendering off for plain markdown, and is remembered in the browser.

The editor saves by itself a moment after you stop typing, and when you
leave it; a new path is taken once you leave the path field. Saving writes
the file atomically. If the file changed on disk since you
opened it, the save is refused and you can choose to overwrite. Changing the
path renames the note (folders are created). Dot-folders, `.trash/`
included, are never indexed.

Links between notes are ordinary relative markdown links, and images next to a
note are served too. Dropping or pasting a file into a note stores it in a
`media/` folder in the note's folder (a name of its own, never overwriting)
and links it there. Raw HTML inside notes is not rendered.

## Local only

It binds to `127.0.0.1` and answers only to `localhost`/IP hosts, and refuses
cross-site POSTs, so another page in the browser cannot write to your notes.
There is no login: do not expose it on a network.
