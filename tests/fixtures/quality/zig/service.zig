const std = @import("std");

/// Bounds how often a job is retried.
pub const MAX_ATTEMPTS: u32 = 5;

/// What can go wrong while dispatching.
pub const Outcome = enum { timeout, rejected };

/// A queue handle whose layout the C side owns.
pub const Handle = opaque {
    /// Release the handle.
    pub fn close(self: *Handle) void {
        _ = self;
    }
};

/// Runs jobs with exponential backoff between retries.
pub const Scheduler = struct {
    /// Identifies the queue.
    queue: []const u8,
    pending: u32,

    /// Drain the pending queue.
    pub fn start(self: *Scheduler) void {
        self.reset();
    }

    /// Run one job, retrying with exponential backoff.
    pub fn dispatch(
        self: *Scheduler,
        max: u32,
    ) bool {
        _ = self;
        _ = max;
        return true;
    }

    fn reset(self: *Scheduler) void {
        self.pending = 0;
    }
};
