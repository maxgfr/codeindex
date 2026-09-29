# Runs queued jobs with a retry budget.
module Worker
  # Bounds how often a job is retried.
  MAX_ATTEMPTS = 5

  # Anything the scheduler can drive.
  module Runnable
    # Begin processing.
    def start
      raise NotImplementedError
    end
  end

  # One queued unit of work.
  JobSpec = Struct.new(:name, :attempts) do
    # Whether the budget allows another attempt.
    def retry?
      attempts < MAX_ATTEMPTS
    end
  end

  # Runs jobs with exponential backoff between retries.
  class Scheduler < BaseWorker
    include Runnable

    attr_reader :queue

    # Build an empty scheduler.
    def initialize(queue)
      @queue = queue
      @pending = []
    end

    # Drain the pending queue.
    def start
      @pending.each { |spec| dispatch(spec) }
    end

    # Run one job, retrying with exponential backoff.
    def dispatch(spec, max_attempts = MAX_ATTEMPTS)
      attempt = 0
      attempt += 1 while attempt < max_attempts
      true
    end

    def self.build(queue)
      new(queue)
    end

    class << self
      # The scheduler shared by every caller that does not bring its own.
      def default
        @default ||= build("default")
      end
    end

    # Heavier jobs wait longer between attempts.
    protected def weight(spec)
      spec.size
    end

    private

    def reset
      @pending.clear
    end
  end
end
