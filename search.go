package main

import (
	"html"
	"html/template"
	"regexp"
	"sort"
	"strings"
	"unicode/utf8"
)

// Query is what the search box holds. Everything is in the one string, so a
// search is a URL: words and "quoted phrases" must all match, -word must not,
// #tag and in:folder narrow, and sort:title orders by name instead of age.
type Query struct {
	Raw     string
	Terms   []string
	Not     []string
	Tags    []string
	In      []string
	ByTitle bool
	Sub     bool     // in:folder takes in its subfolders too; a setting, not typed
	Exclude []string // folders left out of searches, lowercased; the vault's setting
}

func ParseQuery(raw string) Query {
	q := Query{Raw: raw}
	for _, tok := range tokenize(raw) {
		low := strings.ToLower(tok)
		switch {
		case strings.HasPrefix(low, "#") && len(low) > 1:
			q.Tags = append(q.Tags, low[1:])
		case strings.HasPrefix(low, "in:") && len(low) > 3:
			q.In = append(q.In, strings.Trim(low[3:], "/")) // in:/ is "": the top level
		case low == "sort:title":
			q.ByTitle = true
		case strings.HasPrefix(low, "-") && len(low) > 1:
			q.Not = append(q.Not, low[1:])
		default:
			q.Terms = append(q.Terms, low)
		}
	}
	return q
}

func tokenize(s string) []string {
	var out []string
	var b strings.Builder
	quoted := false
	flush := func() {
		if b.Len() > 0 {
			out = append(out, b.String())
			b.Reset()
		}
	}
	for _, r := range s {
		switch {
		case r == '"':
			if quoted {
				flush()
			}
			quoted = !quoted
		case !quoted && (r == ' ' || r == '\t'):
			flush()
		default:
			b.WriteRune(r)
		}
	}
	flush()
	return out
}

// Has reports whether the query already carries this filter token, so the
// sidebar can show it as switched on.
func (q Query) Has(tok string) bool {
	tok = strings.ToLower(tok)
	for _, t := range tokenize(q.Raw) {
		if strings.ToLower(t) == tok {
			return true
		}
	}
	return false
}

// Toggle adds the filter token or takes it out again. A folder replaces the
// one picked before, since a note is in only one.
func (q Query) Toggle(tok string) string {
	var kept, folders []string
	found := false
	for _, t := range tokenize(q.Raw) {
		if strings.EqualFold(t, tok) {
			found = true
			continue
		}
		if isFolderTok(tok) && isFolderTok(t) {
			folders = append(folders, quoteTok(t))
			continue
		}
		kept = append(kept, quoteTok(t))
	}
	if found {
		kept = append(kept, folders...)
	}
	if !found {
		kept = append(kept, quoteTok(tok))
	}
	return strings.Join(kept, " ")
}

func isFolderTok(t string) bool { return len(t) > 3 && strings.EqualFold(t[:3], "in:") }

// Box is the query as the search box shows it: after a folder or a tag a
// space, so what is typed next is a word of its own.
func (q Query) Box() string {
	toks := tokenize(q.Raw)
	if n := len(toks); n > 0 && (isFolderTok(toks[n-1]) || strings.HasPrefix(toks[n-1], "#")) {
		return strings.TrimRight(q.Raw, " ") + " "
	}
	return q.Raw
}

// Pick picks a folder: added when it is not picked yet, kept when it is.
// Clicking the folder in view again leaves it in view; All notes lets go.
func (q Query) Pick(tok string) string {
	if q.Has(tok) {
		return q.Raw
	}
	return q.Toggle(tok)
}

// quoteTok keeps a token with spaces in it, like in:My Folder, as one token.
func quoteTok(t string) string {
	if strings.ContainsAny(t, " \t") {
		return `"` + t + `"`
	}
	return t
}

// noteFromQuery turns a search that found nothing into the note it was
// looking for: the words are its title, in:folder its folder, #tags its tags.
func noteFromQuery(raw string) (title, dir string, tags []string) {
	var words []string
	for _, t := range tokenize(raw) {
		low := strings.ToLower(t)
		switch {
		case strings.HasPrefix(t, "#") && len(t) > 1:
			tags = append(tags, t[1:])
		case strings.HasPrefix(low, "in:") && len(t) > 3:
			if dir == "" {
				dir = strings.Trim(t[3:], "/")
			}
		case low == "sort:title", strings.HasPrefix(t, "-"):
		default:
			words = append(words, t)
		}
	}
	return strings.Join(words, " "), dir, tags
}

// fileName is a title made safe to be a file name: no folders hiding in it,
// not hidden.
func fileName(title string) string {
	n := strings.Map(func(r rune) rune {
		if r == '/' || r == '\\' || r < ' ' {
			return '-'
		}
		return r
	}, title)
	n = strings.TrimLeft(strings.TrimSpace(n), ".")
	if n == "" {
		return "untitled"
	}
	return n
}

type Hit struct {
	*Note
	Score   int
	Snippet template.HTML
}

const maxHits = 300

// Search returns matching notes and how many matched before the cap.
func (ix *Index) Search(q Query) ([]Hit, int) {
	ix.mu.RLock()
	var hits []Hit
	for _, n := range ix.notes {
		if s, ok := q.match(n); ok {
			hits = append(hits, Hit{Note: n, Score: s})
		}
	}
	ix.mu.RUnlock()

	sort.Slice(hits, func(i, j int) bool {
		a, b := hits[i], hits[j]
		if q.ByTitle {
			return a.lowerTitle < b.lowerTitle
		}
		if a.Score != b.Score {
			return a.Score > b.Score
		}
		return a.Mod.After(b.Mod)
	})
	total := len(hits)
	if len(hits) > maxHits {
		hits = hits[:maxHits]
	}
	for i := range hits {
		hits[i].Snippet = snippet(withoutTitle(hits[i].BodyWithoutFrontMatter()), q.Terms)
	}
	return hits, total
}

func (q Query) match(n *Note) (int, bool) {
	dir := strings.ToLower(n.Dir())
	// A folder left out of searches, and what is in it, shows only when it
	// is the folder picked, or one in it is.
	for _, e := range q.Exclude {
		if dir != e && !strings.HasPrefix(dir, e+"/") {
			continue
		}
		picked := false
		for _, d := range q.In {
			picked = picked || d == e || strings.HasPrefix(d, e+"/")
		}
		if !picked {
			return 0, false
		}
	}
	// in:folder is that folder's own notes, or with Sub its subfolders' too;
	// in:/ the vault's own folder's, never with its folders.
	for _, d := range q.In {
		if d == "" {
			if dir != "" {
				return 0, false
			}
			continue
		}
		if dir != d && !(q.Sub && strings.HasPrefix(dir, d+"/")) {
			return 0, false
		}
	}
	for _, t := range q.Tags {
		ok := false
		for _, nt := range n.Tags {
			if nt == t || strings.HasPrefix(nt, t+"/") {
				ok = true
				break
			}
		}
		if !ok {
			return 0, false
		}
	}
	for _, t := range q.Not {
		if strings.Contains(n.lower, t) {
			return 0, false
		}
	}
	score := 0
	for _, t := range q.Terms {
		c := strings.Count(n.lower, t)
		if c == 0 {
			return 0, false
		}
		if strings.Contains(n.lowerTitle, t) {
			score += 20
			if strings.HasPrefix(n.lowerTitle, t) {
				score += 10
			}
		}
		if strings.Contains(n.lowerPath, t) {
			score += 5
		}
		score += min(c, 10)
	}
	return score, true
}

// A row has room for one line after the title, so the snippet starts a few
// words before the first match to keep the match itself in view.
const (
	snippetLen  = 160
	snippetLead = 24
)

// snippet is the note's text after its title, cut around the first match
// with every term marked. With no terms it is just the opening of the note.
func snippet(body string, terms []string) template.HTML {
	text := strings.Join(strings.Fields(stripMarkdown(body)), " ")
	if len(terms) == 0 {
		return template.HTML(html.EscapeString(cut(text, 0, snippetLen)))
	}
	alts := make([]string, len(terms))
	for i, t := range terms {
		alts[i] = regexp.QuoteMeta(t)
	}
	re := regexp.MustCompile(`(?i)` + strings.Join(alts, "|"))

	start := 0
	if loc := re.FindStringIndex(text); loc != nil && loc[0] > snippetLead {
		start = loc[0] - snippetLead
		// Begin at a whole word rather than halfway into one.
		if sp := strings.IndexByte(text[start:loc[0]], ' '); sp >= 0 {
			start += sp + 1
		} else {
			start = loc[0]
		}
	}
	s := cut(text, start, snippetLen)

	var b strings.Builder
	last := 0
	for _, m := range re.FindAllStringIndex(s, -1) {
		b.WriteString(html.EscapeString(s[last:m[0]]))
		b.WriteString("<mark>")
		b.WriteString(html.EscapeString(s[m[0]:m[1]]))
		b.WriteString("</mark>")
		last = m[1]
	}
	b.WriteString(html.EscapeString(s[last:]))
	return template.HTML(b.String())
}

func cut(s string, start, n int) string {
	prefix := ""
	if start > 0 {
		prefix = "…"
	}
	s = s[start:]
	if utf8.RuneCountInString(s) <= n {
		return prefix + s
	}
	return prefix + string([]rune(s)[:n]) + "…"
}

var (
	mdBlock  = regexp.MustCompile("(?m)^\\s*(#{1,6}\\s|[-*+]( \\[[ xX]\\])?|\\d+[.)]|>|\\|?[-:| ]{3,}\\|?$)\\s*|```\\w*")
	mdLink   = regexp.MustCompile(`!?\[([^\]]*)\]\([^)]*\)`)
	mdInline = regexp.MustCompile("[*_`]{1,3}|\\|")
)

// stripMarkdown leaves roughly the text a reader sees, for a snippet.
func stripMarkdown(s string) string {
	s = mdBlock.ReplaceAllString(s, " ")
	s = mdLink.ReplaceAllString(s, "$1")
	return mdInline.ReplaceAllString(s, "")
}

// withoutTitle drops a leading heading: the row shows the title already.
func withoutTitle(body string) string {
	trimmed := strings.TrimLeft(body, " \t\r\n")
	if strings.HasPrefix(trimmed, "# ") {
		if _, rest, ok := strings.Cut(trimmed, "\n"); ok {
			return rest
		}
		return ""
	}
	return body
}
