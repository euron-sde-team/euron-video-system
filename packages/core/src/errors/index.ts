/**
 * Typed HTTP errors. Services throw these; the API's global error handler maps
 * them to a status code and a stable machine-readable `code`. Anything that is
 * not an AppError becomes a 500 with its message hidden in production.
 */
export abstract class AppError extends Error {
  abstract readonly statusCode: number;
  abstract readonly code: string;

  constructor(
    message: string,
    public readonly details?: Record<string, unknown>
  ) {
    super(message);
    this.name = new.target.name;
  }
}

export class BadRequestError extends AppError {
  readonly statusCode = 400;
  readonly code = "bad_request";
}

export class UnauthorizedError extends AppError {
  readonly statusCode = 401;
  readonly code = "unauthorized";
}

export class ForbiddenError extends AppError {
  readonly statusCode = 403;
  readonly code = "forbidden";
}

export class NotFoundError extends AppError {
  readonly statusCode = 404;
  readonly code = "not_found";
}

export class ConflictError extends AppError {
  readonly statusCode = 409;
  readonly code = "conflict";
}

export class UnprocessableError extends AppError {
  readonly statusCode = 422;
  readonly code = "unprocessable";
}

export class TooManyRequestsError extends AppError {
  readonly statusCode = 429;
  readonly code = "rate_limited";
}

export class InternalServerError extends AppError {
  readonly statusCode = 500;
  readonly code = "internal";
}
