package telemetry

import (
	"bytes"
	"context"
	"encoding/csv"
	"errors"
	"fmt"
	"math"
	"os/exec"
	"path/filepath"
	"runtime"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/shirou/gopsutil/v4/cpu"
	"github.com/shirou/gopsutil/v4/disk"
	"github.com/shirou/gopsutil/v4/host"
	"github.com/shirou/gopsutil/v4/mem"
	gnet "github.com/shirou/gopsutil/v4/net"
)

type Metric struct {
	Name         string   `json:"name"`
	DeviceID     string   `json:"device_id"`
	Value        *float64 `json:"value"`
	Unit         string   `json:"unit"`
	Availability string   `json:"availability"`
	Reason       *string  `json:"reason"`
	Source       string   `json:"source"`
	ObservedAt   string   `json:"observed_at"`
	Kind         string   `json:"kind"`
}
type Inventory struct {
	Hostname         string      `json:"hostname"`
	OS               string      `json:"os"`
	Platform         string      `json:"platform"`
	PlatformVersion  string      `json:"platform_version"`
	Architecture     string      `json:"architecture"`
	LogicalCores     int         `json:"logical_cores"`
	AgentVersion     string      `json:"agent_version"`
	MemoryDefinition string      `json:"memory_definition"`
	GPUDevices       []GPUDevice `json:"gpu_devices,omitempty"`
}
type GPUDevice struct {
	ID     string `json:"id"`
	Name   string `json:"name"`
	Vendor string `json:"vendor"`
}
type Sample struct {
	SchemaVersion             int       `json:"schema_version"`
	MachineID                 string    `json:"machine_id"`
	BootID                    string    `json:"boot_id"`
	Sequence                  uint64    `json:"sequence"`
	ObservedAt                string    `json:"observed_at"`
	Inventory                 Inventory `json:"inventory"`
	Metrics                   []Metric  `json:"metrics"`
	CollectionIntervalSeconds *float64  `json:"collection_interval_seconds"`
}
type counter struct {
	read, write uint64
	at          time.Time
}
type Collector struct {
	CPUWindow      time.Duration
	CPUStartedAt   time.Time
	CPUCompletedAt time.Time
	mu             sync.Mutex
	seq            uint64
	network        map[string]counter
	io             map[string]counter
	NvidiaSMI      string
	lastSample     time.Time
}

func New() *Collector { return &Collector{network: map[string]counter{}, io: map[string]counter{}} }
func Rate(now, old uint64, elapsed time.Duration) *float64 {
	if elapsed <= 0 || elapsed > 120*time.Second || now < old {
		return nil
	}
	v := float64(now-old) / elapsed.Seconds()
	return &v
}
func (c *Collector) Collect(ctx context.Context, machine string) Sample {
	c.mu.Lock()
	defer c.mu.Unlock()
	c.seq++
	now := time.Now()
	stamp := now.UTC().Format(time.RFC3339Nano)
	s := Sample{SchemaVersion: 1, MachineID: machine, Sequence: c.seq, ObservedAt: stamp, Metrics: []Metric{}, Inventory: Inventory{OS: runtime.GOOS, Architecture: runtime.GOARCH, LogicalCores: runtime.NumCPU(), AgentVersion: "0.1.0", MemoryDefinition: "gopsutil physical total/available/used; native cached-memory semantics differ by OS"}}
	if !c.lastSample.IsZero() {
		elapsed := now.Sub(c.lastSample).Seconds()
		if elapsed > 0 && elapsed <= 86400 {
			s.CollectionIntervalSeconds = &elapsed
		}
	}
	c.lastSample = now
	add := func(name, device, unit string, value *float64, reason string, source string) {
		var why *string
		available := "available"
		if value == nil {
			available = "unavailable"
			if reason == "" {
				reason = "not_reported"
			}
			why = &reason
		}
		kind := "gauge"
		if strings.HasSuffix(name, "_rate") {
			kind = "rate"
		} else if name == "network_received" || name == "network_sent" {
			kind = "counter"
		}
		s.Metrics = append(s.Metrics, Metric{name, device, value, unit, available, why, source, stamp, kind})
	}
	val := func(v float64) *float64 { return &v }
	h, e := host.InfoWithContext(ctx)
	if e == nil {
		s.BootID = fmt.Sprintf("%s:%d", machine, h.BootTime)
		s.Inventory.Hostname = h.Hostname
		s.Inventory.Platform = h.Platform
		s.Inventory.PlatformVersion = h.PlatformVersion
		add("uptime", "host", "seconds", val(float64(h.Uptime)), "", "gopsutil/host")
	} else {
		add("uptime", "host", "seconds", nil, "collector_error", "gopsutil/host")
	}
	window := c.CPUWindow
	if window == 0 {
		window = 200 * time.Millisecond
	}
	c.CPUStartedAt = time.Now().UTC()
	pct, e := cpu.PercentWithContext(ctx, window, false)
	c.CPUCompletedAt = time.Now().UTC()
	if e == nil && len(pct) > 0 {
		add("cpu_utilization", "host", "percent", val(pct[0]), "", "gopsutil/cpu")
	} else {
		add("cpu_utilization", "host", "percent", nil, "collector_error", "gopsutil/cpu")
	}
	memory, e := mem.VirtualMemoryWithContext(ctx)
	if e == nil {
		add("memory_total", "host", "bytes", val(float64(memory.Total)), "", "gopsutil/mem")
		add("memory_available", "host", "bytes", val(float64(memory.Available)), "", "gopsutil/mem")
		add("memory_used", "host", "bytes", val(float64(memory.Used)), "", "gopsutil/mem")
	} else {
		add("memory_used", "host", "bytes", nil, "collector_error", "gopsutil/mem")
	}
	parts, e := disk.PartitionsWithContext(ctx, false)
	if e != nil {
		add("disk_capacity", "host", "bytes", nil, "collector_error", "gopsutil/disk")
	}
	for _, p := range parts {
		u, e := disk.UsageWithContext(ctx, p.Mountpoint)
		if e != nil {
			add("disk_capacity", p.Mountpoint, "bytes", nil, "permission_or_collection_error", "gopsutil/disk")
			continue
		}
		add("disk_capacity", p.Mountpoint, "bytes", val(float64(u.Total)), "", "gopsutil/disk")
		add("disk_used", p.Mountpoint, "bytes", val(float64(u.Used)), "", "gopsutil/disk")
		add("disk_free", p.Mountpoint, "bytes", val(float64(u.Free)), "", "gopsutil/disk")
	}
	nets, e := gnet.IOCountersWithContext(ctx, true)
	if e != nil {
		add("network_receive_rate", "host", "bytes/second", nil, "collector_error", "gopsutil/net")
	}
	nextN := map[string]counter{}
	for _, n := range nets {
		add("network_received", n.Name, "bytes", val(float64(n.BytesRecv)), "", "gopsutil/net")
		add("network_sent", n.Name, "bytes", val(float64(n.BytesSent)), "", "gopsutil/net")
		var rx, tx *float64
		if old, ok := c.network[n.Name]; ok {
			rx = Rate(n.BytesRecv, old.read, now.Sub(old.at))
			tx = Rate(n.BytesSent, old.write, now.Sub(old.at))
		}
		add("network_receive_rate", n.Name, "bytes/second", rx, "first_sample_counter_reset_or_collection_gap", "gopsutil/net")
		add("network_send_rate", n.Name, "bytes/second", tx, "first_sample_counter_reset_or_collection_gap", "gopsutil/net")
		nextN[n.Name] = counter{n.BytesRecv, n.BytesSent, now}
	}
	c.network = nextN
	ios, e := disk.IOCountersWithContext(ctx)
	if e != nil {
		add("disk_read_rate", "host", "bytes/second", nil, "unsupported_or_permission_denied", "gopsutil/disk")
	}
	nextIO := map[string]counter{}
	for name, d := range ios {
		var rd, wr *float64
		if old, ok := c.io[name]; ok {
			rd = Rate(d.ReadBytes, old.read, now.Sub(old.at))
			wr = Rate(d.WriteBytes, old.write, now.Sub(old.at))
		}
		add("disk_read_rate", name, "bytes/second", rd, "first_sample_counter_reset_or_collection_gap", "gopsutil/disk")
		add("disk_write_rate", name, "bytes/second", wr, "first_sample_counter_reset_or_collection_gap", "gopsutil/disk")
		nextIO[name] = counter{d.ReadBytes, d.WriteBytes, now}
	}
	c.io = nextIO
	if c.NvidiaSMI == "" {
		add("gpu_utilization", "gpu", "percent", nil, "nvidia_collector_unconfigured", "nvidia-smi")
	} else {
		s.Inventory.GPUDevices = c.gpu(ctx, add)
	}
	return s
}
func (c *Collector) gpu(ctx context.Context, add func(string, string, string, *float64, string, string)) []GPUDevice {
	ctx, cancel := context.WithTimeout(ctx, 2*time.Second)
	defer cancel()
	if !filepath.IsAbs(c.NvidiaSMI) {
		add("gpu_utilization", "gpu", "percent", nil, "absolute_collector_path_required", "nvidia-smi")
		return nil
	}
	cmd := exec.CommandContext(ctx, c.NvidiaSMI, "--query-gpu=uuid,name,utilization.gpu,memory.used,memory.total,temperature.gpu,power.draw", "--format=csv,noheader,nounits")
	capture := &collectorOutput{}
	cmd.Stdout = capture
	e := cmd.Run()
	out := capture.Bytes()
	if e != nil {
		add("gpu_utilization", "gpu", "percent", nil, "collector_error", "nvidia-smi")
		return nil
	}
	if len(out) > 1<<20 {
		add("gpu_utilization", "gpu", "percent", nil, "output_limit", "nvidia-smi")
		return nil
	}
	rows, e := csv.NewReader(strings.NewReader(string(out))).ReadAll()
	if e != nil {
		add("gpu_utilization", "gpu", "percent", nil, "invalid_collector_response", "nvidia-smi")
		return nil
	}
	devices := []GPUDevice{}
	names := []string{"gpu_utilization", "gpu_memory_used", "gpu_memory_total", "gpu_temperature", "gpu_power"}
	units := []string{"percent", "bytes", "bytes", "celsius", "watts"}
	for _, row := range rows {
		if len(row) != 7 {
			continue
		}
		id := strings.TrimSpace(row[0])
		devices = append(devices, GPUDevice{id, strings.TrimSpace(row[1]), "NVIDIA"})
		for i, name := range names {
			v, e := strconv.ParseFloat(strings.TrimSpace(row[i+2]), 64)
			var p *float64
			if e == nil && !math.IsNaN(v) && !math.IsInf(v, 0) {
				if i == 1 || i == 2 {
					v *= 1024 * 1024
				}
				p = &v
			}
			add(name, id, units[i], p, fmt.Sprintf("unsupported_field_%s", name), "nvidia-smi")
		}
	}
	return devices
}

type collectorOutput struct{ bytes.Buffer }

func (c *collectorOutput) Write(p []byte) (int, error) {
	if c.Len()+len(p) > 1<<20 {
		return 0, errors.New("collector_output_limit")
	}
	return c.Buffer.Write(p)
}
