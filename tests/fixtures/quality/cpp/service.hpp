// Runs queued jobs with a retry budget.
#pragma once

#include <string>
#include <vector>

namespace worker {

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
};

/// Runs jobs with exponential backoff between retries.
class Scheduler : public Runnable {
 public:
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
