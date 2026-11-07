package main

import (
	"encoding/json"
	"errors"
	"fmt"
	"io/fs"
	"net/http"
	"net/url"
	"os"
	"path/filepath"
	"sort"
	"strconv"
	"strings"
	"sync"
	"sync/atomic"
	"time"
)

// App serves one or more vaults. They come from a config file the Vaults
// page edits, so they can change while it runs.
type App struct {
	file string // where the vaults are kept; "" keeps them in memory only
	help *Note

	mu     sync.RWMutex
	vaults []*Vault
}

// Vault is one folder of notes, with its own index and colours; the first is
// the default.
type Vault struct {
	Name string
	Dir  string // as it was given, e.g. ~/notes
	Hue  int    // the accent, and where its gradient starts
	Hue2 int    // where the gradient ends
	dir  string // where it is on disk, links followed
	ix   *Index
	app  *App
	gone atomic.Bool // its folder was missing; look again once it is back

	exclude []string // folders left out of searches; under app.mu
	newDir  string   // where new notes go, unless they are made elsewhere; under app.mu
}

// VaultConf is a vault as the config file keeps it.
type VaultConf struct {
	Name     string   `json:"name"`
	Dir      string   `json:"dir"`
	Gradient []int    `json:"gradient,omitempty"` // two hues, 0–359
	Exclude  []string `json:"exclude,omitempty"`  // folders left out of searches
	NewDir   string   `json:"new,omitempty"`      // where new notes go; "" the top level
}

func defaultConfig() string {
	d, err := os.UserConfigDir()
	if err != nil {
		return ""
	}
	return filepath.Join(d, "gonotes", "vaults.json")
}

func loadConfig(file string) ([]VaultConf, error) {
	if file == "" {
		return nil, fs.ErrNotExist
	}
	b, err := os.ReadFile(file)
	if err != nil {
		return nil, err
	}
	var c struct{ Vaults []VaultConf }
	if err := json.Unmarshal(b, &c); err != nil {
		return nil, fmt.Errorf("%s: %w", file, err)
	}
	return c.Vaults, nil
}

// parseDirs reads -dir flags: "path" or "name=path".
func parseDirs(dirs []string) []VaultConf {
	var out []VaultConf
	for _, d := range dirs {
		name, dir, named := strings.Cut(d, "=")
		if !named {
			name, dir = "", d
		}
		out = append(out, VaultConf{Name: strings.TrimSpace(name), Dir: strings.TrimSpace(dir)})
	}
	return out
}

func NewApp(confs []VaultConf, file string) (*App, error) {
	b, _ := webFS.ReadFile("web/help.md")
	a := &App{file: file, help: parseNote(helpPath, string(b), time.Time{}, int64(len(b)))}
	a.help.Builtin = true
	if len(confs) == 0 {
		return a, nil // the welcome page asks for the first
	}
	vs, err := a.build(confs, false)
	if err != nil {
		return nil, err
	}
	a.vaults = vs
	return a, nil
}

// build turns the config into vaults, keeping the index of a folder that was
// already open, and indexing a new one before it is shown. With create, a
// folder just added and not there yet is made. A vault whose folder is
// missing, like a drive not plugged in, is kept as it is: its pages say so
// until the folder is back, and nothing is made in its place.
func (a *App) build(confs []VaultConf, create bool) ([]*Vault, error) {
	if len(confs) == 0 {
		return nil, errors.New("there has to be at least one vault")
	}
	old := map[string]*Index{}
	known := map[string]bool{}
	for _, v := range a.all() {
		old[v.dir] = v.ix
		known[v.Dir] = true
	}
	home, _ := os.UserHomeDir()
	seen := map[string]bool{}
	var out []*Vault
	for i, c := range confs {
		dir := c.Dir
		if dir == "" {
			return nil, fmt.Errorf("vault %d has no folder", i+1)
		}
		if dir == "~" || strings.HasPrefix(dir, "~/") {
			dir = filepath.Join(home, dir[1:])
		}
		abs, err := filepath.Abs(dir)
		if err != nil {
			return nil, err
		}
		if create && !known[c.Dir] {
			if err := os.MkdirAll(abs, 0o755); err != nil {
				return nil, err
			}
		}
		// A folder that is a link, like ~/notes to a synced folder, is
		// known by where it points.
		if real, err := filepath.EvalSymlinks(abs); err == nil {
			abs = real
		}
		name := c.Name
		if name == "" {
			name = filepath.Base(abs)
		}
		if strings.ContainsAny(name, "/\\") {
			return nil, fmt.Errorf("%q: a vault name cannot have a slash in it", name)
		}
		if seen[strings.ToLower(name)] {
			return nil, fmt.Errorf("two vaults are called %q: give one another name", name)
		}
		seen[strings.ToLower(name)] = true
		v := &Vault{Name: name, Dir: c.Dir, dir: abs, app: a, exclude: c.Exclude, newDir: c.NewDir}
		v.Hue, v.Hue2 = defaultGradient(i, name)
		if len(c.Gradient) == 2 {
			v.Hue, v.Hue2 = mod360(c.Gradient[0]), mod360(c.Gradient[1])
		}
		if v.ix = old[abs]; v.ix == nil {
			v.ix = NewIndex(abs)
			v.ix.extra = a.help
			if err := v.ix.Refresh(); err != nil {
				return nil, err
			}
		}
		out = append(out, v)
	}
	return out, nil
}

// defaultGradient keeps the first vault in the blue it always had and gives
// the others a colour of their own, as their dots have.
func defaultGradient(i int, name string) (int, int) {
	if i == 0 {
		return 258, 300
	}
	h := hue(name)
	return h, mod360(h + 45)
}

func mod360(h int) int { return ((h % 360) + 360) % 360 }

// set replaces the vaults and keeps them in the config file.
func (a *App) set(confs []VaultConf) error {
	vs, err := a.build(confs, true)
	if err != nil {
		return err
	}
	a.mu.Lock()
	a.vaults = vs
	a.mu.Unlock()
	return a.save()
}

func (a *App) save() error {
	if a.file == "" {
		return nil
	}
	var c struct {
		Vaults []VaultConf `json:"vaults"`
	}
	for _, v := range a.all() {
		c.Vaults = append(c.Vaults, VaultConf{Name: v.Name, Dir: v.Dir, Gradient: []int{v.Hue, v.Hue2}, Exclude: v.Excluded(), NewDir: v.NewDir()})
	}
	b, _ := json.MarshalIndent(c, "", "  ")
	return writeAtomic(a.file, append(b, '\n'))
}

func (a *App) all() []*Vault {
	a.mu.RLock()
	defer a.mu.RUnlock()
	return append([]*Vault(nil), a.vaults...)
}

func (a *App) find(name string) *Vault {
	for _, v := range a.all() {
		if strings.EqualFold(v.Name, name) {
			return v
		}
	}
	return nil
}

const vaultCookie = "vault"

// Missing says the vault's folder is not there, e.g. on a drive unplugged.
func (v *Vault) Missing() bool {
	st, err := os.Stat(v.dir)
	return err != nil || !st.IsDir()
}

// missing answers for a vault whose folder is gone: a page saying so, with
// the other vaults to go to, or a plain refusal for the page's own requests.
func (v *Vault) missing(w http.ResponseWriter, r *http.Request) {
	msg := "The folder of " + v.Name + " is not there: " + v.Dir
	if r.Method != http.MethodGet || r.Header.Get("X-Partial") != "" {
		http.Error(w, msg, http.StatusConflict)
		return
	}
	p := v.base(r, v.Name+" is not there")
	w.WriteHeader(http.StatusServiceUnavailable)
	render(w, "missing", "layout", p)
}

// in runs a handler in the vault the request is for. Pages go by the vault
// last switched to; the page's own requests and forms name the vault it was
// built for, so switching in another tab cannot send a save to the wrong
// folder.
func (a *App) in(h func(*Vault, http.ResponseWriter, *http.Request)) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		if len(a.all()) == 0 {
			if r.Method == http.MethodGet {
				http.Redirect(w, r, "/welcome", http.StatusSeeOther)
				return
			}
			http.Error(w, "there is no vault yet", http.StatusConflict)
			return
		}
		name := r.Header.Get("X-Vault")
		if name == "" && r.Method == http.MethodPost {
			name = r.FormValue("vault")
		}
		if name != "" {
			v := a.find(name)
			if v == nil {
				http.Error(w, "no vault called "+name, http.StatusNotFound)
				return
			}
			a.run(h, v, w, r)
			return
		}
		a.run(h, a.current(r), w, r)
	}
}

// run hands the request to h, unless the vault's folder is missing; the
// Vaults page works all the same, to point it somewhere else.
func (a *App) run(h func(*Vault, http.ResponseWriter, *http.Request), v *Vault, w http.ResponseWriter, r *http.Request) {
	if v.Missing() {
		v.gone.Store(true)
		if r.URL.Path != "/vaults" {
			v.missing(w, r)
			return
		}
	} else if v.gone.Swap(false) {
		v.ix.Refresh()
	}
	h(v, w, r)
}

// current is the vault last switched to, else the first.
func (a *App) current(r *http.Request) *Vault {
	if c, err := r.Cookie(vaultCookie); err == nil {
		if n, err := url.QueryUnescape(c.Value); err == nil {
			if v := a.find(n); v != nil {
				return v
			}
		}
	}
	return a.all()[0]
}

// switchVault makes another vault the one pages show, and opens it.
func (a *App) switchVault(w http.ResponseWriter, r *http.Request) {
	v := a.find(r.PathValue("name"))
	if v == nil {
		http.Error(w, "no vault called "+r.PathValue("name"), http.StatusNotFound)
		return
	}
	v.remember(w)
	http.Redirect(w, r, "/", http.StatusSeeOther)
}

// Excluded is the folders left out of searches.
func (v *Vault) Excluded() []string {
	v.app.mu.RLock()
	defer v.app.mu.RUnlock()
	return append([]string(nil), v.exclude...)
}

// NewDir is the folder new notes go to, "" for the top level.
func (v *Vault) NewDir() string {
	v.app.mu.RLock()
	defer v.app.mu.RUnlock()
	return v.newDir
}

// setNewDir picks the folder new notes go to, from Options, and keeps it.
func (v *Vault) setNewDir(w http.ResponseWriter, r *http.Request) {
	dir := strings.Trim(r.FormValue("dir"), "/")
	if dir != "" {
		rel, _, err := v.resolve(dir)
		if err != nil {
			http.Error(w, err.Error(), http.StatusBadRequest)
			return
		}
		dir = rel
	}
	v.app.mu.Lock()
	v.newDir = dir
	v.app.mu.Unlock()
	if err := v.app.save(); err != nil {
		http.Error(w, "not kept: "+err.Error(), http.StatusInternalServerError)
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

// IsExcluded says whether a folder is left out of searches, itself or by a
// folder it is in.
func (v *Vault) IsExcluded(dir string) bool {
	for _, e := range v.Excluded() {
		if strings.EqualFold(dir, e) || strings.HasPrefix(strings.ToLower(dir), strings.ToLower(e)+"/") {
			return true
		}
	}
	return false
}

// exclude leaves a folder out of searches, or takes it back in, and keeps
// that in the config.
func (v *Vault) excludeDir(w http.ResponseWriter, r *http.Request) {
	rel, _, err := v.resolve(r.FormValue("dir"))
	if err != nil {
		http.Error(w, err.Error(), http.StatusBadRequest)
		return
	}
	on := r.FormValue("on") != ""
	v.app.mu.Lock()
	var kept []string
	for _, e := range v.exclude {
		if !strings.EqualFold(e, rel) {
			kept = append(kept, e)
		}
	}
	if on {
		kept = append(kept, rel)
	}
	v.exclude = kept
	v.app.mu.Unlock()
	if err := v.app.save(); err != nil {
		http.Error(w, "not kept: "+err.Error(), http.StatusInternalServerError)
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

// followMove keeps folders left out of searches left out when they, or a
// folder they are in, move or get another name.
func (v *Vault) followMove(from, to string) {
	v.app.mu.Lock()
	changed := false
	if strings.EqualFold(v.newDir, from) {
		v.newDir, changed = to, true
	} else if strings.HasPrefix(strings.ToLower(v.newDir), strings.ToLower(from)+"/") {
		v.newDir, changed = to+v.newDir[len(from):], true
	}
	for i, e := range v.exclude {
		if strings.EqualFold(e, from) {
			v.exclude[i], changed = to, true
		} else if strings.HasPrefix(strings.ToLower(e), strings.ToLower(from)+"/") {
			v.exclude[i], changed = to+e[len(from):], true
		}
	}
	v.app.mu.Unlock()
	if changed {
		v.app.save()
	}
}

// Count is how many notes the vault holds, for the switcher.
func (v *Vault) Count() int {
	v.ix.Fresh()
	return v.ix.Len()
}

// Label is what the page calls the vault: just "notes" while there is one.
func (v *Vault) Label() string {
	if len(v.app.all()) == 1 {
		return "notes"
	}
	return v.Name
}

func (v *Vault) remember(w http.ResponseWriter) {
	http.SetCookie(w, &http.Cookie{
		Name: vaultCookie, Value: url.QueryEscape(v.Name), Path: "/",
		MaxAge: 400 * 24 * 3600, HttpOnly: true, SameSite: http.SameSiteLaxMode,
	})
}

// browse lists the folders in a folder, for picking a vault's folder on the
// Vaults page: dir as typed (~ is home; empty is home), its parent, and the
// folders in it, dot-folders left out.
func (a *App) browse(w http.ResponseWriter, r *http.Request) {
	home, _ := os.UserHomeDir()
	dir := strings.TrimSpace(r.URL.Query().Get("dir"))
	switch {
	case dir == "" || dir == "~":
		dir = home
	case strings.HasPrefix(dir, "~/"):
		dir = filepath.Join(home, dir[2:])
	}
	dir, err := filepath.Abs(dir)
	if err != nil {
		http.Error(w, err.Error(), http.StatusBadRequest)
		return
	}
	entries, err := os.ReadDir(dir)
	if err != nil {
		http.Error(w, err.Error(), http.StatusBadRequest)
		return
	}
	dirs := []string{}
	for _, e := range entries {
		if strings.HasPrefix(e.Name(), ".") {
			continue
		}
		// A link to a folder, like ~/notes, is a folder here too.
		if st, err := os.Stat(filepath.Join(dir, e.Name())); err == nil && st.IsDir() {
			dirs = append(dirs, e.Name())
		}
	}
	sort.Slice(dirs, func(i, j int) bool { return strings.ToLower(dirs[i]) < strings.ToLower(dirs[j]) })
	out := map[string]any{"dir": shortPath(dir), "dirs": dirs, "places": places()}
	if parent := filepath.Dir(dir); parent != dir {
		out["parent"] = shortPath(parent)
	}
	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(out)
}

// ---- the first start ----

type welcomePage struct {
	Version string
	Row     vaultRow
	Error   string
}

// welcome asks for the first vault's folder, while there is none.
func (a *App) welcome(w http.ResponseWriter, r *http.Request) {
	if len(a.all()) > 0 {
		http.Redirect(w, r, "/", http.StatusSeeOther)
		return
	}
	render(w, "welcome", "welcome", &welcomePage{Version: version})
}

// firstVault makes the vault the welcome page picked, and starts the tour.
func (a *App) firstVault(w http.ResponseWriter, r *http.Request) {
	r.ParseForm()
	row := vaultRow{Name: strings.TrimSpace(r.FormValue("name-new")), Dir: strings.TrimSpace(r.FormValue("dir-new"))}
	fail := func(msg string) {
		w.WriteHeader(http.StatusBadRequest)
		render(w, "welcome", "welcome", &welcomePage{Version: version, Row: row, Error: msg})
	}
	if row.Dir == "" {
		fail("Pick a folder for your notes first.")
		return
	}
	if len(a.all()) > 0 {
		http.Redirect(w, r, "/", http.StatusSeeOther)
		return
	}
	if err := a.set([]VaultConf{{Name: row.Name, Dir: row.Dir}}); err != nil {
		fail(err.Error())
		return
	}
	a.all()[0].remember(w)
	http.Redirect(w, r, "/?tour=1", http.StatusSeeOther)
}

// ---- the Vaults page ----

type vaultsForm struct {
	Rows  []vaultRow
	New   vaultRow
	Error string
	Saved bool
}

type vaultRow struct {
	Orig, Name, Dir string // Orig: the name before this edit, to follow a rename
	Hue, Hue2       int
	Notes           int
	Remove          bool
}

func (v *Vault) vaultsPage(w http.ResponseWriter, r *http.Request) {
	f := &vaultsForm{Saved: r.URL.Query().Has("saved")}
	for _, x := range v.app.all() {
		f.Rows = append(f.Rows, vaultRow{Orig: x.Name, Name: x.Name, Dir: x.Dir, Hue: x.Hue, Hue2: x.Hue2, Notes: x.Count()})
	}
	f.New.Hue, f.New.Hue2 = defaultGradient(len(f.Rows), fmt.Sprint(len(f.Rows)))
	p := v.base(r, "Vaults")
	p.Settings = f
	render(w, "vaults", "layout", p)
}

// saveVaults takes the whole list as the page sends it: every row, which to
// remove, one to move, and a new one if it has a folder.
func (v *Vault) saveVaults(w http.ResponseWriter, r *http.Request) {
	r.ParseForm()
	row := func(key string) vaultRow {
		h1, _ := strconv.Atoi(r.FormValue("hue-" + key))
		h2, _ := strconv.Atoi(r.FormValue("hue2-" + key))
		return vaultRow{
			Orig: r.FormValue("orig-" + key),
			Name: strings.TrimSpace(r.FormValue("name-" + key)),
			Dir:  strings.TrimSpace(r.FormValue("dir-" + key)),
			Hue:  mod360(h1), Hue2: mod360(h2),
			Remove: r.FormValue("remove-"+key) != "",
		}
	}
	f := &vaultsForm{New: row("new")}
	n, _ := strconv.Atoi(r.FormValue("count"))
	for i := range n {
		f.Rows = append(f.Rows, row(strconv.Itoa(i)))
	}
	if dir, i, ok := strings.Cut(r.FormValue("move"), "-"); ok {
		if i, err := strconv.Atoi(i); err == nil && i >= 0 && i < len(f.Rows) {
			j := i - 1
			if dir == "down" {
				j = i + 1
			}
			if j >= 0 && j < len(f.Rows) {
				f.Rows[i], f.Rows[j] = f.Rows[j], f.Rows[i]
			}
		}
	}

	var confs []VaultConf
	var kept []vaultRow
	for _, x := range f.Rows {
		if x.Remove {
			continue
		}
		kept = append(kept, x)
		c := VaultConf{Name: x.Name, Dir: x.Dir, Gradient: []int{x.Hue, x.Hue2}}
		if old := v.app.find(x.Orig); old != nil && old.Dir == x.Dir {
			c.Exclude, c.NewDir = old.Excluded(), old.NewDir() // the page does not show them; they stay
		}
		confs = append(confs, c)
	}
	if f.New.Dir != "" {
		confs = append(confs, VaultConf{Name: f.New.Name, Dir: f.New.Dir, Gradient: []int{f.New.Hue, f.New.Hue2}})
	}
	if err := v.app.set(confs); err != nil {
		p := v.base(r, "Vaults")
		f.Error = err.Error()
		p.Settings = f
		w.WriteHeader(http.StatusBadRequest)
		render(w, "vaults", "layout", p)
		return
	}
	// Stay in the vault this page was opened from, under its new name, or
	// the first when it was taken off the list.
	stay := v.app.all()[0]
	for i, x := range kept {
		if x.Orig == v.Name {
			stay = v.app.all()[i]
		}
	}
	stay.remember(w)
	http.Redirect(w, r, "/vaults?saved", http.StatusSeeOther)
}
