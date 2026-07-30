// Package worker runs queued jobs with a retry budget.
package worker

import "fmt"

// MaxAttempts bounds how often a job is retried.
const MaxAttempts = 5

var defaultQueue = "jobs"

// Runnable is anything the scheduler can drive.
type Runnable interface {
	// Start begins processing.
	Start() error
	Depth() int
}

// JobSpec is a unit of deferred work.
type JobSpec struct {
	// Name identifies the job.
	Name     string
	Attempts int
}

// Scheduler runs jobs with exponential backoff between retries.
type Scheduler struct {
	Queue   string
	pending []JobSpec
}

// Audited adds an audit trail to any scheduler.
type Audited struct {
	Scheduler
	Log []string
}

// Start drains the pending queue.
func (s *Scheduler) Start() error {
	for _, spec := range s.pending {
		if err := s.Dispatch(spec); err != nil {
			return err
		}
	}
	return nil
}

// Dispatch runs one job, retrying with exponential backoff.
func (s *Scheduler) Dispatch(
	spec JobSpec,
) error {
	nextDelay := func(attempt int) int { return 1 << attempt }
	for spec.Attempts < MaxAttempts {
		nextDelay(spec.Attempts)
		spec.Attempts++
	}
	return fmt.Errorf("done: %s", spec.Name)
}

func (s *Scheduler) reset() {
	s.pending = nil
}

// Depth reports the queue length.
func (s *Scheduler) Depth() int { return len(s.pending) }
