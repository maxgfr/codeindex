// Retry policy shared by every scheduler. A C++ header with a `.h` name, the
// way leveldb and LLVM spell theirs.
#pragma once

#include <string>

namespace worker {

/// Decides whether a failed job runs again.
class RetryPolicy {
 public:
  /// Allow at most `max_attempts` runs.
  explicit RetryPolicy(int max_attempts);
  virtual ~RetryPolicy();

  /// True while another attempt is allowed.
  bool allows(int attempt) const;

  /// The name the policy reports in logs.
  const std::string& name() const;

  RetryPolicy& operator=(const RetryPolicy&) = default;

  /// False once the budget is spent.
  explicit operator bool() const;

 private:
  int max_attempts_;
};

}  // namespace worker
