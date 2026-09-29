// Out-of-line definitions for the scheduler declared in service.hpp.
#include "service.hpp"

namespace worker {

/// Milliseconds to wait before attempt `n`.
int detail::backoff_ms(int n) { return 1 << n; }

/// Drain the pending queue.
void Scheduler::start() {}

bool Scheduler::dispatch(const JobSpec& spec, int max_attempts) {
  return spec.attempts < max_attempts;
}

int Scheduler::depth() const { return 0; }

/// Two specs name the same job when their names match.
bool operator==(const JobSpec& a, const JobSpec& b) { return a.name == b.name; }

}  // namespace worker
