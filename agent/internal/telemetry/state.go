package telemetry

import (
	"database/sql"
	_ "modernc.org/sqlite"
	"os"
	"path/filepath"
)

// SequenceStore persists before transmission, so restarting the connection agent
// cannot make a sample look like an old duplicate within the same host boot.
type SequenceStore struct{ db *sql.DB }

func OpenSequence(path string) (*SequenceStore, error) {
	if e := os.MkdirAll(filepath.Dir(path), 0700); e != nil {
		return nil, e
	}
	db, e := sql.Open("sqlite", path)
	if e != nil {
		return nil, e
	}
	db.SetMaxOpenConns(1)
	_, e = db.Exec(`PRAGMA journal_mode=WAL;PRAGMA synchronous=FULL;PRAGMA busy_timeout=5000;CREATE TABLE IF NOT EXISTS telemetry_sequence(id INTEGER PRIMARY KEY CHECK(id=1),n INTEGER NOT NULL);INSERT OR IGNORE INTO telemetry_sequence VALUES(1,0);`)
	if e != nil {
		db.Close()
		return nil, e
	}
	return &SequenceStore{db}, nil
}
func (s *SequenceStore) Next() (uint64, error) {
	var n uint64
	e := s.db.QueryRow(`UPDATE telemetry_sequence SET n=n+1 WHERE id=1 RETURNING n`).Scan(&n)
	return n, e
}
func (s *SequenceStore) Close() error { return s.db.Close() }
