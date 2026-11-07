package main

import (
	"bufio"
	"io/fs"
	"os"
	"path"
	"path/filepath"
	"regexp"
	"sort"
	"strings"
	"sync"
	"time"
)

// Note is one markdown file under the notes directory. The file is the
// source of truth; this is only what the index remembers about it.
type Note struct {
	Path  string // slash-separated, relative to the notes dir: "work/todo.md"
	Title string
	Tags  []string
	Mod   time.Time
	Size  int64
	// Builtin is the help note: in every vault, in no folder on disk, and
	// not to be changed.
	Builtin bool
	Body    string // the whole file, front matter included

	lower      string // title, path and body, lowercased, for matching
	lowerTitle string
	lowerPath  string
}

// Dir is the folder a note lives in, "" at the top level.
func (n *Note) Dir() string {
	d := path.Dir(n.Path)
	if d == "." {
		return ""
	}
	return d
}

// Index keeps every note in memory. A personal notes folder is small enough
// that a substring scan over all of it is faster than keeping an inverted
// index in step with files that other editors change underneath us.
type Index struct {
	dir string

	mu      sync.RWMutex
	notes   map[string]*Note
	dirs    []string // every folder, the empty ones too
	extra   *Note    // the built-in help, unless a file of its name hides it
	scanned time.Time
}

func NewIndex(dir string) *Index {
	return &Index{dir: dir, notes: map[string]*Note{}}
}

// rescanAfter is how old a scan may get before a request walks the folder
// again. gonotes' own changes rescan at once; this is for other editors and
// sync, without a file watcher.
const rescanAfter = 5 * time.Second

// Fresh rescans when the last scan is older than rescanAfter, so edits made
// with another editor show up within a few seconds.
func (ix *Index) Fresh() {
	ix.mu.RLock()
	stale := time.Since(ix.scanned) > rescanAfter
	ix.mu.RUnlock()
	if stale {
		ix.Refresh()
	}
}

// Refresh walks the folder and rereads only the files whose size or
// modification time changed.
func (ix *Index) Refresh() error {
	seen := map[string]bool{}
	var dirs []string
	type change struct {
		rel  string
		info fs.FileInfo
	}
	var changed []change

	// The folder may be a link, and may only now be there (a drive plugged
	// in): the walk does not follow links, so it starts where it points.
	root := ix.dir
	if real, err := filepath.EvalSymlinks(root); err == nil {
		root = real
	}
	ix.mu.RLock()
	err := filepath.WalkDir(root, func(p string, d fs.DirEntry, err error) error {
		if err != nil {
			return nil
		}
		name := d.Name()
		if p != root && strings.HasPrefix(name, ".") {
			if d.IsDir() {
				return filepath.SkipDir
			}
			return nil
		}
		if d.IsDir() && p != root {
			rel, _ := filepath.Rel(root, p)
			dirs = append(dirs, filepath.ToSlash(rel))
		}
		if d.IsDir() || !isNote(name) {
			return nil
		}
		rel, _ := filepath.Rel(root, p)
		rel = filepath.ToSlash(rel)
		seen[rel] = true
		info, err := d.Info()
		if err != nil {
			return nil
		}
		if old, ok := ix.notes[rel]; ok && old.Mod.Equal(info.ModTime()) && old.Size == info.Size() {
			return nil
		}
		changed = append(changed, change{rel, info})
		return nil
	})
	ix.mu.RUnlock()
	if err != nil {
		return err
	}

	parsed := make([]*Note, 0, len(changed))
	for _, c := range changed {
		b, err := os.ReadFile(filepath.Join(root, filepath.FromSlash(c.rel)))
		if err != nil {
			continue
		}
		parsed = append(parsed, parseNote(c.rel, string(b), c.info.ModTime(), c.info.Size()))
	}

	ix.mu.Lock()
	defer ix.mu.Unlock()
	for rel := range ix.notes {
		if !seen[rel] {
			delete(ix.notes, rel)
		}
	}
	for _, n := range parsed {
		ix.notes[n.Path] = n
	}
	if ix.extra != nil && !seen[ix.extra.Path] {
		ix.notes[ix.extra.Path] = ix.extra
	}
	ix.dirs = dirs
	ix.scanned = time.Now()
	return nil
}

func (ix *Index) Get(rel string) *Note {
	ix.mu.RLock()
	defer ix.mu.RUnlock()
	return ix.notes[rel]
}

// Count is a folder or a tag with the number of notes in it: a folder's own,
// or with its subfolders' when Facets is asked to count them.
type Count struct {
	Name string
	N    int
}

// Facets lists every folder (counting notes in subfolders too) and every tag.
func (ix *Index) Facets(sub bool) (dirs, tags []Count) {
	ix.mu.RLock()
	defer ix.mu.RUnlock()
	dc, tc := map[string]int{}, map[string]int{}
	for _, d := range ix.dirs {
		dc[d] = 0
	}
	for _, n := range ix.notes {
		// A folder counts the notes in it, and with sub those of its
		// subfolders; the folders above are listed either way.
		if d := n.Dir(); d != "" {
			dc[d]++
			for p := parentDir(d); p != ""; p = parentDir(p) {
				if sub {
					dc[p]++
				} else {
					dc[p] += 0
				}
			}
		}
		for _, t := range n.Tags {
			tc[t]++
		}
	}
	for k, v := range dc {
		dirs = append(dirs, Count{k, v})
	}
	for k, v := range tc {
		tags = append(tags, Count{k, v})
	}
	sort.Slice(dirs, func(i, j int) bool { return dirs[i].Name < dirs[j].Name })
	sort.Slice(tags, func(i, j int) bool {
		if tags[i].N != tags[j].N {
			return tags[i].N > tags[j].N
		}
		return tags[i].Name < tags[j].Name
	})
	return dirs, tags
}

func (ix *Index) Len() int {
	ix.mu.RLock()
	defer ix.mu.RUnlock()
	return len(ix.notes)
}

// isNote says whether a file is a note: markdown, or plain text as Nextcloud
// Notes writes it, read as markdown all the same.
func isNote(name string) bool {
	ext := strings.ToLower(path.Ext(name))
	return ext == ".md" || ext == ".txt"
}

func parentDir(d string) string {
	p := path.Dir(d)
	if p == "." || p == "/" {
		return ""
	}
	return p
}

var (
	tagRe = regexp.MustCompile(`(?:^|[\s(])#([\p{L}\p{N}][\p{L}\p{N}_/-]*)`)
	// Where a # is not a tag: a link's target, like [text](#org0ba4682) in
	// notes from org-mode, and `inline code`.
	notTagRe = regexp.MustCompile("\\]\\([^)]*\\)|`[^`]*`")
	letterRe = regexp.MustCompile(`\p{L}`)
)

func parseNote(rel, body string, mod time.Time, size int64) *Note {
	n := &Note{Path: rel, Body: body, Mod: mod, Size: size}
	fm, rest := splitFrontMatter(body)

	tags := map[string]bool{}
	if fm != nil {
		n.Title = fm["title"]
		for _, t := range splitList(fm["tags"]) {
			tags[strings.ToLower(t)] = true
		}
	}

	inFence := false
	sc := bufio.NewScanner(strings.NewReader(rest))
	sc.Buffer(make([]byte, 64*1024), 4*1024*1024)
	for sc.Scan() {
		line := sc.Text()
		trim := strings.TrimSpace(line)
		if strings.HasPrefix(trim, "```") || strings.HasPrefix(trim, "~~~") {
			inFence = !inFence
			continue
		}
		if inFence {
			continue
		}
		for _, m := range tagRe.FindAllStringSubmatch(notTagRe.ReplaceAllString(line, " "), -1) {
			// #1 and #3 are numbers, not tags.
			if letterRe.MatchString(m[1]) {
				tags[strings.ToLower(strings.TrimRight(m[1], "/-"))] = true
			}
		}
	}
	// The title is the file's name, unless front matter gives one: a
	// heading in the text names a section, never the note.
	if n.Title == "" {
		n.Title = strings.TrimSuffix(path.Base(rel), path.Ext(rel))
	}
	for t := range tags {
		n.Tags = append(n.Tags, t)
	}
	sort.Strings(n.Tags)

	n.lowerTitle = strings.ToLower(n.Title)
	n.lowerPath = strings.ToLower(rel)
	n.lower = n.lowerTitle + "\n" + n.lowerPath + "\n" + strings.ToLower(body)
	return n
}

// splitFrontMatter understands the flat "key: value" YAML that notes tools
// write. Anything fancier is left in the map as raw text, which is enough to
// find a title and tags.
func splitFrontMatter(body string) (map[string]string, string) {
	if !strings.HasPrefix(body, "---\n") && !strings.HasPrefix(body, "---\r\n") {
		return nil, body
	}
	lines := strings.SplitAfter(body, "\n")
	fm := map[string]string{}
	key := ""
	for i := 1; i < len(lines); i++ {
		l := strings.TrimRight(lines[i], "\r\n")
		if l == "---" || l == "..." {
			return fm, strings.Join(lines[i+1:], "")
		}
		if strings.HasPrefix(strings.TrimSpace(l), "- ") && key != "" {
			fm[key] += "," + strings.TrimSpace(strings.TrimSpace(l)[2:])
			continue
		}
		if k, v, ok := strings.Cut(l, ":"); ok {
			key = strings.ToLower(strings.TrimSpace(k))
			fm[key] = strings.Trim(strings.TrimSpace(v), `"'`)
		}
	}
	return nil, body
}

// BodyWithoutFrontMatter is what gets rendered.
func (n *Note) BodyWithoutFrontMatter() string {
	_, rest := splitFrontMatter(n.Body)
	return rest
}

func splitList(s string) []string {
	s = strings.Trim(strings.TrimSpace(s), "[]")
	var out []string
	for _, f := range strings.FieldsFunc(s, func(r rune) bool { return r == ',' || r == ' ' }) {
		f = strings.Trim(strings.TrimSpace(f), `"'#`)
		if f != "" {
			out = append(out, f)
		}
	}
	return out
}
