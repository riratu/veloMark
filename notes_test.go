package main

import (
	"encoding/json"
	"fmt"
	"mime/multipart"
	"net/http"
	"net/http/httptest"
	"net/url"
	"os"
	"path/filepath"
	"regexp"
	"strconv"
	"strings"
	"testing"
	"time"
)

func write(t *testing.T, dir, rel, body string) {
	t.Helper()
	p := filepath.Join(dir, rel)
	os.MkdirAll(filepath.Dir(p), 0o755)
	if err := os.WriteFile(p, []byte(body), 0o644); err != nil {
		t.Fatal(err)
	}
}

func testApp(t *testing.T, dirs ...string) *App {
	t.Helper()
	app, err := NewApp(parseDirs(dirs), "")
	if err != nil {
		t.Fatal(err)
	}
	for _, v := range app.vaults {
		v.ix.Refresh()
	}
	return app
}

func TestTitleIsNeverAHeading(t *testing.T) {
	if n := parseNote("Listen/Restaurants und Cafes.md", "Cafe\n- x\n# Olten\n", time.Now(), 1); n.Title != "Restaurants und Cafes" {
		t.Errorf("a section heading: %q", n.Title)
	}
	if n := parseNote("a.md", "# Leading\ntext", time.Now(), 1); n.Title != "a" {
		t.Errorf("a leading heading: %q", n.Title)
	}
}

func TestNotTags(t *testing.T) {
	n := parseNote("a.md", "See [the plan](#org0ba4682) and (#real) and `#code` and issue #3, step #12 #v2 #ops\n", time.Now(), 1)
	if got := strings.Join(n.Tags, ","); got != "ops,real,v2" {
		t.Errorf("tags %q", got)
	}
}

func TestParseNote(t *testing.T) {
	n := parseNote("work/x.md", "---\ntitle: From front matter\ntags: [a, b]\n---\n# Heading\nsome #inline tag\n```\n#notatag\n```\n", time.Now(), 1)
	if n.Title != "From front matter" {
		t.Errorf("title %q", n.Title)
	}
	if got := strings.Join(n.Tags, ","); got != "a,b,inline" {
		t.Errorf("tags %q", got)
	}
	n = parseNote("plain.md", "no heading here", time.Now(), 1)
	if n.Title != "plain" {
		t.Errorf("fallback title %q", n.Title)
	}
}

func TestSearch(t *testing.T) {
	dir := t.TempDir()
	write(t, dir, "work/deploy.md", "# Deploy checklist\nrun the pipeline #ops\n")
	write(t, dir, "home/garden.md", "# Garden\ntomatoes need water, deploy the hose #home\n")
	write(t, dir, "work/ideas.md", "# Ideas\n\"exact phrase here\"\n")
	write(t, dir, "work/old/run.md", "# Run\nthe pipeline\n")
	ix := NewIndex(dir)
	if err := ix.Refresh(); err != nil {
		t.Fatal(err)
	}
	cases := map[string][]string{
		"deploy":           {"work/deploy.md", "home/garden.md"}, // title hit ranks first
		"deploy in:home":   {"home/garden.md"},
		"pipeline in:work": {"work/deploy.md"}, // not work/old/run.md
		"tomatoes in:/":    nil,                // home/garden.md is in a folder
		"#ops":             {"work/deploy.md"},
		"deploy -tomato":   {"work/deploy.md"},
		`"exact phrase"`:   {"work/ideas.md"},
		"nothingmatches":   nil,
		"DEPLOY pipeline":  {"work/deploy.md"},
	}
	for q, want := range cases {
		hits, _ := ix.Search(ParseQuery(q))
		var got []string
		for _, h := range hits {
			got = append(got, h.Path)
		}
		if strings.Join(got, " ") != strings.Join(want, " ") {
			t.Errorf("%s: got %v want %v", q, got, want)
		}
	}
}

func TestToggle(t *testing.T) {
	q := ParseQuery(`foo "a b" #x`)
	if got := q.Toggle("#x"); got != `foo "a b"` {
		t.Errorf("remove: %q", got)
	}
	if got := q.Toggle("in:work"); got != `foo "a b" #x in:work` {
		t.Errorf("add: %q", got)
	}
	q = ParseQuery(`foo in:work #x`)
	if got := q.Toggle("in:home"); got != `foo #x in:home` {
		t.Errorf("one folder at a time: %q", got)
	}
	if got := q.Toggle("in:work"); got != `foo #x` {
		t.Errorf("folder off: %q", got)
	}
	if got := q.Toggle("#y"); got != `foo in:work #x #y` {
		t.Errorf("tags add up: %q", got)
	}
	if got := ParseQuery(`in:work`).Box(); got != `in:work ` {
		t.Errorf("a space after a folder: %q", got)
	}
	if got := ParseQuery(`deploy`).Box(); got != `deploy` {
		t.Errorf("none after a word: %q", got)
	}
	if got := q.Pick("in:work"); got != `foo in:work #x` {
		t.Errorf("a picked folder stays picked: %q", got)
	}
	if got := q.Pick("in:home"); got != `foo #x in:home` {
		t.Errorf("another folder replaces it: %q", got)
	}
}

func TestResolveRefusesEscapes(t *testing.T) {
	a := &Vault{dir: "/notes"}
	for _, bad := range []string{"../etc/passwd", ".trash/x.md", "a/../../b.md", "", "a/.git/config"} {
		rel, _, err := a.resolve(bad)
		if err == nil && !strings.HasPrefix(filepath.Join(a.dir, rel), a.dir+"/") {
			t.Errorf("%q escaped to %q", bad, rel)
		}
		if err == nil && (strings.Contains(bad, ".trash") || strings.Contains(bad, ".git") || bad == "") {
			t.Errorf("%q should be refused", bad)
		}
	}
}

func TestSaveFlow(t *testing.T) {
	dir := t.TempDir()
	write(t, dir, "a.md", "# A\nold\n")
	app := testApp(t, dir)
	h := app.routes()

	post := func(path string, form url.Values) *httptest.ResponseRecorder {
		r := httptest.NewRequest("POST", "http://127.0.0.1:8090"+path, strings.NewReader(form.Encode()))
		r.Header.Set("Content-Type", "application/x-www-form-urlencoded")
		w := httptest.NewRecorder()
		h.ServeHTTP(w, r)
		return w
	}

	// A new note in a new folder, without the .md typed.
	w := post("/save", url.Values{"path": {"sub/b"}, "body": {"# B\n"}})
	if w.Code != http.StatusSeeOther {
		t.Fatalf("new: %d %s", w.Code, w.Body)
	}
	if b, _ := os.ReadFile(filepath.Join(dir, "sub/b.md")); string(b) != "# B\n" {
		t.Errorf("new body %q", b)
	}

	// A stale edit is refused, then forced through.
	n := app.vaults[0].ix.Get("a.md")
	stale := url.Values{"path": {"a.md"}, "orig": {"a.md"}, "mod": {"1"}, "body": {"mine"}}
	if w := post("/save", stale); w.Code != http.StatusConflict {
		t.Errorf("stale save: %d", w.Code)
	}
	stale.Set("force", "1")
	if w := post("/save", stale); w.Code != http.StatusSeeOther {
		t.Errorf("forced save: %d", w.Code)
	}

	// Rename with the right mod time.
	n = app.vaults[0].ix.Get("a.md")
	w = post("/save", url.Values{"path": {"renamed.md"}, "orig": {"a.md"}, "mod": {itoa(n.Mod.UnixNano())}, "body": {"x"}})
	if w.Code != http.StatusSeeOther {
		t.Fatalf("rename: %d %s", w.Code, w.Body)
	}
	if _, err := os.Stat(filepath.Join(dir, "a.md")); !os.IsNotExist(err) {
		t.Error("old file still there after rename")
	}

	// Delete moves to .trash, which the index then ignores.
	post("/delete", url.Values{"path": {"renamed.md"}})
	if app.vaults[0].ix.Get("renamed.md") != nil {
		t.Error("deleted note still indexed")
	}
	if m, _ := filepath.Glob(filepath.Join(dir, ".trash", "renamed.md.*")); len(m) != 1 {
		t.Errorf("trash: %v", m)
	}

	// A cross-site post is refused.
	r := httptest.NewRequest("POST", "http://127.0.0.1:8090/delete", strings.NewReader("path=sub/b.md"))
	r.Header.Set("Content-Type", "application/x-www-form-urlencoded")
	r.Header.Set("Sec-Fetch-Site", "cross-site")
	w = httptest.NewRecorder()
	h.ServeHTTP(w, r)
	if w.Code != http.StatusForbidden {
		t.Errorf("cross-site delete: %d", w.Code)
	}
}

func itoa(n int64) string { return strconv.FormatInt(n, 10) }

func TestFolderWithSpace(t *testing.T) {
	dir := t.TempDir()
	write(t, dir, "My Folder/a.md", "# A\n")
	write(t, dir, "other/b.md", "# B\n")
	ix := NewIndex(dir)
	ix.Refresh()
	for _, raw := range []string{Query{}.Toggle("in:My Folder"), Query{Raw: "x"}.Toggle("in:My Folder")[2:], `"in:My Folder"`} {
		hits, _ := ix.Search(ParseQuery(raw))
		if len(hits) != 1 || hits[0].Path != "My Folder/a.md" {
			t.Errorf("%q: %d hits", raw, len(hits))
		}
	}
}

// Every filter link the pages render must lead to the notes it names. They
// once came out escaped twice and every one of them found nothing.
func TestFilterLinksFindNotes(t *testing.T) {
	dir := t.TempDir()
	write(t, dir, "My Folder/Sub Dir/a.md", "# A\n#tag-a\n")
	write(t, dir, "My Folder/top.md", "# Top\n")
	write(t, dir, "plain/b.md", "# B\n#tag-b\n")
	app := testApp(t, dir)
	h := app.routes()
	get := func(u string) string {
		w := httptest.NewRecorder()
		h.ServeHTTP(w, httptest.NewRequest("GET", "http://127.0.0.1:8090"+u, nil))
		return w.Body.String()
	}
	hrefRe := regexp.MustCompile(`href="(/\?q=[^"]+)"`)
	pages := []string{"/", "/?open=" + url.QueryEscape("My Folder/Sub Dir/a.md")}
	seen := 0
	for _, p := range pages {
		for _, m := range hrefRe.FindAllStringSubmatch(get(p), -1) {
			href := strings.ReplaceAll(m[1], "&amp;", "&")
			if strings.Contains(href, "%25") {
				t.Errorf("%s: %s is escaped twice", p, href)
			}
			if body := get(href); !strings.Contains(body, `class="hit"`) {
				t.Errorf("%s: %s finds nothing", p, href)
			}
			seen++
		}
	}
	if seen < 8 {
		t.Errorf("only %d filter links checked", seen)
	}
}

func TestSnippet(t *testing.T) {
	got := string(snippet(withoutTitle("# Title\n#tag\nTomatoes and **basil**. See [deploy](x.md).\n\n| a | b |\n|---|---|\n"), []string{"basil"}))
	want := "#tag Tomatoes and <mark>basil</mark>. See deploy. a b"
	if got != want {
		t.Errorf("got  %q\nwant %q", got, want)
	}
	long := strings.Repeat("filler words ", 20) + "needle"
	if got := string(snippet(long, []string{"needle"})); !strings.HasPrefix(got, "…") || !strings.Contains(got, "<mark>needle</mark>") {
		t.Errorf("match far in should be in view: %q", got)
	}
	if got := string(snippet("we met with the whole team about the deploy", []string{"deploy"})); got != "…whole team about the <mark>deploy</mark>" {
		t.Errorf("should start on a word: %q", got)
	}
}

func TestMove(t *testing.T) {
	dir := t.TempDir()
	write(t, dir, "inbox/a.md", "# A\n")
	write(t, dir, "work/a.md", "# taken\n")
	write(t, dir, "inbox/b.md", "# B\n")
	app := testApp(t, dir)
	h := app.routes()
	move := func(p, d string) *httptest.ResponseRecorder {
		r := httptest.NewRequest("POST", "http://127.0.0.1:8090/move", strings.NewReader(url.Values{"path": {p}, "dir": {d}}.Encode()))
		r.Header.Set("Content-Type", "application/x-www-form-urlencoded")
		w := httptest.NewRecorder()
		h.ServeHTTP(w, r)
		return w
	}
	if w := move("inbox/a.md", "work"); w.Code != http.StatusConflict {
		t.Errorf("onto an existing name: %d", w.Code)
	}
	if w := move("inbox/b.md", "new/deeper"); w.Code != 200 || !strings.Contains(w.Body.String(), `"path":"new/deeper/b.md"`) {
		t.Errorf("into a new folder: %d %s", w.Code, w.Body)
	}
	if app.vaults[0].ix.Get("new/deeper/b.md") == nil || app.vaults[0].ix.Get("inbox/b.md") != nil {
		t.Error("index not updated after move")
	}
	if w := move("new/deeper/b.md", ""); w.Code != 200 || !strings.Contains(w.Body.String(), `"path":"b.md"`) {
		t.Errorf("to the top level: %d %s", w.Code, w.Body)
	}
	if w := move("b.md", "../outside"); w.Code != http.StatusBadRequest && w.Code != 200 {
		t.Errorf("escape: %d", w.Code)
	}
	if _, err := os.Stat(filepath.Join(filepath.Dir(dir), "outside")); err == nil {
		t.Error("moved outside the notes folder")
	}
}

func TestNoteFromQuery(t *testing.T) {
	title, dir, tags := noteFromQuery(`Meeting Notes in:Work #ops -draft sort:title`)
	if title != "Meeting Notes" || dir != "Work" || strings.Join(tags, ",") != "ops" {
		t.Errorf("got %q %q %v", title, dir, tags)
	}
	if got := fileName("../a/b: c"); got != "-a-b: c" {
		t.Errorf("fileName: %q", got)
	}
}

func TestNewFromSearch(t *testing.T) {
	dir := t.TempDir()
	write(t, dir, "Work/x.md", "# X\n")
	app := testApp(t, dir)
	h := app.routes()
	create := func(form url.Values) *httptest.ResponseRecorder {
		r := httptest.NewRequest("POST", "http://127.0.0.1:8090/new", strings.NewReader(form.Encode()))
		r.Header.Set("Content-Type", "application/x-www-form-urlencoded")
		w := httptest.NewRecorder()
		h.ServeHTTP(w, r)
		return w
	}
	w := create(url.Values{"from": {"Quarterly plan in:work #ops"}})
	if w.Code != http.StatusSeeOther || w.Header().Get("Location") != "/?open="+url.QueryEscape("Work/Quarterly plan.md") {
		t.Fatalf("made and opened in place: %d %s", w.Code, w.Header().Get("Location"))
	}
	if b, _ := os.ReadFile(filepath.Join(dir, "Work", "Quarterly plan.md")); string(b) != "#ops\n\n" {
		t.Errorf("written at once: %q", b)
	}
	// The same again gets a number; nothing searched for is Untitled.
	if loc := create(url.Values{"from": {"Quarterly plan in:work"}}).Header().Get("Location"); !strings.Contains(loc, url.QueryEscape("Quarterly plan 2.md")) {
		t.Errorf("second: %s", loc)
	}
	if loc := create(url.Values{"dir": {"Work"}}).Header().Get("Location"); loc != "/?open="+url.QueryEscape("Work/Untitled.md") {
		t.Errorf("untitled: %s", loc)
	}
	// Making a note is never a plain visit.
	w = httptest.NewRecorder()
	h.ServeHTTP(w, httptest.NewRequest("GET", "http://127.0.0.1:8090/new?from=x", nil))
	if w.Code != http.StatusMethodNotAllowed {
		t.Errorf("GET /new: %d", w.Code)
	}
	// A note opened by its address has no page of its own: it opens in place.
	w = httptest.NewRecorder()
	h.ServeHTTP(w, httptest.NewRequest("GET", "http://127.0.0.1:8090/n/Work/x.md", nil))
	if w.Header().Get("Location") != "/?open="+url.QueryEscape("Work/x.md") {
		t.Errorf("open in place: %s", w.Header().Get("Location"))
	}
	w = httptest.NewRecorder()
	h.ServeHTTP(w, httptest.NewRequest("GET", "http://127.0.0.1:8090/?open="+url.QueryEscape("Work/x.md"), nil))
	if b := w.Body.String(); !strings.Contains(b, `class="focus dim"`) || !strings.Contains(b, `data-path="Work/x.md"`) {
		t.Error("the list comes folded, the note in place")
	}
}

func TestDeleteAndRestore(t *testing.T) {
	dir := t.TempDir()
	write(t, dir, "work/a.md", "# A\n")
	app := testApp(t, dir)
	h := app.routes()
	post := func(p string, form url.Values) *httptest.ResponseRecorder {
		r := httptest.NewRequest("POST", "http://127.0.0.1:8090"+p, strings.NewReader(form.Encode()))
		r.Header.Set("Content-Type", "application/x-www-form-urlencoded")
		r.Header.Set("Accept", "application/json")
		w := httptest.NewRecorder()
		h.ServeHTTP(w, r)
		return w
	}
	w := post("/delete", url.Values{"path": {"work/a.md"}})
	var out map[string]string
	if err := json.Unmarshal(w.Body.Bytes(), &out); err != nil || !strings.HasPrefix(out["trash"], ".trash/work/a.md.") {
		t.Fatalf("delete: %d %s", w.Code, w.Body)
	}
	if app.vaults[0].ix.Get("work/a.md") != nil {
		t.Error("still indexed")
	}
	for _, bad := range []string{"work/a.md", "../x", ".trash/../work/a.md", ".trash/.git/x"} {
		if w := post("/restore", url.Values{"trash": {bad}, "path": {"work/a.md"}}); w.Code != http.StatusBadRequest {
			t.Errorf("restore from %q: %d", bad, w.Code)
		}
	}
	if w := post("/restore", url.Values{"trash": {out["trash"]}, "path": {"work/a.md"}}); w.Code != 200 {
		t.Fatalf("restore: %d %s", w.Code, w.Body)
	}
	if b, _ := os.ReadFile(filepath.Join(dir, "work/a.md")); string(b) != "# A\n" {
		t.Errorf("restored body %q", b)
	}
}

func TestVaults(t *testing.T) {
	home, work := t.TempDir(), t.TempDir()
	write(t, home, "garden.md", "# Garden\n")
	write(t, work, "deploy.md", "# Deploy\n")
	app := testApp(t, home, "job="+work)
	if app.vaults[1].Name != "job" || app.vaults[0].Name != filepath.Base(home) {
		t.Fatalf("names %q %q", app.vaults[0].Name, app.vaults[1].Name)
	}
	if _, err := NewApp(parseDirs([]string{home, filepath.Base(home) + "=" + work}), ""); err == nil {
		t.Error("two vaults of one name")
	}
	h := app.routes()
	get := func(p string, cookie *http.Cookie, hdr string) *httptest.ResponseRecorder {
		r := httptest.NewRequest("GET", "http://127.0.0.1:8090"+p, nil)
		if cookie != nil {
			r.AddCookie(cookie)
		}
		if hdr != "" {
			r.Header.Set("X-Vault", hdr)
		}
		w := httptest.NewRecorder()
		h.ServeHTTP(w, r)
		return w
	}
	if b := get("/", nil, "").Body.String(); !strings.Contains(b, "Garden") || strings.Contains(b, "Deploy") {
		t.Error("the first vault is the default")
	}
	w := get("/vault/job", nil, "")
	cookies := w.Result().Cookies()
	if w.Code != http.StatusSeeOther || len(cookies) != 1 {
		t.Fatalf("switch: %d %v", w.Code, cookies)
	}
	if b := get("/", cookies[0], "").Body.String(); !strings.Contains(b, "Deploy") || strings.Contains(b, "Garden") {
		t.Error("the cookie picks the vault")
	}
	// A page's own requests name its vault, whatever was switched to since.
	if b := get("/?q=garden", cookies[0], filepath.Base(home)).Body.String(); !strings.Contains(b, "Garden") {
		t.Error("the header wins over the cookie")
	}
	if get("/vault/nope", nil, "").Code != http.StatusNotFound || get("/", nil, "nope").Code != http.StatusNotFound {
		t.Error("unknown vaults are refused")
	}

	form := url.Values{"path": {"new.md"}, "body": {"# New\n"}, "vault": {"job"}}
	r := httptest.NewRequest("POST", "http://127.0.0.1:8090/save", strings.NewReader(form.Encode()))
	r.Header.Set("Content-Type", "application/x-www-form-urlencoded")
	h.ServeHTTP(httptest.NewRecorder(), r)
	if _, err := os.Stat(filepath.Join(work, "new.md")); err != nil {
		t.Error("save goes to the vault the form names")
	}
}

func TestMoveToVault(t *testing.T) {
	home, work := t.TempDir(), t.TempDir()
	write(t, home, "inbox/a.md", "# A\n")
	write(t, home, "b.md", "# B\n")
	write(t, work, "b.md", "# taken\n")
	app := testApp(t, home, "job="+work)
	h := app.routes()
	move := func(from string, form url.Values) *httptest.ResponseRecorder {
		r := httptest.NewRequest("POST", "http://127.0.0.1:8090/movevault", strings.NewReader(form.Encode()))
		r.Header.Set("Content-Type", "application/x-www-form-urlencoded")
		r.Header.Set("X-Vault", from)
		w := httptest.NewRecorder()
		h.ServeHTTP(w, r)
		return w
	}
	homeName := filepath.Base(home)
	if w := move(homeName, url.Values{"path": {"inbox/a.md"}, "to": {"job"}}); w.Code != 200 || !strings.Contains(w.Body.String(), `"path":"a.md"`) {
		t.Fatalf("move: %d %s", w.Code, w.Body)
	}
	if app.vaults[0].ix.Get("inbox/a.md") != nil || app.vaults[1].ix.Get("a.md") == nil {
		t.Error("indexes not updated after the move")
	}
	if w := move(homeName, url.Values{"path": {"b.md"}, "to": {"job"}}); w.Code != http.StatusConflict {
		t.Errorf("onto an existing name: %d", w.Code)
	}
	if w := move(homeName, url.Values{"path": {"b.md"}, "to": {homeName}}); w.Code != http.StatusBadRequest {
		t.Errorf("into its own vault: %d", w.Code)
	}
	if w := move(homeName, url.Values{"path": {"b.md"}, "to": {"nope"}}); w.Code != http.StatusNotFound {
		t.Errorf("into no vault: %d", w.Code)
	}
	// Undo: back into the folder it came from.
	if w := move("job", url.Values{"path": {"a.md"}, "to": {homeName}, "dir": {"inbox"}}); w.Code != 200 {
		t.Fatalf("back: %d %s", w.Code, w.Body)
	}
	if b, err := os.ReadFile(filepath.Join(home, "inbox/a.md")); err != nil || string(b) != "# A\n" {
		t.Errorf("back in inbox: %q %v", b, err)
	}
}

func TestAutosave(t *testing.T) {
	dir := t.TempDir()
	app := testApp(t, dir)
	h := app.routes()
	save := func(form url.Values) (int, map[string]string) {
		r := httptest.NewRequest("POST", "http://127.0.0.1:8090/save", strings.NewReader(form.Encode()))
		r.Header.Set("Content-Type", "application/x-www-form-urlencoded")
		r.Header.Set("Accept", "application/json")
		w := httptest.NewRecorder()
		h.ServeHTTP(w, r)
		var out map[string]string
		json.Unmarshal(w.Body.Bytes(), &out)
		return w.Code, out
	}
	code, out := save(url.Values{"path": {"draft"}, "body": {"one"}})
	if code != 200 || out["path"] != "draft.md" || out["mod"] == "" {
		t.Fatalf("new: %d %v", code, out)
	}
	code, out2 := save(url.Values{"path": {"renamed.md"}, "orig": {"draft.md"}, "mod": {out["mod"]}, "body": {"two"}})
	if code != 200 || out2["path"] != "renamed.md" {
		t.Fatalf("rename: %d %v", code, out2)
	}
	if b, _ := os.ReadFile(filepath.Join(dir, "renamed.md")); string(b) != "two" {
		t.Errorf("body %q", b)
	}
	if code, _ := save(url.Values{"path": {"renamed.md"}, "orig": {"renamed.md"}, "mod": {out["mod"]}, "body": {"stale"}}); code != http.StatusConflict {
		t.Errorf("a stale save must be refused, got %d", code)
	}
}

func TestLinkedFolderAndText(t *testing.T) {
	real := t.TempDir()
	write(t, real, "plain.txt", "# From Nextcloud\nsome text\n")
	write(t, real, "sub/note.md", "# Markdown\n")
	write(t, real, "plain.txt.encrypted.1765020635", "x")
	link := filepath.Join(t.TempDir(), "notes")
	if err := os.Symlink(real, link); err != nil {
		t.Skip(err)
	}
	app := testApp(t, link)
	ix := app.vaults[0].ix
	if ix.Len() != 3 || ix.Get("plain.txt") == nil || ix.Get("sub/note.md") == nil {
		t.Fatalf("got %d notes", ix.Len())
	}
	w := httptest.NewRecorder()
	r := httptest.NewRequest("GET", "http://127.0.0.1:8090/n/plain.txt", nil)
	r.Header.Set("X-Partial", "1")
	app.routes().ServeHTTP(w, r)
	if !strings.Contains(w.Body.String(), `data-path="plain.txt"`) {
		t.Error("a .txt note opens like any other")
	}
}

func TestFolders(t *testing.T) {
	dir := t.TempDir()
	write(t, dir, "work/infra/a.md", "# A\n")
	app := testApp(t, dir)
	h := app.routes()
	post := func(p string, form url.Values) (int, map[string]string) {
		r := httptest.NewRequest("POST", "http://127.0.0.1:8090"+p, strings.NewReader(form.Encode()))
		r.Header.Set("Content-Type", "application/x-www-form-urlencoded")
		w := httptest.NewRecorder()
		h.ServeHTTP(w, r)
		var out map[string]string
		json.Unmarshal(w.Body.Bytes(), &out)
		return w.Code, out
	}
	if code, out := post("/mkdir", url.Values{"dir": {"/home/garden/"}}); code != 200 || out["dir"] != "home/garden" {
		t.Fatalf("mkdir: %d %v", code, out)
	}
	if code, _ := post("/mkdir", url.Values{"dir": {"home/garden"}}); code != http.StatusConflict {
		t.Errorf("mkdir twice: %d", code)
	}
	ix := app.vaults[0].ix
	dirs, _ := ix.Facets(false)
	var names []string
	for _, d := range dirs {
		names = append(names, d.Name)
	}
	if strings.Join(names, " ") != "home home/garden work work/infra" {
		t.Errorf("empty folders are listed too: %v", names)
	}
	for _, d := range dirs {
		if want := map[string]int{"work/infra": 1}[d.Name]; d.N != want {
			t.Errorf("%s counts %d, not only its own notes", d.Name, d.N)
		}
	}

	for _, bad := range []string{"work", "work/infra/deeper"} {
		if code, _ := post("/movedir", url.Values{"path": {"work"}, "dir": {bad}}); code != http.StatusBadRequest {
			t.Errorf("into itself (%s): %d", bad, code)
		}
	}
	if code, out := post("/movedir", url.Values{"path": {"work/infra"}, "dir": {"home"}}); code != 200 || out["path"] != "home/infra" {
		t.Fatalf("movedir: %d %v", code, out)
	}
	if ix.Get("home/infra/a.md") == nil || ix.Get("work/infra/a.md") != nil {
		t.Error("the notes moved with the folder")
	}
	if code, out := post("/movedir", url.Values{"path": {"home/infra"}, "dir": {""}}); code != 200 || out["path"] != "infra" {
		t.Errorf("to the top: %d %v", code, out)
	}
	write(t, dir, "home/infra/x.md", "x")
	if code, _ := post("/movedir", url.Values{"path": {"infra"}, "dir": {"home"}}); code != http.StatusConflict {
		t.Errorf("onto a folder of the same name: %d", code)
	}
}

func TestHelpNote(t *testing.T) {
	dir := t.TempDir()
	app := testApp(t, dir)
	ix := app.vaults[0].ix
	if n := ix.Get(helpPath); n == nil || !n.Builtin {
		t.Fatal("every vault has the help note")
	}
	if hits, _ := ix.Search(ParseQuery("vault")); len(hits) != 1 {
		t.Error("the help note is found by searching")
	}
	h := app.routes()
	for p, form := range map[string]url.Values{
		"/delete": {"path": {helpPath}},
		"/move":   {"path": {helpPath}, "dir": {"x"}},
		"/save":   {"path": {helpPath}, "orig": {helpPath}, "body": {"mine"}},
	} {
		r := httptest.NewRequest("POST", "http://127.0.0.1:8090"+p, strings.NewReader(form.Encode()))
		r.Header.Set("Content-Type", "application/x-www-form-urlencoded")
		w := httptest.NewRecorder()
		h.ServeHTTP(w, r)
		if w.Code != http.StatusForbidden {
			t.Errorf("%s: %d", p, w.Code)
		}
	}
	if _, err := os.Stat(filepath.Join(dir, helpPath)); err == nil {
		t.Error("nothing is written for it")
	}
	// A note of the same name in the folder is the user's, and wins.
	write(t, dir, helpPath, "# Mine\n")
	ix.Refresh()
	if n := ix.Get(helpPath); n == nil || n.Builtin || n.Body != "# Mine\n" {
		t.Error("a real file hides the help note")
	}
}

func TestVaultsPage(t *testing.T) {
	one, two := t.TempDir(), t.TempDir()
	config := filepath.Join(t.TempDir(), "gonotes", "vaults.json")
	app, err := NewApp(parseDirs([]string{"first=" + one}), config)
	if err != nil {
		t.Fatal(err)
	}
	if err := app.save(); err != nil {
		t.Fatal(err)
	}
	h := app.routes()
	post := func(form url.Values) *httptest.ResponseRecorder {
		r := httptest.NewRequest("POST", "http://127.0.0.1:8090/vaults", strings.NewReader(form.Encode()))
		r.Header.Set("Content-Type", "application/x-www-form-urlencoded")
		w := httptest.NewRecorder()
		h.ServeHTTP(w, r)
		return w
	}
	w := httptest.NewRecorder()
	h.ServeHTTP(w, httptest.NewRequest("GET", "http://127.0.0.1:8090/vaults", nil))
	if w.Code != 200 || !strings.Contains(w.Body.String(), `name="dir-0"`) {
		t.Fatalf("page: %d", w.Code)
	}

	// Rename the first, add a second with its own gradient, then put it first.
	w = post(url.Values{"count": {"1"}, "orig-0": {"first"}, "name-0": {"renamed"}, "dir-0": {one}, "hue-0": {"10"}, "hue2-0": {"20"},
		"name-new": {"second"}, "dir-new": {two}, "hue-new": {"100"}, "hue2-new": {"200"}})
	if w.Code != http.StatusSeeOther {
		t.Fatalf("save: %d %s", w.Code, w.Body)
	}
	if c := w.Result().Cookies(); len(c) != 1 || c[0].Value != "renamed" {
		t.Errorf("a renamed vault stays the one in view: %v", c)
	}
	vs := app.all()
	if len(vs) != 2 || vs[0].Name != "renamed" || vs[1].Name != "second" || vs[1].Hue != 100 || vs[1].Hue2 != 200 {
		t.Fatalf("vaults: %+v %+v", vs[0], vs[1])
	}
	post(url.Values{"count": {"2"}, "move": {"down-0"},
		"orig-0": {"renamed"}, "name-0": {"renamed"}, "dir-0": {one}, "hue-0": {"10"}, "hue2-0": {"20"},
		"orig-1": {"second"}, "name-1": {"second"}, "dir-1": {two}, "hue-1": {"100"}, "hue2-1": {"200"}})
	if app.all()[0].Name != "second" {
		t.Error("moved down")
	}

	// It is all in the file, for the next start.
	confs, err := loadConfig(config)
	if err != nil || len(confs) != 2 || confs[0].Name != "second" || confs[1].Gradient[0] != 10 {
		t.Fatalf("config: %v %v", confs, err)
	}

	// Refused: the same name twice, and none left.
	if w := post(url.Values{"count": {"2"},
		"orig-0": {"second"}, "name-0": {"x"}, "dir-0": {two},
		"orig-1": {"renamed"}, "name-1": {"X"}, "dir-1": {one}}); w.Code != http.StatusBadRequest {
		t.Errorf("same name: %d", w.Code)
	}
	if w := post(url.Values{"count": {"1"}, "orig-0": {"second"}, "name-0": {"second"}, "dir-0": {two}, "remove-0": {"1"}}); w.Code != http.StatusBadRequest {
		t.Errorf("no vault left: %d", w.Code)
	}
	if len(app.all()) != 2 {
		t.Error("a refused save changes nothing")
	}
}

func TestUpload(t *testing.T) {
	dir := t.TempDir()
	write(t, dir, "trips/rome.md", "# Rome\n")
	app := testApp(t, dir)
	h := app.routes()
	up := func(note, name, body string) (int, string) {
		var b strings.Builder
		mw := multipart.NewWriter(&b)
		mw.WriteField("note", note)
		fw, _ := mw.CreateFormFile("file", name)
		fw.Write([]byte(body))
		mw.Close()
		r := httptest.NewRequest("POST", "http://127.0.0.1:8090/upload", strings.NewReader(b.String()))
		r.Header.Set("Content-Type", mw.FormDataContentType())
		w := httptest.NewRecorder()
		h.ServeHTTP(w, r)
		var out map[string]string
		json.Unmarshal(w.Body.Bytes(), &out)
		return w.Code, out["name"]
	}
	code, name := up("trips/rome.md", "Colosseum at night (1).JPG", "one")
	if code != 200 || name != "media/Colosseum-at-night-1.JPG" {
		t.Fatalf("upload: %d %q", code, name)
	}
	if b, _ := os.ReadFile(filepath.Join(dir, "trips", name)); string(b) != "one" {
		t.Errorf("stored in media/ beside the note: %q", b)
	}
	if _, again := up("trips/rome.md", "Colosseum at night (1).JPG", "two"); again == name || !strings.HasSuffix(again, "-2.JPG") {
		t.Errorf("a second upload of the name gets its own: %q", again)
	}
	if code, _ := up(helpPath, "x.png", "x"); code != http.StatusForbidden {
		t.Errorf("not into the help note: %d", code)
	}
	// A path out of the vault is held inside it, as everywhere.
	up("../../x.md", "../../escape.png", "x")
	if _, err := os.Stat(filepath.Join(dir, "media", "escape.png")); err != nil {
		t.Errorf("kept in the vault: %v", err)
	}
}

func TestIncludeSubfolders(t *testing.T) {
	dir := t.TempDir()
	write(t, dir, "work/a.md", "# A\n")
	write(t, dir, "work/old/b.md", "# B\n")
	app := testApp(t, dir)
	h := app.routes()
	get := func(u string, sub bool) string {
		r := httptest.NewRequest("GET", "http://127.0.0.1:8090"+u, nil)
		if sub {
			r.AddCookie(&http.Cookie{Name: "subfolders", Value: "1"})
		}
		w := httptest.NewRecorder()
		h.ServeHTTP(w, r)
		return w.Body.String()
	}
	if b := get("/?q=in:work", false); !strings.Contains(b, `data-path="work/a.md"`) || strings.Contains(b, `data-path="work/old/b.md"`) {
		t.Error("off: only the folder's own notes")
	}
	if b := get("/?q=in:work", true); !strings.Contains(b, `data-path="work/old/b.md"`) {
		t.Error("on: its subfolders too")
	}
	count := func(sub bool) int {
		dirs, _ := app.vaults[0].ix.Facets(sub)
		for _, d := range dirs {
			if d.Name == "work" {
				return d.N
			}
		}
		return -1
	}
	if count(false) != 1 || count(true) != 2 {
		t.Errorf("counts: %d own, %d with subfolders", count(false), count(true))
	}
}

func TestBrowseFolders(t *testing.T) {
	dir := t.TempDir()
	for _, d := range []string{"notes", "Archive", ".hidden"} {
		os.MkdirAll(filepath.Join(dir, d), 0o755)
	}
	write(t, dir, "file.md", "x")
	os.Symlink(filepath.Join(dir, "notes"), filepath.Join(dir, "link"))
	app := testApp(t, t.TempDir())
	w := httptest.NewRecorder()
	app.routes().ServeHTTP(w, httptest.NewRequest("GET", "http://127.0.0.1:8090/browse?dir="+url.QueryEscape(dir), nil))
	var out struct {
		Dir, Parent string
		Dirs        []string
	}
	if err := json.Unmarshal(w.Body.Bytes(), &out); err != nil {
		t.Fatalf("%d %s", w.Code, w.Body)
	}
	if strings.Join(out.Dirs, " ") != "Archive link notes" || out.Parent == "" {
		t.Errorf("folders, links to folders too, no dot-folders or files: %+v", out)
	}
	w = httptest.NewRecorder()
	app.routes().ServeHTTP(w, httptest.NewRequest("GET", "http://127.0.0.1:8090/browse?dir="+url.QueryEscape(filepath.Join(dir, "missing")), nil))
	if w.Code != http.StatusBadRequest {
		t.Errorf("missing folder: %d", w.Code)
	}
}

func TestFirstStart(t *testing.T) {
	config := filepath.Join(t.TempDir(), "vaults.json")
	app, err := NewApp(nil, config)
	if err != nil {
		t.Fatal(err)
	}
	h := app.routes()
	w := httptest.NewRecorder()
	h.ServeHTTP(w, httptest.NewRequest("GET", "http://127.0.0.1:8090/", nil))
	if w.Header().Get("Location") != "/welcome" {
		t.Fatalf("no vault yet goes to the welcome page: %d %s", w.Code, w.Header().Get("Location"))
	}
	w = httptest.NewRecorder()
	h.ServeHTTP(w, httptest.NewRequest("GET", "http://127.0.0.1:8090/welcome", nil))
	if w.Code != 200 || !strings.Contains(w.Body.String(), `name="dir-new"`) || !strings.Contains(w.Body.String(), "data-browse") {
		t.Fatalf("welcome: %d", w.Code)
	}
	post := func(form url.Values) *httptest.ResponseRecorder {
		r := httptest.NewRequest("POST", "http://127.0.0.1:8090/welcome", strings.NewReader(form.Encode()))
		r.Header.Set("Content-Type", "application/x-www-form-urlencoded")
		w := httptest.NewRecorder()
		h.ServeHTTP(w, r)
		return w
	}
	if w := post(url.Values{"dir-new": {""}}); w.Code != http.StatusBadRequest {
		t.Errorf("no folder: %d", w.Code)
	}
	notes := filepath.Join(t.TempDir(), "my notes")
	w = post(url.Values{"dir-new": {notes}, "name-new": {"Mine"}})
	if w.Header().Get("Location") != "/?tour=1" || len(app.all()) != 1 || app.all()[0].Name != "Mine" {
		t.Fatalf("first vault: %d %s", w.Code, w.Header().Get("Location"))
	}
	if _, err := os.Stat(notes); err != nil {
		t.Error("the folder is made")
	}
	if confs, err := loadConfig(config); err != nil || len(confs) != 1 {
		t.Errorf("kept: %v %v", confs, err)
	}
}

func TestMissingVault(t *testing.T) {
	here, drive := t.TempDir(), filepath.Join(t.TempDir(), "unplugged")
	write(t, here, "a.md", "a")
	app, err := NewApp(parseDirs([]string{"here=" + here, "drive=" + drive}), "")
	if err != nil {
		t.Fatalf("a missing folder does not stop the start: %v", err)
	}
	if _, err := os.Stat(drive); err == nil {
		t.Fatal("nothing is made where the drive goes")
	}
	h := app.routes()
	get := func(u string) *httptest.ResponseRecorder {
		r := httptest.NewRequest("GET", "http://127.0.0.1:8090"+u, nil)
		r.AddCookie(&http.Cookie{Name: "vault", Value: "drive"})
		w := httptest.NewRecorder()
		h.ServeHTTP(w, r)
		return w
	}
	if w := get("/"); w.Code != http.StatusServiceUnavailable || !strings.Contains(w.Body.String(), "is not there") || !strings.Contains(w.Body.String(), `href="/vault/here"`) {
		t.Errorf("message: %d", w.Code)
	}
	if w := get("/vaults"); w.Code != 200 {
		t.Errorf("the Vaults page still opens: %d", w.Code)
	}
	// Plugged in again: it opens.
	write(t, drive, "b.md", "b")
	if w := get("/"); w.Code != 200 || !strings.Contains(w.Body.String(), `data-path="b.md"`) {
		t.Errorf("back: %d", w.Code)
	}
}

func TestRenameFolder(t *testing.T) {
	dir := t.TempDir()
	write(t, dir, "work/old/a.md", "a")
	write(t, dir, "work/taken/b.md", "b")
	app := testApp(t, dir)
	h := app.routes()
	post := func(form url.Values) (int, map[string]string) {
		r := httptest.NewRequest("POST", "http://127.0.0.1:8090/renamedir", strings.NewReader(form.Encode()))
		r.Header.Set("Content-Type", "application/x-www-form-urlencoded")
		w := httptest.NewRecorder()
		h.ServeHTTP(w, r)
		var out map[string]string
		json.Unmarshal(w.Body.Bytes(), &out)
		return w.Code, out
	}
	if code, out := post(url.Values{"path": {"work/old"}, "name": {"Archive 2024"}}); code != 200 || out["path"] != "work/Archive 2024" {
		t.Fatalf("rename: %d %v", code, out)
	}
	if app.vaults[0].ix.Get("work/Archive 2024/a.md") == nil {
		t.Error("its notes go with it")
	}
	for name, want := range map[string]int{"taken": http.StatusConflict, "a/b": http.StatusBadRequest, ".hidden": http.StatusBadRequest, " ": http.StatusBadRequest} {
		if code, _ := post(url.Values{"path": {"work/Archive 2024"}, "name": {name}}); code != want {
			t.Errorf("%q: %d, want %d", name, code, want)
		}
	}
}

func TestExcludeFromSearch(t *testing.T) {
	dir := t.TempDir()
	write(t, dir, "work/plan.md", "the plan")
	write(t, dir, "archive/old plan.md", "the plan")
	write(t, dir, "archive/2020/older plan.md", "the plan")
	app := testApp(t, dir)
	h := app.routes()
	post := func(p string, form url.Values) int {
		r := httptest.NewRequest("POST", "http://127.0.0.1:8090"+p, strings.NewReader(form.Encode()))
		r.Header.Set("Content-Type", "application/x-www-form-urlencoded")
		w := httptest.NewRecorder()
		h.ServeHTTP(w, r)
		return w.Code
	}
	get := func(q string) string {
		w := httptest.NewRecorder()
		h.ServeHTTP(w, httptest.NewRequest("GET", "http://127.0.0.1:8090/?q="+url.QueryEscape(q), nil))
		return w.Body.String()
	}
	if post("/exclude", url.Values{"dir": {"archive"}, "on": {"1"}}) != http.StatusNoContent {
		t.Fatal("exclude")
	}
	if b := get("plan"); !strings.Contains(b, `data-path="work/plan.md"`) || strings.Contains(b, `data-path="archive/`) {
		t.Error("left out of searches, its subfolders too")
	}
	if b := get("plan in:archive"); !strings.Contains(b, `data-path="archive/old plan.md"`) {
		t.Error("picked, it shows")
	}
	if b := get("plan in:archive/2020"); !strings.Contains(b, `data-path="archive/2020/older plan.md"`) {
		t.Error("a folder in it, picked, shows")
	}
	if b := get(""); !strings.Contains(b, `class="excluded"`) {
		t.Error("grey in the sidebar")
	}
	// It goes where the folder goes.
	post("/renamedir", url.Values{"path": {"archive"}, "name": {"Archiv"}})
	if ex := app.vaults[0].Excluded(); len(ex) != 1 || ex[0] != "Archiv" {
		t.Errorf("after rename: %v", ex)
	}
	post("/exclude", url.Values{"dir": {"Archiv"}})
	if b := get("plan"); !strings.Contains(b, `data-path="Archiv/`) {
		t.Error("searched again")
	}
}

func TestDeleteFolder(t *testing.T) {
	dir := t.TempDir()
	write(t, dir, "old/a.md", "a")
	write(t, dir, "old/deeper/b.md", "b")
	app := testApp(t, dir)
	h := app.routes()
	post := func(p string, form url.Values) (int, map[string]string) {
		r := httptest.NewRequest("POST", "http://127.0.0.1:8090"+p, strings.NewReader(form.Encode()))
		r.Header.Set("Content-Type", "application/x-www-form-urlencoded")
		r.Header.Set("Accept", "application/json")
		w := httptest.NewRecorder()
		h.ServeHTTP(w, r)
		var out map[string]string
		json.Unmarshal(w.Body.Bytes(), &out)
		return w.Code, out
	}
	code, out := post("/delete", url.Values{"path": {"old"}})
	if code != 200 || !strings.HasPrefix(out["trash"], ".trash/old.") {
		t.Fatalf("delete folder: %d %v", code, out)
	}
	if ix := app.vaults[0].ix; ix.Get("old/a.md") != nil || ix.Get("old/deeper/b.md") != nil {
		t.Error("its notes are gone with it")
	}
	if code, _ := post("/restore", url.Values{"trash": {out["trash"]}, "path": {"old"}}); code != 200 {
		t.Fatalf("restore: %d", code)
	}
	if app.vaults[0].ix.Get("old/deeper/b.md") == nil {
		t.Error("all of it is back")
	}
	write(t, dir, "old/deeper/scan.pdf", "%PDF")
	if code, _ := post("/delete", url.Values{"path": {"old"}}); code != 409 {
		t.Errorf("a folder with a file that is no note: %d, want 409", code)
	}
	if app.vaults[0].ix.Get("old/a.md") == nil {
		t.Error("its notes went with it")
	}
}

func TestDiscardEmpty(t *testing.T) {
	dir := t.TempDir()
	write(t, dir, "new.md", " \n\n")
	write(t, dir, "kept.md", "a word")
	app := testApp(t, dir)
	h := app.routes()
	discard := func(p string) int {
		r := httptest.NewRequest("POST", "http://127.0.0.1:8090/discard", strings.NewReader(url.Values{"path": {p}}.Encode()))
		r.Header.Set("Content-Type", "application/x-www-form-urlencoded")
		w := httptest.NewRecorder()
		h.ServeHTTP(w, r)
		return w.Code
	}
	if discard("new.md") != http.StatusNoContent || app.vaults[0].ix.Get("new.md") != nil {
		t.Error("an empty note goes")
	}
	if discard("kept.md") != http.StatusConflict {
		t.Error("a note with words stays")
	}
	if _, err := os.Stat(filepath.Join(dir, "kept.md")); err != nil {
		t.Error("kept.md is still there")
	}
}

func TestDefaultFolder(t *testing.T) {
	dir := t.TempDir()
	write(t, dir, "Inbox/x.md", "x")
	app := testApp(t, dir)
	h := app.routes()
	post := func(p string, form url.Values) *httptest.ResponseRecorder {
		r := httptest.NewRequest("POST", "http://127.0.0.1:8090"+p, strings.NewReader(form.Encode()))
		r.Header.Set("Content-Type", "application/x-www-form-urlencoded")
		w := httptest.NewRecorder()
		h.ServeHTTP(w, r)
		return w
	}
	if w := post("/newdir", url.Values{"dir": {"Inbox"}}); w.Code != http.StatusNoContent {
		t.Fatalf("set: %d", w.Code)
	}
	if loc := post("/new", url.Values{"from": {"Idea"}}).Header().Get("Location"); loc != "/?open="+url.QueryEscape("Inbox/Idea.md") {
		t.Errorf("into the default folder: %s", loc)
	}
	if loc := post("/new", url.Values{"from": {"Plan in:Elsewhere"}}).Header().Get("Location"); !strings.Contains(loc, url.QueryEscape("Elsewhere/Plan.md")) {
		t.Errorf("in: still wins: %s", loc)
	}
	post("/renamedir", url.Values{"path": {"Inbox"}, "name": {"Eingang"}})
	if got := app.vaults[0].NewDir(); got != "Eingang" {
		t.Errorf("follows a rename: %q", got)
	}
}

func TestInstallable(t *testing.T) {
	h := testApp(t, t.TempDir()).routes()
	for path, want := range map[string]string{"/sw.js": "serviceWorker", "/static/manifest.webmanifest": `"display": "standalone"`} {
		w := httptest.NewRecorder()
		h.ServeHTTP(w, httptest.NewRequest("GET", "http://127.0.0.1:8090"+path, nil))
		if w.Code != 200 || (path == "/static/manifest.webmanifest" && !strings.Contains(w.Body.String(), want)) {
			t.Errorf("%s: %d", path, w.Code)
		}
	}
	w := httptest.NewRecorder()
	h.ServeHTTP(w, httptest.NewRequest("GET", "http://127.0.0.1:8090/static/icon-512.png", nil))
	if w.Code != 200 || w.Header().Get("Content-Type") != "image/png" {
		t.Errorf("icon: %d %s", w.Code, w.Header().Get("Content-Type"))
	}
}

func TestTagsFollowResults(t *testing.T) {
	dir := t.TempDir()
	write(t, dir, "a.md", "#install #debugging")
	write(t, dir, "b.md", "#install")
	write(t, dir, "c.md", "#open")
	write(t, dir, "archive/d.md", "#old")
	app := testApp(t, dir)
	ix := app.vaults[0].ix
	names := func(q Query) string {
		var out []string
		for _, c := range ix.TagCounts(q) {
			out = append(out, fmt.Sprintf("%s:%d", c.Name, c.N))
		}
		return strings.Join(out, " ")
	}
	if got := names(ParseQuery("#install")); got != "install:2 debugging:1" {
		t.Errorf("with a tag: %q", got)
	}
	q := ParseQuery("")
	q.Exclude = []string{"archive"}
	if got := names(q); strings.Contains(got, "old") {
		t.Errorf("none from folders left out: %q", got)
	}
}

func TestNothingHereButElsewhere(t *testing.T) {
	dir := t.TempDir()
	write(t, dir, "zz Archiv/2020/old.md", "#debugging")
	app := testApp(t, dir)
	app.vaults[0].exclude = []string{"zz Archiv"}
	w := httptest.NewRecorder()
	app.routes().ServeHTTP(w, httptest.NewRequest("GET", "http://127.0.0.1:8090/?q="+url.QueryEscape("#debugging"), nil))
	b := w.Body.String()
	if !strings.Contains(b, "Nothing matches") || !strings.Contains(b, "zz Archiv/2020") || !strings.Contains(b, "left out of searches") {
		t.Errorf("says where it would match")
	}
	w = httptest.NewRecorder()
	app.routes().ServeHTTP(w, httptest.NewRequest("GET", "http://127.0.0.1:8090/?q="+url.QueryEscape(`#debugging "in:zz Archiv/2020"`), nil))
	if !strings.Contains(w.Body.String(), `data-path="zz Archiv/2020/old.md"`) {
		t.Error("its link finds it")
	}
}

func TestTopLevel(t *testing.T) {
	dir := t.TempDir()
	write(t, dir, "top.md", "plan")
	write(t, dir, "work/deep.md", "plan")
	app := testApp(t, dir)
	hits, _ := app.vaults[0].ix.Search(ParseQuery("plan in:/"))
	if len(hits) != 1 || hits[0].Path != "top.md" {
		t.Errorf("only the top: %v", hits)
	}
	q := ParseQuery("plan in:/")
	q.Sub = true
	if hits, _ := app.vaults[0].ix.Search(q); len(hits) != 1 {
		t.Errorf("not its folders, subfolders setting or not: %d", len(hits))
	}
	if n := app.vaults[0].ix.TopLevel(); n != 1 {
		t.Errorf("top count %d", n)
	}
}

func TestAttachmentFoldersHidden(t *testing.T) {
	dir := t.TempDir()
	write(t, dir, "trips/rome.md", "![x](media/x.png)")
	write(t, dir, "trips/media/x.png", "png")
	write(t, dir, "media/top.png", "png")
	write(t, dir, "page_files/style.css", "css")
	write(t, dir, "mixed/a.md", "a")
	write(t, dir, "mixed/b.png", "png")
	os.MkdirAll(filepath.Join(dir, "empty"), 0o755)
	app := testApp(t, dir)
	dirs, _ := app.vaults[0].ix.Facets(false)
	var names []string
	for _, d := range dirs {
		names = append(names, d.Name)
	}
	if got := strings.Join(names, " "); got != "empty mixed trips" {
		t.Errorf("folders %q", got)
	}
	w := httptest.NewRecorder()
	app.routes().ServeHTTP(w, httptest.NewRequest("GET", "http://127.0.0.1:8090/n/trips/media/x.png", nil))
	if w.Code != 200 {
		t.Errorf("its images are still served: %d", w.Code)
	}
}
