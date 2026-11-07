# gonotes help

This note is built in: every vault has it, it is not a file in your folder,
and it cannot be changed. Search for `help` to find it again, or press `?`.

## Finding notes

Type in the search box; the list follows as you type. The note picked in the
list is shown underneath, ready to write in.

| Type             | Finds                                         |
|------------------|-----------------------------------------------|
| `deploy nix`     | notes with all the words, in title, path or text |
| `"exact phrase"` | the phrase                                    |
| `-draft`         | notes without the word                        |
| `#ops`           | notes tagged `ops` (or `ops/…`)               |
| `in:work/infra`  | notes in that folder; below it too with *Folders include subfolders* (Options) |
| `sort:title`     | sorted by title instead of relevance          |

Pressing `Enter` when nothing matches starts a new note titled with what you
typed: `in:folder` becomes its folder, `#tags` its tags.

## Keys

| Key | Does |
|---|---|
| `Ctrl K` (`⌘K`), `/` | search, from anywhere |
| `↑ ↓`, `j k` | pick a note in the list |
| `Enter` | open the picked note: the list folds away and you write in it; `Esc` brings the list back |
| `Shift Enter` in the box, `e` | edit the picked note, or the one on screen |
| `Delete` | delete the picked note; a message at the bottom has Undo |
| `n` | new note |
| `←` | into the folders: `↑ ↓` pick, `Enter` open, `m` move the picked note there, `n` new folder, `→` open a closed folder (else back), `←` close an open one, `Esc` back |
| `Alt ↑ ↓` | the folder above or below, the list following; `Alt → ←` opens or closes the folder in view |
| `Esc` | close, clear the search, or go back |
| `?` | this help |
| `Alt B` | fold the sidebar away, or back; ◀ at its top and ▶ at the window's edge do the same |
| `Alt Enter` | the list over the whole page, or back; drag the line under the list to make it taller or shorter (or, with the list beside the note, wider or narrower) |

## Vaults

A vault is one notes folder. With more than one, the menu next to the logo
switches between them.

| Key | Does |
|---|---|
| `Alt 1` … `Alt 9` | switch to vault 1 … 9, from anywhere |
| `Alt V` | open the vault menu, from anywhere |
| `v` | open the vault menu (when not typing) |
| `1` … `9`, `↑ ↓` `Enter` | in the menu: pick a vault |

A page that is already open stays on its vault, so a note being edited in one
tab is never saved into the vault another tab switched to.

*Vaults…* in Options (or *Edit vaults…* in the vault menu) changes them:
rename, point at another folder, reorder, add, or take one off the list (its
folder and notes stay). Each vault has a colour gradient, picked with two
sliders or a ready-made one; the window takes it on, so you can tell at a
glance which vault you are in.

## Writing

Notes are markdown. The markup shows only on the line the cursor is on;
everywhere else the note reads as rendered. *Source*, top right of the note, turns
the rendering off to see and edit the plain text; *Live* turns it back on.
The choice is kept.

- `# Heading`, `**bold**`, `*italic*`, `` `code` ``, `~~struck~~`
- `- item`, `1. item`, `- [ ] task` (click the box to tick it)
- `> quote`, `---` for a line, ```` ``` ```` for a code block
- `[text](other-note.md)` links; `Ctrl` + click follows them
- `![picture](image.png)` shows an image next to the note; drop an image (or
  paste a screenshot) into the note to store it in `media/` beside the note
  and link it
- `#tag` anywhere in the text tags the note

Changes save by themselves a moment after you stop typing. In the editor,
`Ctrl S` saves and opens the note, `Esc` closes it, `Tab` indents, and `Enter`
continues a list.

## Folders

`+` next to *Folders* makes a folder (`a/b` makes both). Drag a note, or a
whole folder, onto another folder to move it there, or onto *All notes* for the
top level. Deleted notes go to `.trash/` in the notes folder.

## Options

In Vim mode the line under the note shows the mode: `i` starts typing, `Esc`
stops, `Esc` again closes the note; `:w` saves and `:q` closes, too.

*Options*, bottom left, has the theme, *List* (above the note, or beside it
on the left), Vim mode, the folder *new notes go to* when none is picked, and
*Folders include
subfolders*: whether a folder's number and picking it take in the notes of its
subfolders too.
