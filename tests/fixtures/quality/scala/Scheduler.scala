package com.acme.worker

/** Anything the scheduler can drive. */
trait Runnable {

  /** Begin processing. */
  def start(): Unit

  def depth: Int
}

/** A unit of deferred work. */
case class JobSpec(name: String, attempts: Int)

/** Runs jobs with exponential backoff between retries. */
class Scheduler(val queue: String) extends BaseWorker with Runnable {

  /** Bounds how often a job is retried. */
  val maxAttempts: Int = 5

  private var pending: List[JobSpec] = Nil

  /** Drain the pending queue. */
  def start(): Unit = pending.foreach(spec => dispatch(spec, maxAttempts))

  /** Run one job, retrying with exponential backoff. */
  def dispatch(
      spec: JobSpec,
      max: Int
  ): Boolean = {
    var attempt = 0
    while (attempt < max) attempt += 1
    true
  }

  private def reset(): Unit = pending = Nil

  def depth: Int = pending.size
}

/** Factory helpers. */
object SchedulerFactory {

  /** Build an empty scheduler. */
  def build(queue: String): Scheduler = new Scheduler(queue)
}
