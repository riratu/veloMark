// gonotes serves a folder of markdown files: search as you type, read them
// rendered, edit them in place. The folder stays the only source of truth, so
// any other editor, git or sync tool keeps working beside it.
package main

import (
	"bytes"
	"embed"
	"encoding/json"
	"errors"
	"flag"
	"fmt"
	"hash/fnv"
	"html/template"
	"io"
	"io/fs"
	"log"
	"net"
	"net/http"
	"net/url"
	"os"
	"path"
	"path/filepath"
	"strconv"
	"strings"
	"time"
	"unicode"

	"github.com/yuin/goldmark"
	"github.com/yuin/goldmark/extension"
	"github.com/yuin/goldmark/parser"
)

//go:embed web
var webFS embed.FS

var version = "dev"

func main() {
	var dirs folderList
	flag.Var(&dirs, "dir", "folder of markdown notes, as `[name=]path`; repeat it for several vaults to switch between (env NOTES_DIR, separated by "+string(os.PathListSeparator)+")")
	addr := flag.String("addr", envOr("NOTES_ADDR", "127.0.0.1:8090"), "listen address (env NOTES_ADDR)")
	config := flag.String("config", envOr("NOTES_CONFIG", defaultConfig()), "file the vaults are kept in, edited on the Vaults page (env NOTES_CONFIG)")
	flag.Parse()
	// There is no folder by default: without -dir or NOTES_DIR the first
	// page asks for one.
	given := len(dirs) > 0 || os.Getenv("NOTES_DIR") != ""
	if len(dirs) == 0 {
		for _, d := range filepath.SplitList(os.Getenv("NOTES_DIR")) {
			dirs.Set(d)
		}
	}

	// The config file, once there, is what counts: -dir only starts it.
	start := time.Now()
	confs, err := loadConfig(*config)
	fresh := errors.Is(err, fs.ErrNotExist)
	switch {
	case fresh:
		confs = parseDirs(dirs)
	case err != nil:
		log.Fatal(err)
	case given:
		log.Printf("vaults from %s; -dir and NOTES_DIR only start that file", *config)
	}
	app, err := NewApp(confs, *config)
	if err != nil {
		log.Fatal(err)
	}
	if fresh && len(app.all()) > 0 {
		if err := app.save(); err != nil {
			log.Printf("vaults are not kept: %v", err)
		}
	}
	for _, v := range app.all() {
		if v.Missing() {
			log.Printf("%s: %s is not there", v.Name, v.Dir)
			continue
		}
		log.Printf("%s: %d notes in %s", v.Name, v.ix.Len(), v.dir)
	}
	if len(app.all()) == 0 {
		log.Printf("no vault yet: the page asks for a folder")
	} else {
		log.Printf("indexed in %s", time.Since(start).Round(time.Millisecond))
	}
	log.Printf("listening on http://%s", *addr)
	log.Fatal(http.ListenAndServe(*addr, app.routes()))
}

func envOr(k, def string) string {
	if v := os.Getenv(k); v != "" {
		return v
	}
	return def
}

// folderList collects repeated -dir flags.
type folderList []string

func (f *folderList) String() string { return strings.Join(*f, ",") }
func (f *folderList) Set(s string) error {
	if s = strings.TrimSpace(s); s != "" {
		*f = append(*f, s)
	}
	return nil
}

func (a *App) routes() http.Handler {
	static, _ := fs.Sub(webFS, "web/static")
	mux := http.NewServeMux()
	mux.Handle("GET /static/", http.StripPrefix("/static/", http.FileServerFS(static)))
	// The service worker, for installing gonotes as an app, has to come from
	// the top to look after every page.
	mux.HandleFunc("GET /sw.js", func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Cache-Control", "no-cache")
		http.ServeFileFS(w, r, static, "sw.js")
	})
	mux.HandleFunc("GET /vault/{name}", a.switchVault)
	mux.HandleFunc("GET /vaults", a.in((*Vault).vaultsPage))
	mux.HandleFunc("GET /browse", a.browse)
	mux.HandleFunc("POST /pickdir", a.pickDir)
	mux.HandleFunc("POST /openlink", openLink)
	mux.HandleFunc("GET /welcome", a.welcome)
	mux.HandleFunc("POST /welcome", a.firstVault)
	mux.HandleFunc("POST /vaults", a.in((*Vault).saveVaults))
	mux.HandleFunc("GET /{$}", a.in((*Vault).list))
	mux.HandleFunc("GET /n/{path...}", a.in((*Vault).view))
	mux.HandleFunc("GET /edit/{path...}", a.in((*Vault).edit))
	mux.HandleFunc("POST /new", a.in((*Vault).create))
	mux.HandleFunc("POST /save", a.in((*Vault).save))
	mux.HandleFunc("POST /delete", a.in((*Vault).delete))
	mux.HandleFunc("POST /discard", a.in((*Vault).discard))
	mux.HandleFunc("POST /move", a.in((*Vault).move))
	mux.HandleFunc("POST /movevault", a.in(a.moveToVault))
	mux.HandleFunc("POST /mkdir", a.in((*Vault).mkdir))
	mux.HandleFunc("POST /upload", a.in((*Vault).upload))
	mux.HandleFunc("POST /reveal", a.in((*Vault).revealPath))
	mux.HandleFunc("POST /movedir", a.in((*Vault).moveDir))
	mux.HandleFunc("POST /renamedir", a.in((*Vault).renameDir))
	mux.HandleFunc("POST /exclude", a.in((*Vault).excludeDir))
	mux.HandleFunc("POST /newdir", a.in((*Vault).setNewDir))
	mux.HandleFunc("POST /restore", a.in((*Vault).restore))

	// It writes files, so another site in the same browser must not be able
	// to post to it, and a DNS name pointed at 127.0.0.1 must not reach it.
	return localOnly(http.NewCrossOriginProtection().Handler(mux))
}

// helpPath is where the built-in help note shows in every vault.
const helpPath = "gonotes-help.md"

// builtin refuses to change the help note, which is no file to change. A
// real note of its name is not refused.
func (v *Vault) builtin(w http.ResponseWriter, rel string) bool {
	if n := v.ix.Get(rel); n == nil || !n.Builtin {
		return false
	}
	http.Error(w, "the help note is built in and cannot be changed", http.StatusForbidden)
	return true
}

func localOnly(h http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		host, _, err := net.SplitHostPort(r.Host)
		if err != nil {
			host = r.Host
		}
		if host != "localhost" && net.ParseIP(host) == nil {
			http.Error(w, "unknown host", http.StatusMisdirectedRequest)
			return
		}
		h.ServeHTTP(w, r)
	})
}

// resolve turns a note path from a URL or a form into a file path inside the
// notes folder, or refuses it.
func (v *Vault) resolve(rel string) (string, string, error) {
	rel = strings.TrimSpace(strings.ReplaceAll(rel, "\\", "/"))
	clean := path.Clean("/" + rel)[1:]
	if clean == "" {
		return "", "", errors.New("empty path")
	}
	for _, part := range strings.Split(clean, "/") {
		if strings.HasPrefix(part, ".") {
			return "", "", errors.New("path parts may not start with a dot")
		}
	}
	return clean, filepath.Join(v.dir, filepath.FromSlash(clean)), nil
}

// ---- pages ----

type page struct {
	Title   string
	Q       Query
	Dirs    []Count
	Tags    []Count
	Total   int
	Top     int // notes in the vault's own folder, none in a folder of it
	Version string
	Vault   *Vault
	Vaults  []*Vault
	Sub     bool // folders take in their subfolders

	Hits []Hit

	Note *Note

	Edit     *editForm
	Settings *vaultsForm
	IsList   bool
	// Elsewhere: when nothing matches, how many notes would in the folders
	// left out of searches, each with the search that shows them.
	Elsewhere []elsewhere
	Open      bool  // the note in Peek is open in place, the list folded away
	Peek      *Note // the note under the results, to edit in place
}

type editForm struct {
	Path, Orig, Body, Error string
	Mod                     int64
	New, Conflict           bool
	FocusPath               bool // a new note still needs its name
}

func (v *Vault) base(r *http.Request, title string) *page {
	v.ix.Fresh()
	sub := subfolders(r)
	dirs, _ := v.ix.Facets(sub)
	q := ParseQuery(r.URL.Query().Get("q"))
	q.Sub = sub
	for _, e := range v.Excluded() {
		q.Exclude = append(q.Exclude, strings.ToLower(e))
	}
	tags := v.ix.TagCounts(q)
	return &page{
		Title:   title,
		Q:       q,
		Sub:     sub,
		Dirs:    dirs,
		Tags:    tags,
		Total:   v.ix.Len(),
		Top:     v.ix.TopLevel(),
		Version: version,
		Vault:   v,
		Vaults:  v.app.all(),
	}
}

type elsewhere struct {
	Dir string
	N   int
	Q   string
}

// elsewhere counts what q finds in the folders left out of searches, by the
// folder each note is in, so a search that finds nothing can say where it
// would, and link to there.
func (v *Vault) elsewhere(q Query) []elsewhere {
	q.Exclude = nil
	hits, _ := v.ix.Search(q)
	counts := map[string]int{}
	var order []string
	for _, h := range hits {
		if d := h.Dir(); v.IsExcluded(d) {
			if counts[d] == 0 {
				order = append(order, d)
			}
			counts[d]++
		}
	}
	var out []elsewhere
	for _, d := range order {
		out = append(out, elsewhere{Dir: d, N: counts[d], Q: strings.TrimSpace(q.Raw + " " + quoteTok("in:"+d))})
	}
	return out
}

// subfolders is the setting that folders take in their subfolders, in counts
// and when picked. The page sets it, in Options.
func subfolders(r *http.Request) bool {
	c, err := r.Cookie("subfolders")
	return err == nil && c.Value == "1"
}

func (v *Vault) list(w http.ResponseWriter, r *http.Request) {
	p := v.base(r, v.Label())
	if p.Q.Raw != "" {
		p.Title = p.Q.Raw + " · " + v.Label()
	}
	p.Hits, _ = v.ix.Search(p.Q)
	if len(p.Hits) == 0 && p.Q.Raw != "" {
		p.Elsewhere = v.elsewhere(p.Q)
	}
	p.IsList = true
	if r.Header.Get("X-Partial") != "" {
		render(w, "list", "results", p)
		return
	}
	if n := v.ix.Get(r.URL.Query().Get("open")); n != nil {
		p.Peek, p.Note, p.Open = n, n, true
		p.Title = n.Title
	} else if len(p.Hits) > 0 {
		p.Peek = p.Hits[0].Note
	}
	render(w, "list", "layout", p)
}

func (v *Vault) view(w http.ResponseWriter, r *http.Request) {
	rel, file, err := v.resolve(r.PathValue("path"))
	if err != nil {
		http.Error(w, err.Error(), http.StatusBadRequest)
		return
	}
	if !isNote(rel) {
		// Images and other files a note links to, relative to the note.
		if st, err := os.Stat(file); err == nil && st.IsDir() {
			http.Redirect(w, r, "/?q="+url.QueryEscape(quoteTok("in:"+rel)), http.StatusSeeOther)
			return
		}
		http.ServeFile(w, r, file)
		return
	}
	n := v.ix.Get(rel)
	if n == nil {
		// A link to a note not written yet searches for it; Enter there
		// makes it.
		http.Redirect(w, r, "/?q="+url.QueryEscape(missingQuery(rel)), http.StatusSeeOther)
		return
	}
	if r.Header.Get("X-Partial") != "" {
		render(w, "list", "peek", n)
		return
	}
	// A note has no page of its own: it opens in place on the list.
	http.Redirect(w, r, openURL(n.Path), http.StatusSeeOther)
}

// openURL is the list with a note open in place.
func openURL(rel string) string { return "/?open=" + url.QueryEscape(rel) }

// missingQuery is the search that would make the note at rel.
func missingQuery(rel string) string {
	q := strings.TrimSuffix(path.Base(rel), path.Ext(rel))
	if d := parentDir(rel); d != "" {
		q += " " + quoteTok("in:"+d)
	}
	return q
}

func (v *Vault) edit(w http.ResponseWriter, r *http.Request) {
	rel, _, err := v.resolve(r.PathValue("path"))
	if err != nil {
		http.Error(w, err.Error(), http.StatusBadRequest)
		return
	}
	p := v.base(r, "")
	n := v.ix.Get(rel)
	if n == nil {
		http.Redirect(w, r, "/?q="+url.QueryEscape(missingQuery(rel)), http.StatusSeeOther)
		return
	}
	if n.Builtin {
		http.Redirect(w, r, openURL(n.Path), http.StatusSeeOther)
		return
	}
	p.Note = n
	p.Title = "Edit · " + n.Title
	p.Edit = &editForm{Path: n.Path, Orig: n.Path, Body: n.Body, Mod: n.Mod.UnixNano()}
	render(w, "edit", "layout", p)
}

// create makes a note at once and opens it in place: a search that found
// nothing becomes the note it was after (its words the title, in:folder its
// folder, #tags its tags), else an Untitled one in dir. A name already taken
// gets a number. Asked for JSON, it answers with where to go.
func (v *Vault) create(w http.ResponseWriter, r *http.Request) {
	r.ParseForm()
	title, dir := "", strings.Trim(r.FormValue("dir"), "/")
	var tags []string
	if from := r.FormValue("from"); strings.TrimSpace(from) != "" {
		title, dir, tags = noteFromQuery(from)
		dirs, _ := v.ix.Facets(false)
		for _, d := range dirs {
			if strings.EqualFold(d.Name, dir) {
				dir = d.Name // in:work finds the folder called Work
			}
		}
	}
	if dir == "" {
		dir = v.NewDir() // nothing says where: the folder Options picked
	}
	if title == "" {
		title = "Untitled"
	}
	// The file name is the title, so the text starts empty, or with the tags.
	body := ""
	if len(tags) > 0 {
		body = "#" + strings.Join(tags, " #") + "\n\n"
	}
	var rel string
	for i := 1; ; i++ {
		name := fileName(title)
		if i > 1 {
			name += " " + strconv.Itoa(i)
		}
		if dir != "" {
			name = dir + "/" + name
		}
		var file string
		var err error
		if rel, file, err = v.resolve(name + ".md"); err != nil {
			http.Error(w, err.Error(), http.StatusBadRequest)
			return
		}
		os.MkdirAll(filepath.Dir(file), 0o755)
		f, err := os.OpenFile(file, os.O_WRONLY|os.O_CREATE|os.O_EXCL, 0o644)
		if errors.Is(err, fs.ErrExist) {
			continue
		}
		if err == nil {
			_, err = f.WriteString(body)
			if cerr := f.Close(); err == nil {
				err = cerr
			}
		}
		if err != nil {
			http.Error(w, err.Error(), http.StatusInternalServerError)
			return
		}
		break
	}
	v.ix.Refresh()
	if strings.Contains(r.Header.Get("Accept"), "application/json") {
		w.Header().Set("Content-Type", "application/json")
		json.NewEncoder(w).Encode(map[string]string{"path": rel, "url": openURL(rel)})
		return
	}
	http.Redirect(w, r, openURL(rel), http.StatusSeeOther)
}

func (v *Vault) save(w http.ResponseWriter, r *http.Request) {
	r.ParseForm()
	f := &editForm{
		Path: strings.TrimSpace(r.FormValue("path")),
		Orig: r.FormValue("orig"),
		Body: strings.ReplaceAll(r.FormValue("body"), "\r\n", "\n"),
		New:  r.FormValue("orig") == "",
	}
	f.Mod, _ = strconv.ParseInt(r.FormValue("mod"), 10, 64)
	force := r.FormValue("force") != ""
	// The editor saves as you type and wants only the outcome back.
	quiet := strings.Contains(r.Header.Get("Accept"), "application/json")

	if f.Path != "" && !isNote(f.Path) {
		f.Path += ".md"
	}
	again := func(msg string, conflict bool) {
		if quiet {
			http.Error(w, msg, http.StatusConflict)
			return
		}
		p := v.base(r, "Edit")
		f.Error, f.Conflict = msg, conflict
		p.Edit = f
		w.WriteHeader(http.StatusConflict)
		render(w, "edit", "layout", p)
	}

	rel, file, err := v.resolve(f.Path)
	if err != nil {
		again("Path: "+err.Error(), false)
		return
	}
	f.Path = rel
	if v.builtin(w, f.Orig) {
		return
	}

	if f.New || rel != f.Orig {
		if _, err := os.Stat(file); err == nil {
			again(rel+" already exists. Pick another name.", false)
			return
		}
	}
	if !f.New && !force {
		_, origFile, err := v.resolve(f.Orig)
		if err != nil {
			again(err.Error(), false)
			return
		}
		st, err := os.Stat(origFile)
		if err != nil {
			again(f.Orig+" is gone: it was moved or deleted while you edited. Saving writes it again.", true)
			return
		}
		if st.ModTime().UnixNano() != f.Mod {
			again(f.Orig+" changed on disk while you edited it. Saving overwrites that change.", true)
			return
		}
	}

	if err := writeAtomic(file, []byte(f.Body)); err != nil {
		again("Could not write: "+err.Error(), false)
		return
	}
	if !f.New && rel != f.Orig {
		if _, origFile, err := v.resolve(f.Orig); err == nil {
			os.Remove(origFile)
		}
	}
	v.ix.Refresh()
	if quiet {
		var mod int64
		if st, err := os.Stat(file); err == nil {
			mod = st.ModTime().UnixNano()
		}
		w.Header().Set("Content-Type", "application/json")
		json.NewEncoder(w).Encode(map[string]any{"path": rel, "mod": strconv.FormatInt(mod, 10)})
		return
	}
	v.remember(w) // the page after it goes by the cookie
	http.Redirect(w, r, openURL(rel), http.StatusSeeOther)
}

// delete moves the note into .trash rather than removing it, since a click or
// a key is all it takes. A folder goes with its notes; one with any
// other file in it, which the page never shows, is refused. Asked for JSON, it says where the note
// went, so the page can offer to put it back.
func (v *Vault) delete(w http.ResponseWriter, r *http.Request) {
	rel, file, err := v.resolve(r.FormValue("path"))
	if err != nil {
		http.Error(w, err.Error(), http.StatusBadRequest)
		return
	}
	if v.builtin(w, rel) {
		return
	}
	info, err := os.Stat(file)
	if err != nil {
		http.Error(w, rel+" is gone", http.StatusNotFound)
		return
	}
	if info.IsDir() {
		if other := firstOtherFile(file); other != "" {
			http.Error(w, rel+" holds "+other+", which is no note; delete only folders of notes", http.StatusConflict)
			return
		}
	}
	trash := ".trash/" + rel + "." + time.Now().Format("20060102-150405.000")
	dst := filepath.Join(v.dir, filepath.FromSlash(trash))
	if err := os.MkdirAll(filepath.Dir(dst), 0o755); err == nil {
		err = os.Rename(file, dst)
	}
	if err != nil {
		http.Error(w, err.Error(), http.StatusInternalServerError)
		return
	}
	v.ix.Refresh()
	if strings.Contains(r.Header.Get("Accept"), "application/json") {
		w.Header().Set("Content-Type", "application/json")
		json.NewEncoder(w).Encode(map[string]string{"path": rel, "trash": trash})
		return
	}
	v.remember(w)
	dir := path.Dir(rel)
	if dir == "." {
		http.Redirect(w, r, "/", http.StatusSeeOther)
		return
	}
	http.Redirect(w, r, "/?q="+url.QueryEscape(quoteTok("in:"+dir)), http.StatusSeeOther)
}

// firstOtherFile finds a file in the folder, or in a folder in it, that is
// not a note: the page never shows such a file, so deleting the folder would
// take it away unseen. "" when the folder holds notes only, or nothing.
func firstOtherFile(dir string) string {
	var found string
	filepath.WalkDir(dir, func(p string, d fs.DirEntry, err error) error {
		if err != nil || d.IsDir() || isNote(p) {
			return nil
		}
		found, _ = filepath.Rel(dir, p)
		return fs.SkipAll
	})
	return filepath.ToSlash(found)
}

// discard removes a note that is empty, for a new note left without a word
// in it; a note with anything in it stays. Nothing goes to .trash, as there
// is nothing to get back.
func (v *Vault) discard(w http.ResponseWriter, r *http.Request) {
	rel, file, err := v.resolve(r.FormValue("path"))
	if err != nil || !isNote(rel) {
		http.Error(w, "not a note", http.StatusBadRequest)
		return
	}
	if v.builtin(w, rel) {
		return
	}
	b, err := os.ReadFile(file)
	if err != nil {
		http.Error(w, rel+" is gone", http.StatusNotFound)
		return
	}
	if strings.TrimSpace(string(b)) != "" {
		http.Error(w, rel+" is not empty", http.StatusConflict)
		return
	}
	os.Remove(file)
	v.ix.Refresh()
	w.WriteHeader(http.StatusNoContent)
}

// move puts a note into another folder under the same file name; dir "" is
// the top level. It answers with the note's new path, for dragging and undo.
func (v *Vault) move(w http.ResponseWriter, r *http.Request) {
	rel, file, err := v.resolve(r.FormValue("path"))
	if err != nil || !isNote(rel) {
		http.Error(w, "not a note", http.StatusBadRequest)
		return
	}
	if v.builtin(w, rel) {
		return
	}
	dst := path.Base(rel)
	if dir := strings.Trim(r.FormValue("dir"), "/"); dir != "" {
		dst = dir + "/" + dst
	}
	dst, dstFile, err := v.resolve(dst)
	if err != nil {
		http.Error(w, err.Error(), http.StatusBadRequest)
		return
	}
	if dst != rel {
		if _, err := os.Stat(file); err != nil {
			http.Error(w, rel+" is gone", http.StatusNotFound)
			return
		}
		if _, err := os.Stat(dstFile); err == nil {
			http.Error(w, dst+" already exists", http.StatusConflict)
			return
		}
		if err := os.MkdirAll(filepath.Dir(dstFile), 0o755); err != nil {
			http.Error(w, err.Error(), http.StatusInternalServerError)
			return
		}
		if err := os.Rename(file, dstFile); err != nil {
			http.Error(w, err.Error(), http.StatusInternalServerError)
			return
		}
		v.ix.Refresh()
	}
	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(map[string]string{"from": rel, "path": dst})
}

// upload stores a file dropped or pasted into a note in media/ under the
// note's folder, under a name of its own: an upload never overwrites. It
// answers with where it went, relative to the note, ready for its link.
func (v *Vault) upload(w http.ResponseWriter, r *http.Request) {
	r.Body = http.MaxBytesReader(w, r.Body, 100<<20)
	if err := r.ParseMultipartForm(8 << 20); err != nil {
		http.Error(w, "upload: "+err.Error(), http.StatusBadRequest)
		return
	}
	rel, _, err := v.resolve(r.FormValue("note"))
	if err != nil {
		http.Error(w, "note: "+err.Error(), http.StatusBadRequest)
		return
	}
	if v.builtin(w, rel) {
		return
	}
	src, hdr, err := r.FormFile("file")
	if err != nil {
		http.Error(w, err.Error(), http.StatusBadRequest)
		return
	}
	defer src.Close()

	name := safeName(hdr.Filename)
	ext := path.Ext(name)
	stem := strings.TrimSuffix(name, ext)
	var out *os.File
	for i := 1; out == nil; i++ {
		if i > 1 {
			name = fmt.Sprintf("%s-%d%s", stem, i, ext)
		}
		dst := "media/" + name
		if d := parentDir(rel); d != "" {
			dst = d + "/" + dst
		}
		_, file, err := v.resolve(dst)
		if err != nil {
			http.Error(w, err.Error(), http.StatusBadRequest)
			return
		}
		os.MkdirAll(filepath.Dir(file), 0o755)
		out, err = os.OpenFile(file, os.O_WRONLY|os.O_CREATE|os.O_EXCL, 0o644)
		if err != nil && !errors.Is(err, fs.ErrExist) {
			http.Error(w, err.Error(), http.StatusInternalServerError)
			return
		}
	}
	_, err = io.Copy(out, src)
	if cerr := out.Close(); err == nil {
		err = cerr
	}
	if err != nil {
		os.Remove(out.Name())
		http.Error(w, err.Error(), http.StatusInternalServerError)
		return
	}
	v.ix.Refresh() // media/ may be a new folder
	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(map[string]string{"name": "media/" + name})
}

// safeName keeps a file name to letters, digits and . - _, so its link needs
// no escaping; spaces and the rest become dashes.
func safeName(s string) string {
	s = path.Base(strings.ReplaceAll(s, "\\", "/"))
	var b strings.Builder
	dash := false
	for _, r := range s {
		ok := unicode.IsLetter(r) || unicode.IsDigit(r) || r == '.' || r == '_' || r == '-'
		if !ok {
			if !dash && b.Len() > 0 {
				b.WriteByte('-')
			}
			dash = true
			continue
		}
		b.WriteRune(r)
		dash = false
	}
	name := strings.Trim(b.String(), ".-")
	ext := path.Ext(name)
	stem := strings.Trim(strings.TrimSuffix(name, ext), ".-")
	if stem == "" {
		stem = "file"
	}
	return stem + ext
}

// mkdir makes a folder, empty until a note goes into it.
func (v *Vault) mkdir(w http.ResponseWriter, r *http.Request) {
	rel, file, err := v.resolve(strings.Trim(r.FormValue("dir"), "/ "))
	if err != nil {
		http.Error(w, err.Error(), http.StatusBadRequest)
		return
	}
	if _, err := os.Stat(file); err == nil {
		http.Error(w, rel+" already exists", http.StatusConflict)
		return
	}
	if err := os.MkdirAll(file, 0o755); err != nil {
		http.Error(w, err.Error(), http.StatusInternalServerError)
		return
	}
	v.ix.Refresh()
	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(map[string]string{"dir": rel})
}

// moveDir puts a folder, with everything in it, into another folder; dir ""
// is the top level. Like move, it answers with the new path.
func (v *Vault) moveDir(w http.ResponseWriter, r *http.Request) {
	rel, file, err := v.resolve(r.FormValue("path"))
	if err != nil {
		http.Error(w, err.Error(), http.StatusBadRequest)
		return
	}
	if st, err := os.Stat(file); err != nil || !st.IsDir() {
		http.Error(w, rel+" is not a folder", http.StatusNotFound)
		return
	}
	dst := path.Base(rel)
	if dir := strings.Trim(r.FormValue("dir"), "/"); dir != "" {
		if dir == rel || strings.HasPrefix(dir, rel+"/") {
			http.Error(w, "a folder cannot go into itself", http.StatusBadRequest)
			return
		}
		dst = dir + "/" + dst
	}
	dst, dstFile, err := v.resolve(dst)
	if err != nil {
		http.Error(w, err.Error(), http.StatusBadRequest)
		return
	}
	if dst != rel {
		if _, err := os.Stat(dstFile); err == nil {
			http.Error(w, dst+" already exists", http.StatusConflict)
			return
		}
		if err := os.MkdirAll(filepath.Dir(dstFile), 0o755); err != nil {
			http.Error(w, err.Error(), http.StatusInternalServerError)
			return
		}
		if err := os.Rename(file, dstFile); err != nil {
			http.Error(w, err.Error(), http.StatusInternalServerError)
			return
		}
		v.followMove(rel, dst)
		v.ix.Refresh()
	}
	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(map[string]string{"from": rel, "path": dst})
}

// renameDir gives a folder another name where it is. Like moveDir, it
// answers with the old path and the new.
func (v *Vault) renameDir(w http.ResponseWriter, r *http.Request) {
	rel, file, err := v.resolve(r.FormValue("path"))
	if err != nil {
		http.Error(w, err.Error(), http.StatusBadRequest)
		return
	}
	if st, err := os.Stat(file); err != nil || !st.IsDir() {
		http.Error(w, rel+" is not a folder", http.StatusNotFound)
		return
	}
	name := strings.TrimSpace(r.FormValue("name"))
	if name == "" || strings.ContainsAny(name, "/\\") {
		http.Error(w, "a folder name cannot be empty or have a slash in it", http.StatusBadRequest)
		return
	}
	dst := name
	if d := parentDir(rel); d != "" {
		dst = d + "/" + name
	}
	dst, dstFile, err := v.resolve(dst)
	if err != nil {
		http.Error(w, err.Error(), http.StatusBadRequest)
		return
	}
	if dst != rel {
		// A change of case only is a rename all the same, on any disk.
		if _, err := os.Stat(dstFile); err == nil && !strings.EqualFold(dst, rel) {
			http.Error(w, dst+" already exists", http.StatusConflict)
			return
		}
		if err := os.Rename(file, dstFile); err != nil {
			http.Error(w, err.Error(), http.StatusInternalServerError)
			return
		}
		v.followMove(rel, dst)
		v.ix.Refresh()
	}
	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(map[string]string{"from": rel, "path": dst})
}

// restore takes a note back out of .trash, for the undo after a delete.
func (v *Vault) restore(w http.ResponseWriter, r *http.Request) {
	trash := path.Clean("/" + r.FormValue("trash"))[1:]
	parts := strings.Split(trash, "/")
	if len(parts) < 2 || parts[0] != ".trash" {
		http.Error(w, "not in the trash", http.StatusBadRequest)
		return
	}
	for _, p := range parts[1:] {
		if strings.HasPrefix(p, ".") {
			http.Error(w, "not in the trash", http.StatusBadRequest)
			return
		}
	}
	rel, file, err := v.resolve(r.FormValue("path"))
	if err != nil {
		http.Error(w, err.Error(), http.StatusBadRequest)
		return
	}
	if _, err := os.Stat(file); err == nil {
		http.Error(w, rel+" exists again", http.StatusConflict)
		return
	}
	if err := os.MkdirAll(filepath.Dir(file), 0o755); err == nil {
		err = os.Rename(filepath.Join(v.dir, filepath.FromSlash(trash)), file)
	}
	if err != nil {
		http.Error(w, err.Error(), http.StatusInternalServerError)
		return
	}
	v.ix.Refresh()
	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(map[string]string{"path": rel})
}

func writeAtomic(file string, data []byte) error {
	if err := os.MkdirAll(filepath.Dir(file), 0o755); err != nil {
		return err
	}
	mode := os.FileMode(0o644)
	if st, err := os.Stat(file); err == nil {
		mode = st.Mode().Perm()
	}
	tmp, err := os.CreateTemp(filepath.Dir(file), ".gonotes-*")
	if err != nil {
		return err
	}
	defer os.Remove(tmp.Name())
	if _, err := tmp.Write(data); err != nil {
		tmp.Close()
		return err
	}
	if err := tmp.Sync(); err != nil {
		tmp.Close()
		return err
	}
	if err := tmp.Close(); err != nil {
		return err
	}
	os.Chmod(tmp.Name(), mode)
	return os.Rename(tmp.Name(), file)
}

// ---- rendering ----

var md = goldmark.New(
	goldmark.WithExtensions(extension.GFM, extension.Footnote, extension.DefinitionList),
	goldmark.WithParserOptions(parser.WithAutoHeadingID()),
)

func renderMarkdown(src string) template.HTML {
	var b bytes.Buffer
	if err := md.Convert([]byte(src), &b); err != nil {
		return template.HTML(template.HTMLEscapeString(src))
	}
	return template.HTML(b.String())
}

var funcs = template.FuncMap{
	"ago": ago,
	"hue": hue,
	"inc": func(i int) int { return i + 1 },
	// row hands a gradient picker its row and the key its fields are named by.
	"row": func(key string, r vaultRow) map[string]any { return map[string]any{"Key": key, "Row": r} },
	"presets": func() [][2]int {
		return [][2]int{{258, 300}, {200, 250}, {160, 210}, {120, 170}, {60, 20}, {20, 340}, {330, 280}, {290, 220}, {40, 90}, {0, 60}}
	},
	"esc":    escapePath,
	"base":   path.Base,
	"dir":    parentDir,
	"depth":  func(d string) int { return strings.Count(d, "/") },
	"toggle": func(q Query, tok string) string { return q.Toggle(tok) },
	"pick":   func(q Query, tok string) string { return q.Pick(tok) },
	"newTitle": func(raw string) string {
		t, _, _ := noteFromQuery(raw)
		return t
	},
	"has": func(q Query, tok string) bool { return q.Has(tok) },
	"datetime": func(t time.Time) string {
		if t.IsZero() {
			return "built into gonotes"
		}
		return t.Format("Mon 2 Jan 2006, 15:04")
	},
	"md": func(n *Note) template.HTML { return renderMarkdown(n.BodyWithoutFrontMatter()) },
}

var pages = map[string]*template.Template{}

func init() {
	for _, name := range []string{"list", "edit", "vaults", "missing"} {
		pages[name] = template.Must(template.New("").Funcs(funcs).ParseFS(webFS, "web/layout.html", "web/peek.html", "web/"+name+".html"))
	}
	// The first start has no vault, so no sidebar: a page of its own, with
	// the folder field of the Vaults page.
	pages["welcome"] = template.Must(template.New("").Funcs(funcs).ParseFS(webFS, "web/welcome.html", "web/vaults.html"))
}

// render executes one template of a page's set: "layout" for the whole page,
// or a fragment such as "results" or "peek" for the live search to swap in.
func render(w http.ResponseWriter, name, tmpl string, data any) {
	var b bytes.Buffer
	if err := pages[name].ExecuteTemplate(&b, tmpl, data); err != nil {
		log.Printf("render %s: %v", name, err)
		http.Error(w, err.Error(), http.StatusInternalServerError)
		return
	}
	w.Header().Set("Content-Type", "text/html; charset=utf-8")
	w.Write(b.Bytes())
}

func escapePath(p string) string {
	parts := strings.Split(p, "/")
	for i, s := range parts {
		parts[i] = url.PathEscape(s)
	}
	return strings.Join(parts, "/")
}

// hue gives every folder and tag a stable colour of its own.
func hue(s string) int {
	h := fnv.New32a()
	h.Write([]byte(s))
	return int(h.Sum32() % 360)
}

func ago(t time.Time) string {
	if t.IsZero() {
		return "built in"
	}
	d := time.Since(t)
	switch {
	case d < time.Minute:
		return "just now"
	case d < time.Hour:
		return fmt.Sprintf("%dm ago", int(d.Minutes()))
	case d < 24*time.Hour:
		return fmt.Sprintf("%dh ago", int(d.Hours()))
	case d < 7*24*time.Hour:
		return fmt.Sprintf("%dd ago", int(d.Hours()/24))
	case t.Year() == time.Now().Year():
		return t.Format("2 Jan")
	}
	return t.Format("2 Jan 2006")
}
