package files

import (
	"errors"
	"io"
	"io/fs"
	"path"
	"sort"
	"strings"
	"time"
)

type Page struct {
	Items      []Entry `json:"items"`
	NextCursor *string `json:"next_cursor"`
}
type SearchPage struct {
	Items     []Entry `json:"items"`
	Truncated bool    `json:"truncated"`
	Scanned   int     `json:"scanned"`
}

func entryFor(p string, d fs.DirEntry) (Entry, error) {
	inf, e := d.Info()
	if e != nil {
		return Entry{}, e
	}
	kind := "file"
	if isReparse(inf) {
		kind = "symlink"
	} else if d.IsDir() {
		kind = "directory"
	} else if !inf.Mode().IsRegular() {
		kind = "special"
	}
	modified := inf.ModTime().UTC().Format(time.RFC3339Nano)
	return Entry{Path: p, Kind: kind, SizeBytes: inf.Size(), Mode: uint32(inf.Mode().Perm()), ModifiedAt: &modified}, nil
}

// ListPage refuses an overlarge directory rather than returning an incomplete list.
func (r *Root) ListPage(p, cursor string, limit int, hidden bool) (Page, error) {
	r.mu.Lock()
	defer r.mu.Unlock()
	out := Page{Items: []Entry{}}
	if limit < 1 || limit > 500 {
		return out, errors.New("invalid_page_limit")
	}
	if e := r.rejectLinks(p, false); e != nil {
		return out, e
	}
	if cursor != "" {
		if e := SafePath(cursor); e != nil {
			return out, e
		}
		if path.Dir(cursor) != p && !(p == "." && path.Dir(cursor) == ".") {
			return out, errors.New("invalid_page_cursor")
		}
	}
	f, e := r.root.Open(p)
	if e != nil {
		return out, e
	}
	defer f.Close()
	ds, e := f.ReadDir(100001)
	if e != nil && e != io.EOF {
		return out, e
	}
	if len(ds) > 100000 {
		return out, errors.New("listing_scan_limit_exceeded")
	}
	sort.Slice(ds, func(i, j int) bool { return ds[i].Name() < ds[j].Name() })
	for _, d := range ds {
		if !hidden && strings.HasPrefix(d.Name(), ".") {
			continue
		}
		full := path.Join(p, d.Name())
		if full <= cursor {
			continue
		}
		if len(out.Items) == limit {
			last := out.Items[len(out.Items)-1].Path
			out.NextCursor = &last
			break
		}
		entry, e := entryFor(full, d)
		if e != nil {
			return out, e
		}
		out.Items = append(out.Items, entry)
	}
	return out, nil
}
func (r *Root) Search(p, q string, limit int) (SearchPage, error) {
	r.mu.Lock()
	defer r.mu.Unlock()
	out := SearchPage{Items: []Entry{}}
	if q == "" || len(q) > 200 || limit < 1 || limit > 100 {
		return out, errors.New("invalid_search")
	}
	if e := r.rejectLinks(p, false); e != nil {
		return out, e
	}
	q = strings.ToLower(q)
	stop := errors.New("search_bounded_stop")
	e := fs.WalkDir(r.root.FS(), p, func(name string, d fs.DirEntry, e error) error {
		if e != nil {
			return e
		}
		out.Scanned++
		if out.Scanned > 100000 {
			out.Truncated = true
			return stop
		}
		if name == p {
			return nil
		}
		entry, e := entryFor(name, d)
		if e != nil {
			return e
		}
		if strings.Contains(strings.ToLower(name), q) {
			if len(out.Items) >= limit {
				out.Truncated = true
				return stop
			}
			out.Items = append(out.Items, entry)
		}
		if entry.Kind == "symlink" && d.IsDir() {
			return fs.SkipDir
		}
		return nil
	})
	if errors.Is(e, stop) {
		e = nil
	}
	return out, e
}
