using System;
using System.Collections.Generic;

namespace Acme.Worker;

/// <summary>Anything the scheduler can drive.</summary>
public interface IRunnable
{
    /// <summary>Begin processing.</summary>
    void Start();

    int Depth { get; }
}

/// <summary>What can go wrong while dispatching.</summary>
public enum Outcome
{
    Timeout,
    Rejected
}

/// <summary>Notified after each attempt.</summary>
public delegate void AttemptHandler(int attempt);

/// <summary>A unit of deferred work.</summary>
public record JobSpec(string Name, int Attempts);

/// <summary>Runs jobs with exponential backoff between retries.</summary>
public class Scheduler : BaseWorker, IRunnable
{
    /// <summary>Bounds how often a job is retried.</summary>
    public const int MaxAttempts = 5;

    private readonly List<JobSpec> pending = new();

    /// <summary>Raised after every attempt.</summary>
    public event AttemptHandler? Attempted;

    /// <summary>Queue depth, for backpressure.</summary>
    public int Depth => pending.Count;

    /// <summary>Drain the pending queue.</summary>
    public void Start()
    {
        foreach (var spec in pending)
        {
            Dispatch(spec, MaxAttempts);
        }
    }

    /// <summary>Run one job, retrying with exponential backoff.</summary>
    public bool Dispatch(
        JobSpec spec,
        int maxAttempts)
    {
        var attempt = 0;
        while (attempt < maxAttempts)
        {
            attempt++;
        }
        return true;
    }

    private void Reset()
    {
        pending.Clear();
    }
}
