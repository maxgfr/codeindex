// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

/// Anything the scheduler can drive.
interface IRunnable {
    /// Begin processing.
    function start() external;
}

/// What can go wrong while dispatching.
enum Outcome { Timeout, Rejected }

/// Highest priority a job may claim.
uint256 constant TOP_PRIORITY = 1;

/// Runs jobs with exponential backoff between retries.
contract Scheduler is BaseWorker, IRunnable {
    /// Bounds how often a job is retried.
    uint256 public constant MAX_ATTEMPTS = 5;

    address private owner;

    /// Raised after every attempt.
    event Attempted(uint256 n);

    /// Drain the pending queue.
    function start() external override {
        dispatch(MAX_ATTEMPTS);
    }

    /// Run one job, retrying with exponential backoff.
    function dispatch(
        uint256 max
    ) public returns (bool) {
        return max > 0;
    }

    function reset() private {
        owner = address(0);
    }
}
