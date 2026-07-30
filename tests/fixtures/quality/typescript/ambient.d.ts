/** Ambient surface consumed by the CLI bundle. */
declare namespace Webhooks {
  /** Build a dispatcher from environment configuration. */
  function createDispatcher(endpoint: string): Envelope;
  const VERSION: string;
}

/** A signed, ready-to-send delivery envelope. */
declare class Envelope {
  readonly id: string;
  sign(secret: string): string;
}

declare function assertNever(value: never): never;
