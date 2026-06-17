// Domain errors. Each carries the HTTP status the API boundary maps it to, so
// the transport layer never hand-codes status numbers (see http-router.ts).

export class DomainError extends Error {
  readonly httpStatus: number;
  constructor(message: string, httpStatus: number) {
    super(message);
    this.name = new.target.name;
    this.httpStatus = httpStatus;
  }
}

/** Bad/again-untrusted input — maps to 400. */
export class ValidationError extends DomainError {
  constructor(message: string) {
    super(message, 400);
  }
}

/** Request conflicts with current state (e.g. overlapping inputs) — 409. */
export class ConflictError extends DomainError {
  constructor(message: string) {
    super(message, 409);
  }
}

/** Resource absent for this tenant — 404. */
export class NotFoundError extends DomainError {
  constructor(message = "not found") {
    super(message, 404);
  }
}

/** A broken internal invariant (e.g. an illegal status transition) — 500. */
export class InvariantError extends DomainError {
  constructor(message: string) {
    super(message, 500);
  }
}
