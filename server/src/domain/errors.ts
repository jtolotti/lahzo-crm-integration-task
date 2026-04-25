export class AppError extends Error {
  constructor(
    message: string,
    public readonly statusCode: number = 500,
    public readonly code: string = 'INTERNAL_ERROR',
  ) {
    super(message);
    this.name = this.constructor.name;
  }
}

export class NotFoundError extends AppError {
  constructor(resource: string, id: string) {
    super(`${resource} not found: ${id}`, 404, 'NOT_FOUND');
  }
}

export class DuplicateEventError extends AppError {
  constructor(eventId: string) {
    super(`Duplicate event: ${eventId}`, 409, 'DUPLICATE_EVENT');
  }
}

export class StaleEventError extends AppError {
  constructor(eventId: string) {
    super(`Stale event skipped: ${eventId}`, 409, 'STALE_EVENT');
  }
}

export class UnauthorizedError extends AppError {
  constructor(message = 'Invalid credentials') {
    super(message, 401, 'UNAUTHORIZED');
  }
}

export class InvalidTransitionError extends AppError {
  constructor(from: string, to: string) {
    super(`Invalid status transition: ${from} → ${to}`, 409, 'INVALID_TRANSITION');
  }
}

export class RateLimitError extends AppError {
  constructor(
    public readonly retryAfterMs: number,
  ) {
    super(`CRM rate limit hit, retry after ${retryAfterMs}ms`, 429, 'RATE_LIMITED');
  }
}

export class TransientCrmError extends AppError {
  constructor(statusCode: number, body: string) {
    super(`CRM transient error: ${statusCode} — ${body}`, statusCode, 'TRANSIENT_CRM_ERROR');
  }
}
