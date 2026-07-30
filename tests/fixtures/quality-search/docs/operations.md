# Operations

## Rate limiting

Every public endpoint sits behind a token bucket. Tune the burst allowance with
`BUCKET_CAPACITY`; requests beyond it are shed with a 429.

## Retries

Outbound calls retry with exponential backoff. Do not raise the attempt count
without also raising the circuit-breaker threshold.
