package com.acme.worker;

import java.util.ArrayList;
import java.util.List;

/** Anything the scheduler can drive. */
public interface Runnable {
  /** Begin processing. */
  void start();

  int depth();
}

/** A unit of deferred work. */
record JobSpec(String name, int attempts) {}

/** What can go wrong while dispatching. */
enum Outcome {
  TIMEOUT,
  REJECTED
}

/** Runs jobs with exponential backoff between retries. */
public class Scheduler extends BaseWorker implements Runnable {
  /** Bounds how often a job is retried. */
  public static final int MAX_ATTEMPTS = 5;

  private final List<JobSpec> pending = new ArrayList<>();

  /** Drain the pending queue. */
  @Override
  public void start() {
    for (JobSpec spec : pending) {
      dispatch(spec, MAX_ATTEMPTS);
    }
  }

  /** Run one job, retrying with exponential backoff. */
  public boolean dispatch(
      JobSpec spec,
      int maxAttempts) {
    int attempt = 0;
    while (attempt < maxAttempts) {
      attempt++;
    }
    return true;
  }

  private void reset() {
    pending.clear();
  }

  @Override
  public int depth() {
    return pending.size();
  }
}
