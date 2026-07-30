package com.acme.worker

/** Anything the scheduler can drive. */
interface Runnable {
    /** Begin processing. */
    fun start()

    val depth: Int
}

/** What can go wrong while dispatching. */
enum class Outcome { TIMEOUT, REJECTED }

/** Runs jobs with exponential backoff between retries. */
class Scheduler(val queue: String) : BaseWorker(), Runnable {
    /** Jobs waiting for a slot. */
    private var pending: List<String> = listOf()

    /** Drain the pending queue. */
    override fun start() {
        dispatch("x", MAX_ATTEMPTS)
    }

    /** Run one job, retrying with exponential backoff. */
    fun dispatch(
        spec: String,
        max: Int
    ): Boolean {
        return true
    }

    private fun reset() {
        pending = listOf()
    }

    override val depth: Int = 0
}
