package files

import (
	"fmt"
	"os"
	"path/filepath"
	"testing"
)

func TestPagedListingAndBoundedSearch(t *testing.T) {
	dir := t.TempDir()
	for i := 0; i < 1050; i++ {
		if e := os.WriteFile(filepath.Join(dir, fmt.Sprintf("file-%04d", i)), nil, 0600); e != nil {
			t.Fatal(e)
		}
	}
	if e := os.WriteFile(filepath.Join(dir, ".hidden"), nil, 0600); e != nil {
		t.Fatal(e)
	}
	r, e := Open(dir)
	if e != nil {
		t.Fatal(e)
	}
	defer r.Close()
	if _, e = r.List("."); e == nil {
		t.Fatal("legacy list silently truncated")
	}
	cursor := ""
	seen := map[string]bool{}
	for {
		page, e := r.ListPage(".", cursor, 113, true)
		if e != nil {
			t.Fatal(e)
		}
		for _, entry := range page.Items {
			if seen[entry.Path] {
				t.Fatal("duplicate cursor", entry)
			}
			seen[entry.Path] = true
		}
		if page.NextCursor == nil {
			break
		}
		cursor = *page.NextCursor
	}
	if len(seen) != 1051 {
		t.Fatal("lost entries", len(seen))
	}
	page, e := r.ListPage(".", "", 100, false)
	if e != nil {
		t.Fatal(e)
	}
	if page.Items[0].Path == ".hidden" {
		t.Fatal("hidden filter ignored")
	}
	found, e := r.Search(".", "file-", 10)
	if e != nil || !found.Truncated || len(found.Items) != 10 {
		t.Fatal(found, e)
	}
}
