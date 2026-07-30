//! Runs queued jobs with a retry budget.

use std::fmt;

extern "C" {
    /// Retry budget the host process enforces.
    fn c_max_attempts(queue: *const u8) -> i32;
    static C_DEFAULT_QUEUE: i32;
}

/// Bounds how often a job is retried.
pub const MAX_ATTEMPTS: u32 = 5;

static DEFAULT_QUEUE: &str = "jobs";

/// Anything the scheduler can drive.
pub trait Runnable {
    /// Begin processing.
    fn start(&mut self) -> Result<(), Error>;

    /// Queue depth, for backpressure.
    fn depth(&self) -> usize {
        0
    }
}

/// A unit of deferred work.
pub struct JobSpec {
    /// Identifies the job.
    pub name: String,
    attempts: u32,
}

/// What can go wrong while dispatching.
pub enum Error {
    Timeout,
    Rejected(String),
}

/// Runs jobs with exponential backoff between retries.
pub struct Scheduler {
    pub queue: String,
    pending: Vec<JobSpec>,
}

impl Scheduler {
    /// Build an empty scheduler.
    pub fn new(queue: String) -> Self {
        Scheduler { queue, pending: Vec::new() }
    }

    /// Run one job, retrying with exponential backoff.
    pub fn dispatch(
        &mut self,
        spec: &mut JobSpec,
    ) -> Result<(), Error> {
        /// Milliseconds to wait before attempt `n`.
        fn backoff(n: u32) -> u32 {
            1 << n
        }
        while spec.attempts < MAX_ATTEMPTS {
            spec.attempts += 1;
            let _ = backoff(spec.attempts);
        }
        Ok(())
    }

    fn reset(&mut self) {
        self.pending.clear();
    }
}

impl Runnable for Scheduler {
    fn start(&mut self) -> Result<(), Error> {
        self.reset();
        Ok(())
    }
}

impl fmt::Display for Error {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "error")
    }
}
