// Runs queued jobs with a retry budget.
#ifndef ACME_SCHEDULER_H
#define ACME_SCHEDULER_H

#include <stddef.h>

/** Bounds how often a job is retried. */
extern const int acme_max_attempts;

/** What can go wrong while dispatching. */
enum acme_outcome {
  ACME_TIMEOUT,
  ACME_REJECTED,
};

/** A unit of deferred work. */
struct acme_job {
  /** Identifies the job. */
  const char *name;
  unsigned attempts;
};

/** Either the job that ran, or why it never did. */
union acme_result {
  struct acme_job job;
  enum acme_outcome outcome;
};

/** Opaque scheduler handle. */
typedef struct acme_scheduler acme_scheduler_t;

/** Drain the pending queue. */
int acme_start(acme_scheduler_t *sched);

/** Run one job, retrying with exponential backoff. */
int acme_dispatch(
    acme_scheduler_t *sched,
    struct acme_job *job,
    int max_attempts);

size_t acme_pending_count(const acme_scheduler_t *sched);

/** Queue depth, for backpressure. */
static inline size_t acme_depth(const acme_scheduler_t *sched) {
  return acme_pending_count(sched);
}

#endif /* ACME_SCHEDULER_H */
