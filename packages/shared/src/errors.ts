import type { ErrorRequestHandler, RequestHandler } from "express";
import { ZodError } from "zod";

// Every error code the public API can return (backend spec, section 7.1).
export const ERROR_STATUS = {
  VALIDATION_FAILED: 400,
  INVALID_CURSOR: 400,
  UNAUTHENTICATED: 401,
  INVALID_CREDENTIALS: 401,
  REFRESH_INVALID: 401,
  FORBIDDEN: 403,
  NOT_A_MEMBER: 403,
  NOT_FOUND: 404,
  USERNAME_TAKEN: 409,
  CLIENT_MESSAGE_ID_REUSED: 409,
  PAYLOAD_TOO_LARGE: 413,
  DEPENDENCY_UNAVAILABLE: 503,
  INTERNAL: 500,
} as const;

export type ErrorCode = keyof typeof ERROR_STATUS;

// Throw one of these anywhere in a request; the error middleware turns it into the
// standard error body. Express 5 forwards errors thrown in async handlers by itself.
export class AppError extends Error {
  readonly status: number;

  constructor(
    readonly code: ErrorCode,
    message: string,
    readonly details: unknown = null,
  ) {
    super(message);
    this.status = ERROR_STATUS[code];
  }
}

export const notFoundHandler: RequestHandler = (_req, _res, next) => {
  next(new AppError("NOT_FOUND", "No such route"));
};

// Turns any error into { error: { code, message, requestId, details } }.
export const errorHandler: ErrorRequestHandler = (err, req, res, _next) => {
  let appError: AppError;
  if (err instanceof AppError) {
    appError = err;
  } else if (err instanceof ZodError) {
    appError = new AppError("VALIDATION_FAILED", "The request is not valid", err.issues);
  } else if (err?.type === "entity.too.large") {
    appError = new AppError("PAYLOAD_TOO_LARGE", "The request body is too large");
  } else if (err?.type === "entity.parse.failed") {
    appError = new AppError("VALIDATION_FAILED", "The request body is not valid JSON");
  } else {
    // Anything unexpected: log it in full, but never send a stack trace to the client.
    req.log?.error({ err }, "unhandled error");
    appError = new AppError("INTERNAL", "Something went wrong");
  }

  res.status(appError.status).json({
    error: {
      code: appError.code,
      message: appError.message,
      requestId: req.id ?? null,
      details: appError.details,
    },
  });
};
