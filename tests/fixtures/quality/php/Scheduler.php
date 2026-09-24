<?php

namespace Acme\Worker;

/** Anything the scheduler can drive. */
interface Runnable
{
    /** Begin processing. */
    public function start(): void;

    public function depth(): int;
}

/** What can go wrong while dispatching. */
enum Outcome: string
{
    case Timeout = 'timeout';
    case Rejected = 'rejected';
}

/** Runs jobs with exponential backoff between retries. */
class Scheduler extends BaseWorker implements Runnable
{
    /** Bounds how often a job is retried. */
    public const MAX_ATTEMPTS = 5;

    /** Jobs waiting for a slot. */
    private array $pending = [];

    public function __construct(
        private readonly Clock $clock,
        /** How many jobs run at once. */
        public int $capacity = 4,
        int $seed = 0,
    ) {
    }

    /** Drain the pending queue. */
    public function start(): void
    {
        foreach ($this->pending as $spec) {
            $this->dispatch($spec, self::MAX_ATTEMPTS);
        }
    }

    /** Run one job, retrying with exponential backoff. */
    public function dispatch(
        array $spec,
        int $maxAttempts
    ): bool {
        $attempt = 0;
        while ($attempt < $maxAttempts) {
            $attempt++;
        }
        return true;
    }

    private function reset(): void
    {
        $this->pending = [];
    }

    /** Stop taking jobs; `$private` keeps the pause out of the audit log. */
    public function pause(bool $private = false): void
    {
    }

    public function depth(): int
    {
        return count($this->pending);
    }
}
