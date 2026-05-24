// Package main implements a small HTTP microservice that wraps yt-dlp.
//
// The service exposes a job-oriented REST API plus a Server-Sent Events stream
// for live progress updates. It is intentionally minimal: stdlib only, single
// file, no frameworks.
package main

import (
	"bufio"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"net/http"
	"os"
	"os/exec"
	"os/signal"
	"strconv"
	"strings"
	"sync"
	"sync/atomic"
	"syscall"
	"time"
)

// ----------------------------------------------------------------------------
// Types
// ----------------------------------------------------------------------------

// JobStatus represents the lifecycle state of a job.
type JobStatus string

const (
	StatusQueued    JobStatus = "queued"
	StatusRunning   JobStatus = "running"
	StatusCompleted JobStatus = "completed"
	StatusFailed    JobStatus = "failed"
	StatusCanceled  JobStatus = "canceled"
)

// Job is the unit of work enqueued by callers.
type Job struct {
	ID          string   `json:"id"`
	URL         string   `json:"url"`
	Format      string   `json:"format"`
	Container   string   `json:"container,omitempty"`
	ExtraArgs   []string `json:"extraArgs,omitempty"`
	CookiesFile string   `json:"cookiesFile,omitempty"`
}

// JobState is the in-memory record kept for each job we have seen.
type JobState struct {
	Job
	Status    JobStatus `json:"status"`
	Progress  float64   `json:"progress"`
	Speed     string    `json:"speed,omitempty"`
	ETA       string    `json:"eta,omitempty"`
	FilePath  string    `json:"filePath,omitempty"`
	Title     string    `json:"title,omitempty"`
	Error     string    `json:"error,omitempty"`
	StartedAt time.Time `json:"startedAt,omitempty"`
	EndedAt   time.Time `json:"endedAt,omitempty"`
}

// Event is the SSE payload shape. Fields are optional; only those populated
// for the event type are serialized.
type Event struct {
	Type       string    `json:"type"`
	ID         string    `json:"id"`
	Status     JobStatus `json:"status,omitempty"`
	Progress   float64   `json:"progress,omitempty"`
	Speed      string    `json:"speed,omitempty"`
	ETA        string    `json:"eta,omitempty"`
	Downloaded int64     `json:"downloaded,omitempty"`
	Total      int64     `json:"total,omitempty"`
	FilePath   string    `json:"filePath,omitempty"`
	Title      string    `json:"title,omitempty"`
	Error      string    `json:"error,omitempty"`
}

// ----------------------------------------------------------------------------
// Config
// ----------------------------------------------------------------------------

type Config struct {
	Port        string
	MaxParallel int
	DownloadDir string
	CookiesDir  string
	YTDLPPath   string
}

func loadConfig() Config {
	return Config{
		Port:        envOr("PORT", "8080"),
		MaxParallel: envInt("DOWNLOADER_MAX_PARALLEL", 2),
		DownloadDir: envOr("DOWNLOAD_DIR", "/downloads"),
		CookiesDir:  envOr("COOKIES_DIR", "/cookies"),
		YTDLPPath:   envOr("YTDLP_PATH", "yt-dlp"),
	}
}

func envOr(k, d string) string {
	if v := os.Getenv(k); v != "" {
		return v
	}
	return d
}

func envInt(k string, d int) int {
	if v := os.Getenv(k); v != "" {
		if n, err := strconv.Atoi(v); err == nil {
			return n
		}
	}
	return d
}

// ----------------------------------------------------------------------------
// Event bus (SSE fan-out)
// ----------------------------------------------------------------------------

// EventBus is a simple in-process fan-out. Each subscriber has its own buffered
// channel; if a subscriber falls behind we drop the oldest event rather than
// block the publisher.
type EventBus struct {
	mu   sync.Mutex
	subs map[chan Event]struct{}
}

func newEventBus() *EventBus {
	return &EventBus{subs: make(map[chan Event]struct{})}
}

func (b *EventBus) subscribe() chan Event {
	ch := make(chan Event, 256)
	b.mu.Lock()
	b.subs[ch] = struct{}{}
	b.mu.Unlock()
	return ch
}

func (b *EventBus) unsubscribe(ch chan Event) {
	b.mu.Lock()
	if _, ok := b.subs[ch]; ok {
		delete(b.subs, ch)
		close(ch)
	}
	b.mu.Unlock()
}

func (b *EventBus) publish(e Event) {
	b.mu.Lock()
	defer b.mu.Unlock()
	for ch := range b.subs {
		select {
		case ch <- e:
		default:
			// Slow consumer: drop oldest and try once more.
			select {
			case <-ch:
			default:
			}
			select {
			case ch <- e:
			default:
			}
		}
	}
}

// ----------------------------------------------------------------------------
// Job registry
// ----------------------------------------------------------------------------

// Registry tracks all jobs the downloader currently knows about: queued,
// running, and the most recently finished entries (ring buffer of finished IDs).
type Registry struct {
	mu       sync.Mutex
	jobs     map[string]*JobState
	finished []string // ring buffer of finished IDs, oldest first
	cap      int
}

func newRegistry(cap int) *Registry {
	return &Registry{jobs: make(map[string]*JobState), cap: cap}
}

func (r *Registry) add(j *JobState) error {
	r.mu.Lock()
	defer r.mu.Unlock()
	if _, exists := r.jobs[j.ID]; exists {
		return errors.New("job id already exists")
	}
	r.jobs[j.ID] = j
	return nil
}

func (r *Registry) get(id string) (*JobState, bool) {
	r.mu.Lock()
	defer r.mu.Unlock()
	j, ok := r.jobs[id]
	return j, ok
}

func (r *Registry) update(id string, fn func(*JobState)) {
	r.mu.Lock()
	defer r.mu.Unlock()
	if j, ok := r.jobs[id]; ok {
		fn(j)
	}
}

// markFinished records a job as terminal and rotates the ring buffer.
func (r *Registry) markFinished(id string) {
	r.mu.Lock()
	defer r.mu.Unlock()
	if _, ok := r.jobs[id]; !ok {
		return
	}
	r.finished = append(r.finished, id)
	for len(r.finished) > r.cap {
		evict := r.finished[0]
		r.finished = r.finished[1:]
		// Only delete the evicted entry if it is actually terminal — a job that
		// was re-enqueued under the same ID after finishing should be kept.
		if j, ok := r.jobs[evict]; ok && isTerminal(j.Status) {
			delete(r.jobs, evict)
		}
	}
}

func (r *Registry) remove(id string) {
	r.mu.Lock()
	defer r.mu.Unlock()
	delete(r.jobs, id)
}

func (r *Registry) snapshot() []JobState {
	r.mu.Lock()
	defer r.mu.Unlock()
	out := make([]JobState, 0, len(r.jobs))
	for _, j := range r.jobs {
		out = append(out, *j)
	}
	return out
}

func isTerminal(s JobStatus) bool {
	return s == StatusCompleted || s == StatusFailed || s == StatusCanceled
}

// ----------------------------------------------------------------------------
// Worker pool
// ----------------------------------------------------------------------------

// Pool runs jobs with a configurable concurrency. Resizing drains the current
// pool and restarts with the new size.
type Pool struct {
	cfg      Config
	registry *Registry
	bus      *EventBus

	mu          sync.Mutex
	maxParallel int
	jobs        chan Job
	cancelFns   sync.Map // id -> context.CancelFunc
	wg          sync.WaitGroup
	stopWorkers context.CancelFunc
	workersCtx  context.Context
}

func newPool(cfg Config, reg *Registry, bus *EventBus) *Pool {
	p := &Pool{
		cfg:         cfg,
		registry:    reg,
		bus:         bus,
		maxParallel: cfg.MaxParallel,
		jobs:        make(chan Job, 1000),
	}
	p.workersCtx, p.stopWorkers = context.WithCancel(context.Background())
	p.startWorkers(p.maxParallel)
	return p
}

func (p *Pool) startWorkers(n int) {
	for i := 0; i < n; i++ {
		p.wg.Add(1)
		go p.worker(p.workersCtx, i)
	}
}

func (p *Pool) worker(ctx context.Context, id int) {
	defer p.wg.Done()
	log := slog.With("worker", id)
	for {
		select {
		case <-ctx.Done():
			return
		case j, ok := <-p.jobs:
			if !ok {
				return
			}
			log.Info("picked job", "id", j.ID)
			p.run(ctx, j)
		}
	}
}

// enqueue queues a job. The caller has already added it to the registry.
func (p *Pool) enqueue(j Job) {
	p.jobs <- j
}

// resize drains current workers, swaps the channel, and starts a new set.
func (p *Pool) resize(n int) {
	p.mu.Lock()
	defer p.mu.Unlock()
	if n < 1 {
		n = 1
	}
	slog.Info("resizing worker pool", "from", p.maxParallel, "to", n)

	// Stop current workers (does not cancel in-flight jobs themselves; they
	// will complete naturally — each holds its own job context).
	p.stopWorkers()
	p.wg.Wait()

	p.maxParallel = n
	p.workersCtx, p.stopWorkers = context.WithCancel(context.Background())
	p.startWorkers(n)
}

// shutdown stops accepting new jobs, cancels every in-flight job, then waits
// for workers to return.
func (p *Pool) shutdown() {
	p.mu.Lock()
	defer p.mu.Unlock()
	p.cancelFns.Range(func(k, v any) bool {
		if cancel, ok := v.(context.CancelFunc); ok {
			cancel()
		}
		return true
	})
	p.stopWorkers()
	p.wg.Wait()
}

// cancel signals a running or queued job to stop. Returns true if the job
// was known.
func (p *Pool) cancel(id string) bool {
	if v, ok := p.cancelFns.Load(id); ok {
		if cancel, ok := v.(context.CancelFunc); ok {
			cancel()
		}
		return true
	}
	// If only queued (not yet picked up), mark canceled in the registry; the
	// worker that eventually picks it up will observe StatusCanceled and skip.
	if j, ok := p.registry.get(id); ok && j.Status == StatusQueued {
		p.registry.update(id, func(s *JobState) {
			s.Status = StatusCanceled
			s.EndedAt = time.Now()
		})
		p.bus.publish(Event{Type: "status", ID: id, Status: StatusCanceled})
		p.registry.markFinished(id)
		return true
	}
	return false
}

// run executes one job from start to finish, publishing events.
func (p *Pool) run(parentCtx context.Context, j Job) {
	// Skip if it was canceled while queued.
	if s, ok := p.registry.get(j.ID); ok && s.Status == StatusCanceled {
		return
	}

	ctx, cancel := context.WithCancel(parentCtx)
	p.cancelFns.Store(j.ID, cancel)
	defer func() {
		p.cancelFns.Delete(j.ID)
		cancel()
	}()

	p.registry.update(j.ID, func(s *JobState) {
		s.Status = StatusRunning
		s.StartedAt = time.Now()
	})
	p.bus.publish(Event{Type: "status", ID: j.ID, Status: StatusRunning})

	args := buildArgs(j, p.cfg.DownloadDir)
	slog.Info("running yt-dlp", "id", j.ID, "args", args)

	cmd := exec.Command(p.cfg.YTDLPPath, args...)
	cmd.SysProcAttr = sysProcAttr() // own process group for clean signaling
	stdout, err := cmd.StdoutPipe()
	if err != nil {
		p.fail(j.ID, "stdout pipe: "+err.Error())
		return
	}
	stderr, err := cmd.StderrPipe()
	if err != nil {
		p.fail(j.ID, "stderr pipe: "+err.Error())
		return
	}

	if err := cmd.Start(); err != nil {
		p.fail(j.ID, "start: "+err.Error())
		return
	}

	// Rolling buffer of last N bytes of combined stderr/stdout-noise output.
	const errBufCap = 4096
	var errBuf rollingBuf
	errBuf.cap = errBufCap

	var filePath atomic.Value // string
	filePath.Store("")

	var parserWG sync.WaitGroup
	parserWG.Add(2)

	go func() {
		defer parserWG.Done()
		sc := bufio.NewScanner(stdout)
		sc.Buffer(make([]byte, 0, 64*1024), 1024*1024)
		for sc.Scan() {
			line := sc.Text()
			p.handleStdoutLine(j.ID, line, &errBuf, &filePath)
		}
	}()
	go func() {
		defer parserWG.Done()
		sc := bufio.NewScanner(stderr)
		sc.Buffer(make([]byte, 0, 64*1024), 1024*1024)
		for sc.Scan() {
			line := sc.Text()
			errBuf.write(line + "\n")
		}
	}()

	// Wait for the process in a goroutine so we can react to context cancel.
	doneCh := make(chan error, 1)
	go func() { doneCh <- cmd.Wait() }()

	canceled := false
	select {
	case <-ctx.Done():
		canceled = true
		// SIGINT, wait up to 3s, then SIGKILL the process group.
		_ = sendSignal(cmd, syscall.SIGINT)
		select {
		case <-doneCh:
		case <-time.After(3 * time.Second):
			_ = sendSignal(cmd, syscall.SIGKILL)
			<-doneCh
		}
	case <-doneCh:
		// process exited naturally; doneCh consumed
	}

	// Drain parser goroutines so we have the full output captured.
	parserWG.Wait()

	now := time.Now()
	// Captured destination from yt-dlp's `[download] Destination: …` /
	// `[Merger] Merging formats into "…"` / `[ExtractAudio] Destination: …`
	// — used by the web side to clean up half-written partials on terminal
	// non-completed exits.
	fp, _ := filePath.Load().(string)
	switch {
	case canceled:
		p.registry.update(j.ID, func(s *JobState) {
			s.Status = StatusCanceled
			s.FilePath = fp
			s.EndedAt = now
		})
		p.bus.publish(Event{Type: "status", ID: j.ID, Status: StatusCanceled, FilePath: fp})
	case cmd.ProcessState != nil && cmd.ProcessState.Success():
		p.registry.update(j.ID, func(s *JobState) {
			s.Status = StatusCompleted
			s.Progress = 100
			s.FilePath = fp
			s.EndedAt = now
		})
		p.bus.publish(Event{Type: "status", ID: j.ID, Status: StatusCompleted, FilePath: fp})
	default:
		msg := strings.TrimSpace(errBuf.string())
		if msg == "" {
			msg = "yt-dlp exited with non-zero status"
		}
		p.registry.update(j.ID, func(s *JobState) {
			s.Status = StatusFailed
			s.Error = msg
			s.FilePath = fp
			s.EndedAt = now
		})
		p.bus.publish(Event{Type: "status", ID: j.ID, Status: StatusFailed, Error: msg, FilePath: fp})
	}

	p.registry.markFinished(j.ID)
}

func (p *Pool) fail(id, msg string) {
	p.registry.update(id, func(s *JobState) {
		s.Status = StatusFailed
		s.Error = msg
		s.EndedAt = time.Now()
	})
	p.bus.publish(Event{Type: "status", ID: id, Status: StatusFailed, Error: msg})
	p.registry.markFinished(id)
}

// handleStdoutLine parses one line of yt-dlp stdout and emits events.
func (p *Pool) handleStdoutLine(id, line string, errBuf *rollingBuf, filePath *atomic.Value) {
	// Resolved video title, emitted once per format-download by our
	// `--print before_dl:TITLE_PROBE:%(title)s` directive. We forward it
	// to subscribers only the first time per job — combo formats fire
	// the before_dl hook twice (video + audio).
	if strings.HasPrefix(line, "TITLE_PROBE:") {
		title := strings.TrimSpace(strings.TrimPrefix(line, "TITLE_PROBE:"))
		if title == "" || title == "NA" {
			return
		}
		emit := false
		p.registry.update(id, func(s *JobState) {
			if s.Title == "" {
				s.Title = title
				emit = true
			}
		})
		if emit {
			p.bus.publish(Event{Type: "title", ID: id, Title: title})
		}
		return
	}

	// Resolved output path, also from --print before_dl. Without this the
	// new yt-dlp + --progress-template combo never prints a
	// `[download] Destination: …` line and the cleanup-on-cancel path has
	// no filename to scrub. Store unconditionally — combo formats refire
	// before_dl per stream, but all values point at the same [id] bracket.
	if strings.HasPrefix(line, "DEST_PROBE:") {
		fp := strings.TrimSpace(strings.TrimPrefix(line, "DEST_PROBE:"))
		if fp != "" && fp != "NA" {
			filePath.Store(fp)
		}
		return
	}

	// PROGRESS <down>/<total> <speed_bps> <eta_sec> <frag_idx>/<frag_count> <status>
	if strings.HasPrefix(line, "PROGRESS ") {
		fields := strings.Fields(line)
		if len(fields) >= 6 {
			dt := strings.SplitN(fields[1], "/", 2)
			var down, total int64
			if len(dt) == 2 {
				down = parseInt64(dt[0])
				total = parseInt64(dt[1])
			}
			fc := strings.SplitN(fields[4], "/", 2)
			var fragIdx, fragCount int64
			if len(fc) == 2 {
				fragIdx = parseInt64(fc[0])
				fragCount = parseInt64(fc[1])
			}
			var pct float64
			if total > 0 {
				pct = float64(down) / float64(total) * 100
			} else if fragCount > 0 {
				pct = float64(fragIdx) / float64(fragCount) * 100
			}
			speed := formatBytesPerSec(fields[2])
			eta := formatETASeconds(fields[3])
			p.registry.update(id, func(s *JobState) {
				s.Progress = pct
				s.Speed = speed
				s.ETA = eta
			})
			p.bus.publish(Event{
				Type:       "progress",
				ID:         id,
				Progress:   pct,
				Speed:      speed,
				ETA:        eta,
				Downloaded: down,
				Total:      total,
			})
		}
		return
	}

	// Capture destination / final merged path.
	if strings.Contains(line, "[download] Destination: ") {
		if idx := strings.Index(line, "Destination: "); idx >= 0 {
			fp := strings.TrimSpace(line[idx+len("Destination: "):])
			filePath.Store(fp)
		}
	} else if strings.Contains(line, "[Merger] Merging formats into ") {
		if idx := strings.Index(line, "Merging formats into "); idx >= 0 {
			rest := strings.TrimSpace(line[idx+len("Merging formats into "):])
			rest = strings.Trim(rest, "\"")
			filePath.Store(rest)
		}
	} else if strings.Contains(line, "[ExtractAudio] Destination: ") {
		if idx := strings.Index(line, "Destination: "); idx >= 0 {
			fp := strings.TrimSpace(line[idx+len("Destination: "):])
			filePath.Store(fp)
		}
	}

	// Try to grab a title once.
	if strings.HasPrefix(line, "[info] ") && strings.Contains(line, ": Downloading 1 format") {
		// Not useful for title; skip.
	}

	// Keep all non-progress lines in the rolling buffer so error reports
	// include trailing context even if yt-dlp emits diagnostics on stdout.
	errBuf.write(line + "\n")
}

func parseInt64(s string) int64 {
	s = strings.TrimSpace(s)
	if s == "" || s == "NA" {
		return 0
	}
	// yt-dlp sometimes emits floats here (e.g. "12.5"). Take the integer part.
	if i := strings.IndexByte(s, '.'); i >= 0 {
		s = s[:i]
	}
	n, err := strconv.ParseInt(s, 10, 64)
	if err != nil {
		return 0
	}
	return n
}

// formatBytesPerSec turns yt-dlp's raw "%(progress.speed)s" (a bytes/sec
// float as string, or "NA") into a compact human-readable rate like
// "17.3 MiB/s". Returns "" for NA / unparseable input so the UI can render
// nothing instead of "0 B/s".
func formatBytesPerSec(s string) string {
	s = strings.TrimSpace(s)
	if s == "" || s == "NA" {
		return ""
	}
	v, err := strconv.ParseFloat(s, 64)
	if err != nil || v <= 0 {
		return ""
	}
	units := []string{"B/s", "KiB/s", "MiB/s", "GiB/s", "TiB/s"}
	i := 0
	for v >= 1024 && i < len(units)-1 {
		v /= 1024
		i++
	}
	if v >= 100 {
		return fmt.Sprintf("%.0f %s", v, units[i])
	}
	if v >= 10 {
		return fmt.Sprintf("%.1f %s", v, units[i])
	}
	return fmt.Sprintf("%.2f %s", v, units[i])
}

// formatETASeconds turns yt-dlp's raw "%(progress.eta)s" (a seconds float
// as string, or "NA") into "M:SS" or "H:MM:SS". Returns "" for NA.
func formatETASeconds(s string) string {
	s = strings.TrimSpace(s)
	if s == "" || s == "NA" {
		return ""
	}
	f, err := strconv.ParseFloat(s, 64)
	if err != nil || f < 0 {
		return ""
	}
	sec := int(f + 0.5)
	h := sec / 3600
	m := (sec % 3600) / 60
	s2 := sec % 60
	if h > 0 {
		return fmt.Sprintf("%d:%02d:%02d", h, m, s2)
	}
	return fmt.Sprintf("%d:%02d", m, s2)
}

// buildArgs constructs the yt-dlp command line for a job.
func buildArgs(j Job, downloadDir string) []string {
	args := []string{
		"--newline", "--no-color", "--progress",
		"--progress-template",
		// Six space-separated fields after the literal PROGRESS tag:
		//   down/total  speed  eta  frag_idx/frag_count  status
		// Speed is bytes/sec, eta is seconds. The fragment pair is
		// non-NA for HLS/DASH downloads (e.g. Twitch) where the byte
		// totals are NA — we use it as the fallback progress source.
		"PROGRESS %(progress.downloaded_bytes)s/%(progress.total_bytes)s %(progress.speed)s %(progress.eta)s %(progress.fragment_index)s/%(progress.fragment_count)s %(progress.status)s",
		// Emit the resolved video title once, right after extraction but
		// before any fragments are downloaded, so the UI can swap "raw URL"
		// for a real title as soon as it's known.
		"--print", "before_dl:TITLE_PROBE:%(title)s",
		// Same idea for the output path. The new yt-dlp + --progress-template
		// combo suppresses the standard `[download] Destination: …` line,
		// which is how we used to capture the filename for cleanup-on-
		// cancel. Probe it explicitly here instead.
		"--print", "before_dl:DEST_PROBE:%(filename)s",
	}

	formatLower := strings.ToLower(j.Format)
	switch formatLower {
	case "audio":
		args = append(args, "-f", "ba/b", "-x", "--audio-format", "mp3")
	case "1080p":
		args = append(args, "-f", "bv*[height<=1080]+ba/b[height<=1080]")
	case "720p":
		args = append(args, "-f", "bv*[height<=720]+ba/b[height<=720]")
	case "best", "":
		args = append(args, "-f", "bv*+ba/b")
	default:
		// Pass through raw selectors for forward-compat.
		args = append(args, "-f", j.Format)
	}

	// Output container preference. "auto" / empty leaves yt-dlp to pick its
	// natural container (typically mp4 for HLS, may end up webm/mkv for
	// other sources). Anything else maps to --merge-output-format, which
	// container-only re-muxes the merged stream — no full re-encode unless
	// the codec is fundamentally incompatible.
	if formatLower != "audio" {
		switch strings.ToLower(j.Container) {
		case "", "auto":
			// no flag
		case "mp4", "mkv", "webm", "mov":
			args = append(args, "--merge-output-format", strings.ToLower(j.Container))
		}
	}

	if j.CookiesFile != "" {
		args = append(args, "--cookies", j.CookiesFile)
	}

	args = append(args, "-o", downloadDir+"/%(title).200B [%(id)s].%(ext)s")

	if len(j.ExtraArgs) > 0 {
		args = append(args, j.ExtraArgs...)
	}

	args = append(args, j.URL)
	return args
}

// ----------------------------------------------------------------------------
// Rolling byte buffer (last N bytes of text)
// ----------------------------------------------------------------------------

type rollingBuf struct {
	mu  sync.Mutex
	buf []byte
	cap int
}

func (r *rollingBuf) write(s string) {
	r.mu.Lock()
	defer r.mu.Unlock()
	r.buf = append(r.buf, s...)
	if len(r.buf) > r.cap {
		r.buf = r.buf[len(r.buf)-r.cap:]
	}
}

func (r *rollingBuf) string() string {
	r.mu.Lock()
	defer r.mu.Unlock()
	return string(r.buf)
}

// ----------------------------------------------------------------------------
// HTTP server
// ----------------------------------------------------------------------------

type Server struct {
	cfg      Config
	registry *Registry
	bus      *EventBus
	pool     *Pool
}

func (s *Server) routes() http.Handler {
	mux := http.NewServeMux()
	mux.HandleFunc("POST /jobs", s.postJob)
	mux.HandleFunc("DELETE /jobs/{id}", s.deleteJob)
	mux.HandleFunc("GET /jobs", s.listJobs)
	mux.HandleFunc("GET /events", s.events)
	mux.HandleFunc("PATCH /config", s.patchConfig)
	mux.HandleFunc("GET /healthz", s.healthz)
	return mux
}

func (s *Server) postJob(w http.ResponseWriter, r *http.Request) {
	var j Job
	if err := json.NewDecoder(r.Body).Decode(&j); err != nil {
		http.Error(w, "invalid json: "+err.Error(), http.StatusBadRequest)
		return
	}
	if j.ID == "" || j.URL == "" {
		http.Error(w, "id and url are required", http.StatusBadRequest)
		return
	}

	state := &JobState{Job: j, Status: StatusQueued}
	if err := s.registry.add(state); err != nil {
		http.Error(w, err.Error(), http.StatusConflict)
		return
	}
	s.bus.publish(Event{Type: "status", ID: j.ID, Status: StatusQueued})
	s.pool.enqueue(j)

	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(http.StatusAccepted)
	_ = json.NewEncoder(w).Encode(map[string]string{
		"id":     j.ID,
		"status": string(StatusQueued),
	})
}

func (s *Server) deleteJob(w http.ResponseWriter, r *http.Request) {
	id := r.PathValue("id")
	if id == "" {
		http.Error(w, "missing id", http.StatusBadRequest)
		return
	}
	s.pool.cancel(id)
	w.WriteHeader(http.StatusNoContent)
}

func (s *Server) listJobs(w http.ResponseWriter, _ *http.Request) {
	jobs := s.registry.snapshot()
	w.Header().Set("Content-Type", "application/json")
	_ = json.NewEncoder(w).Encode(map[string]any{"jobs": jobs})
}

func (s *Server) events(w http.ResponseWriter, r *http.Request) {
	flusher, ok := w.(http.Flusher)
	if !ok {
		http.Error(w, "streaming unsupported", http.StatusInternalServerError)
		return
	}
	w.Header().Set("Content-Type", "text/event-stream")
	w.Header().Set("Cache-Control", "no-cache")
	w.Header().Set("Connection", "keep-alive")
	w.Header().Set("X-Accel-Buffering", "no")

	ch := s.bus.subscribe()
	defer s.bus.unsubscribe(ch)

	// Initial heartbeat so the client sees the connection is open.
	_, _ = io.WriteString(w, ":\n\n")
	flusher.Flush()

	ticker := time.NewTicker(15 * time.Second)
	defer ticker.Stop()

	ctx := r.Context()
	for {
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
			if _, err := io.WriteString(w, ":\n\n"); err != nil {
				return
			}
			flusher.Flush()
		case e, ok := <-ch:
			if !ok {
				return
			}
			b, err := json.Marshal(e)
			if err != nil {
				continue
			}
			if _, err := fmt.Fprintf(w, "data: %s\n\n", b); err != nil {
				return
			}
			flusher.Flush()
		}
	}
}

func (s *Server) patchConfig(w http.ResponseWriter, r *http.Request) {
	var body struct {
		MaxParallel int `json:"maxParallel"`
	}
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		http.Error(w, "invalid json: "+err.Error(), http.StatusBadRequest)
		return
	}
	if body.MaxParallel < 1 {
		http.Error(w, "maxParallel must be >= 1", http.StatusBadRequest)
		return
	}
	s.pool.resize(body.MaxParallel)
	w.Header().Set("Content-Type", "application/json")
	_ = json.NewEncoder(w).Encode(map[string]any{
		"maxParallel": body.MaxParallel,
	})
}

func (s *Server) healthz(w http.ResponseWriter, _ *http.Request) {
	w.Header().Set("Content-Type", "text/plain; charset=utf-8")
	_, _ = io.WriteString(w, "OK")
}

// ----------------------------------------------------------------------------
// Process signaling (split out so it's easy to keep stdlib-only & portable)
// ----------------------------------------------------------------------------

func sysProcAttr() *syscall.SysProcAttr {
	// Use a dedicated process group so we can SIGINT/SIGKILL the entire tree
	// (yt-dlp + any spawned ffmpeg child).
	return &syscall.SysProcAttr{Setpgid: true}
}

func sendSignal(cmd *exec.Cmd, sig syscall.Signal) error {
	if cmd.Process == nil {
		return nil
	}
	// Negative PID targets the process group.
	if err := syscall.Kill(-cmd.Process.Pid, sig); err == nil {
		return nil
	}
	return cmd.Process.Signal(sig)
}

// ----------------------------------------------------------------------------
// main
// ----------------------------------------------------------------------------

func main() {
	slog.SetDefault(slog.New(slog.NewJSONHandler(os.Stdout, &slog.HandlerOptions{Level: slog.LevelInfo})))

	cfg := loadConfig()
	slog.Info("starting downloader",
		"port", cfg.Port,
		"maxParallel", cfg.MaxParallel,
		"downloadDir", cfg.DownloadDir,
		"cookiesDir", cfg.CookiesDir,
		"ytDlpPath", cfg.YTDLPPath,
	)

	reg := newRegistry(50)
	bus := newEventBus()
	pool := newPool(cfg, reg, bus)
	srv := &Server{cfg: cfg, registry: reg, bus: bus, pool: pool}

	httpServer := &http.Server{
		Addr:              ":" + cfg.Port,
		Handler:           srv.routes(),
		ReadHeaderTimeout: 10 * time.Second,
	}

	// Signal handling.
	stopCtx, stop := signal.NotifyContext(context.Background(), syscall.SIGINT, syscall.SIGTERM)
	defer stop()

	serverErr := make(chan error, 1)
	go func() {
		slog.Info("http listening", "addr", httpServer.Addr)
		if err := httpServer.ListenAndServe(); err != nil && !errors.Is(err, http.ErrServerClosed) {
			serverErr <- err
		}
		close(serverErr)
	}()

	select {
	case <-stopCtx.Done():
		slog.Info("shutdown signal received")
	case err, ok := <-serverErr:
		if ok && err != nil {
			slog.Error("http server error", "err", err)
		}
	}

	// Graceful shutdown: stop accepting new HTTP requests, then cancel jobs.
	shutdownCtx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	if err := httpServer.Shutdown(shutdownCtx); err != nil {
		slog.Warn("http shutdown error", "err", err)
	}
	pool.shutdown()
	slog.Info("bye")
}
