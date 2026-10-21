package supervisor

import (
	"database/sql"
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"sync"
	"time"

	"homelab/agent/internal/protocol"
	_ "modernc.org/sqlite"
)

var ErrConflict = errors.New("operation_hash_conflict")
var ErrFence = errors.New("stale_fence_or_epoch")

type Record struct {
	Request   protocol.Request
	Receipt   protocol.Receipt
	Container string
	Deadline  time.Time
}
type Log struct {
	Sequence  int64  `json:"sequence"`
	Stream    string `json:"stream"`
	Data      string `json:"data"`
	Truncated bool   `json:"truncated"`
}
type Journal struct {
	db *sql.DB
	mu sync.Mutex
}

func (j *Journal) DB() *sql.DB { return j.db }

func OpenJournal(path string) (*Journal, error) {
	if e := os.MkdirAll(filepath.Dir(path), 0700); e != nil {
		return nil, e
	}
	db, e := sql.Open("sqlite", path)
	if e != nil {
		return nil, e
	}
	db.SetMaxOpenConns(1)
	_, e = db.Exec(`PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA busy_timeout=5000;
 CREATE TABLE IF NOT EXISTS operations(id TEXT PRIMARY KEY,hash TEXT NOT NULL,job TEXT NOT NULL,request BLOB NOT NULL,receipt BLOB NOT NULL,container TEXT NOT NULL,deadline TEXT NOT NULL);
 CREATE TABLE IF NOT EXISTS fences(job TEXT PRIMARY KEY,epoch TEXT NOT NULL,fence INTEGER NOT NULL);
 CREATE TABLE IF NOT EXISTS sequence(n INTEGER NOT NULL); INSERT INTO sequence SELECT 0 WHERE NOT EXISTS(SELECT 1 FROM sequence);
	 CREATE TABLE IF NOT EXISTS logs(operation TEXT NOT NULL,seq INTEGER NOT NULL,stream TEXT NOT NULL,data BLOB NOT NULL,truncated INTEGER NOT NULL,PRIMARY KEY(operation,seq));
	 CREATE TABLE IF NOT EXISTS native_runtime(operation TEXT PRIMARY KEY,record BLOB NOT NULL);
	 CREATE TABLE IF NOT EXISTS job_budgets(job TEXT PRIMARY KEY,started_at TEXT NOT NULL,deadline TEXT NOT NULL,max_steps INTEGER NOT NULL);`)
	if e != nil {
		db.Close()
		return nil, e
	}
	return &Journal{db: db}, nil
}
func (j *Journal) Close() error { return j.db.Close() }
func scanRecord(row interface{ Scan(...any) error }) (Record, error) {
	var r Record
	var req, rec []byte
	var d string
	e := row.Scan(&req, &rec, &r.Container, &d)
	if e != nil {
		return r, e
	}
	if e = json.Unmarshal(req, &r.Request); e != nil {
		return r, e
	}
	if e = json.Unmarshal(rec, &r.Receipt); e != nil {
		return r, e
	}
	r.Deadline, e = time.Parse(time.RFC3339Nano, d)
	return r, e
}
func (j *Journal) Get(id string) (Record, error) {
	return scanRecord(j.db.QueryRow(`SELECT request,receipt,container,deadline FROM operations WHERE id=?`, id))
}
func (j *Journal) All() ([]Record, error) {
	rows, e := j.db.Query(`SELECT request,receipt,container,deadline FROM operations`)
	if e != nil {
		return nil, e
	}
	defer rows.Close()
	var rs []Record
	for rows.Next() {
		r, e := scanRecord(rows)
		if e != nil {
			return nil, e
		}
		rs = append(rs, r)
	}
	return rs, rows.Err()
}
func (j *Journal) Accept(r protocol.Request, boot, epoch string) (Record, bool, error) {
	j.mu.Lock()
	defer j.mu.Unlock()
	if r.DispatchEpoch != epoch {
		return Record{}, false, ErrFence
	}
	tx, e := j.db.Begin()
	if e != nil {
		return Record{}, false, e
	}
	defer tx.Rollback()
	var oldFence int64
	var oldEpoch string
	e = tx.QueryRow(`SELECT epoch,fence FROM fences WHERE job=?`, r.JobID).Scan(&oldEpoch, &oldFence)
	if e != nil && e != sql.ErrNoRows {
		return Record{}, false, e
	}
	if e == nil && (oldEpoch != epoch || oldFence > r.Fence) {
		return Record{}, false, ErrFence
	}
	_, e = tx.Exec(`INSERT INTO fences(job,epoch,fence)VALUES(?,?,?) ON CONFLICT(job)DO UPDATE SET fence=excluded.fence`, r.JobID, epoch, r.Fence)
	if e != nil {
		return Record{}, false, e
	}
	old, e := scanRecord(tx.QueryRow(`SELECT request,receipt,container,deadline FROM operations WHERE id=?`, r.OperationID))
	if e == nil {
		if old.Request.RequestHash != r.RequestHash {
			return Record{}, false, ErrConflict
		}
		if e = tx.Commit(); e != nil {
			return Record{}, false, e
		}
		return old, false, nil
	}
	if e != sql.ErrNoRows {
		return Record{}, false, e
	}
	var started, deadlineString string
	var maxSteps int
	e = tx.QueryRow(`SELECT started_at,deadline,max_steps FROM job_budgets WHERE job=?`, r.JobID).Scan(&started, &deadlineString, &maxSteps)
	now := time.Now()
	var jobDeadline time.Time
	if e == sql.ErrNoRows {
		started = now.UTC().Format(time.RFC3339Nano)
		jobDeadline = now.Add(time.Duration(r.Limits.WallTimeSeconds) * time.Second)
		maxSteps = r.Limits.MaxToolSteps
		if maxSteps < 1 {
			return Record{}, false, errors.New("invalid_step_limit")
		}
		if _, e = tx.Exec(`INSERT INTO job_budgets VALUES(?,?,?,?)`, r.JobID, started, jobDeadline.UTC().Format(time.RFC3339Nano), maxSteps); e != nil {
			return Record{}, false, e
		}
	} else if e != nil {
		return Record{}, false, e
	} else {
		jobDeadline, e = time.Parse(time.RFC3339Nano, deadlineString)
		if e != nil {
			return Record{}, false, e
		}
		originalStart, e := time.Parse(time.RFC3339Nano, started)
		if e != nil {
			return Record{}, false, e
		}
		restrictedDeadline := originalStart.Add(time.Duration(r.Limits.WallTimeSeconds) * time.Second)
		if restrictedDeadline.Before(jobDeadline) {
			jobDeadline = restrictedDeadline
		}
		maxSteps = min(maxSteps, r.Limits.MaxToolSteps)
		if _, e = tx.Exec(`UPDATE job_budgets SET deadline=?,max_steps=? WHERE job=?`, jobDeadline.UTC().Format(time.RFC3339Nano), maxSteps, r.JobID); e != nil {
			return Record{}, false, e
		}
	}
	if !jobDeadline.After(now) {
		return Record{}, false, errors.New("job_wall_time_exhausted")
	}
	var stepCount int
	if e = tx.QueryRow(`SELECT count(*) FROM operations WHERE job=?`, r.JobID).Scan(&stepCount); e != nil {
		return Record{}, false, e
	}
	if stepCount >= maxSteps {
		return Record{}, false, errors.New("job_tool_step_limit_exhausted")
	}
	var seq int64
	if e = tx.QueryRow(`UPDATE sequence SET n=n+1 RETURNING n`).Scan(&seq); e != nil {
		return Record{}, false, e
	}
	timeout := min(r.Limits.PerCommandTimeoutSeconds, r.Limits.WallTimeSeconds)
	rec := Record{Request: r, Receipt: protocol.Receipt{SchemaVersion: 1, OperationID: r.OperationID, RequestHash: r.RequestHash, MachineID: r.MachineID, HostSequence: seq, State: "received", ObservedAt: time.Now().UTC().Format(time.RFC3339Nano), BootID: boot}, Container: "hl-" + r.OperationID, Deadline: time.Now().Add(time.Duration(timeout) * time.Second)}
	if jobDeadline.Before(rec.Deadline) {
		rec.Deadline = jobDeadline
	}
	req, _ := json.Marshal(r)
	receipt, _ := json.Marshal(rec.Receipt)
	_, e = tx.Exec(`INSERT INTO operations VALUES(?,?,?,?,?,?,?)`, r.OperationID, r.RequestHash, r.JobID, req, receipt, rec.Container, rec.Deadline.Format(time.RFC3339Nano))
	if e != nil {
		return Record{}, false, e
	}
	e = tx.Commit()
	return rec, true, e
}
func (j *Journal) Update(r Record, state, reason string, code *int) (Record, error) {
	j.mu.Lock()
	defer j.mu.Unlock()
	tx, e := j.db.Begin()
	if e != nil {
		return r, e
	}
	defer tx.Rollback()
	if e = tx.QueryRow(`UPDATE sequence SET n=n+1 RETURNING n`).Scan(&r.Receipt.HostSequence); e != nil {
		return r, e
	}
	r.Receipt.State = state
	r.Receipt.ObservedAt = time.Now().UTC().Format(time.RFC3339Nano)
	r.Receipt.ExitCode = code
	if reason != "" {
		r.Receipt.Reason = &reason
	}
	b, _ := json.Marshal(r.Receipt)
	_, e = tx.Exec(`UPDATE operations SET receipt=? WHERE id=?`, b, r.Request.OperationID)
	if e != nil {
		return r, e
	}
	e = tx.Commit()
	return r, e
}
func (j *Journal) AppendLog(id, stream, data string, truncated bool) error {
	_, e := j.db.Exec(`INSERT INTO logs(operation,seq,stream,data,truncated) SELECT ?,COALESCE(MAX(seq),0)+1,?,?,? FROM logs WHERE operation=?`, id, stream, []byte(data), truncated, id)
	return e
}
func (j *Journal) Logs(id string, after int64) ([]Log, error) {
	rows, e := j.db.Query(`SELECT seq,stream,data,truncated FROM logs WHERE operation=? AND seq>? ORDER BY seq LIMIT 256`, id, after)
	if e != nil {
		return nil, e
	}
	defer rows.Close()
	logs := []Log{}
	for rows.Next() {
		var l Log
		if e = rows.Scan(&l.Sequence, &l.Stream, &l.Data, &l.Truncated); e != nil {
			return nil, e
		}
		logs = append(logs, l)
	}
	return logs, rows.Err()
}
func (j *Journal) CheckFence(r Record, fence int64, epoch string) error {
	j.mu.Lock()
	defer j.mu.Unlock()
	if fence < 1 {
		return ErrFence
	}
	result, e := j.db.Exec(`UPDATE fences SET fence=? WHERE job=? AND epoch=? AND fence<=?`, fence, r.Request.JobID, epoch, fence)
	if e != nil {
		return e
	}
	n, e := result.RowsAffected()
	if e != nil {
		return e
	}
	if n != 1 {
		return ErrFence
	}
	return nil
}
