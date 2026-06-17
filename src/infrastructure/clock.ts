// System clock adapter for the Clock port. The wall clock lives behind this
// seam so use cases stay deterministic and testable (tests inject a fixed clock).

import type { Clock } from "../application/ports.ts";

export class SystemClock implements Clock {
  now(): number {
    return Math.floor(Date.now() / 1000);
  }
}
