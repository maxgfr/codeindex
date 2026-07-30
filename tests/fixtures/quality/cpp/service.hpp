// Runs queued jobs with a retry budget.
#pragma once

#include <string>
#include <vector>

namespace worker {

namespace detail {
/// Milliseconds to wait before attempt `n`.
int backoff_ms(int n);
}  // namespace detail

/// Shorthand for the retry helpers.
namespace retry = detail;

/// Bounds how often a job is retried.
constexpr int kMaxAttempts = 5;

/// What can go wrong while dispatching.
enum class Outcome {
  Timeout,
  Rejected,
};

/// A unit of deferred work.
struct JobSpec {
  /// Identifies the job.
  std::string name;
  int attempts;
};

/// Anything the scheduler can drive.
class Runnable {
 public:
  virtual void start() = 0;
  virtual int depth() const = 0;

 protected:
  /// Milliseconds to wait before attempt `n`.
  int backoff(int n) const;
};

/// Runs jobs with exponential backoff between retries.
class Scheduler : public Runnable {
 public:
  /// Retry delays are part of the public contract here.
  using Runnable::backoff;

  /// Lets the test harness read the queue directly.
  friend class Inspector;

  /// Drain the pending queue.
  void start() override;

  /// Run one job, retrying with exponential backoff.
  bool dispatch(
      const JobSpec& spec,
      int max_attempts);

  int depth() const override;

 private:
  std::vector<JobSpec> pending_;
};

}  // namespace worker
