import type { NextFunction, Request, Response } from "express";
import { AppError, NotFoundError } from "@evs/core/errors";
import logger from "@evs/core/logger";
import { ZodError } from "zod";

const isProduction = process.env.NODE_ENV === "production";

/** 404 for any route nothing else matched. */
export const notFound = (req: Request): never => {
  throw new NotFoundError(`No route for ${req.method} ${req.path}`);
};

/**
 * Global error handler. Typed AppErrors map to their status and stable `code`;
 * zod failures become 400 with per-field details; everything else is a 500
 * whose message is hidden in production. The request id is in every body, so a
 * user-reported error is one grep away from its log line.
 */
export const errorHandler = (err: unknown, req: Request, res: Response, _next: NextFunction): void => {
  if (res.headersSent) {
    logger.warn("error after headers were sent", { requestId: req.requestId, err: String(err) });
    res.end();
    return;
  }

  // Body-parser failures (malformed JSON, oversized payloads) carry a status.
  const parserStatus = (err as { status?: number; type?: string }).status;
  const parserType = (err as { type?: string }).type;

  let status = 500;
  let code = "internal";
  let message = "Internal server error";
  let details: Record<string, unknown> | undefined;

  if (err instanceof AppError) {
    status = err.statusCode;
    code = err.code;
    message = err.message;
    details = err.details;
  } else if (err instanceof ZodError) {
    status = 400;
    code = "validation_failed";
    message = "Request validation failed";
    details = {
      issues: err.issues.map((i) => ({ path: i.path.join("."), message: i.message })),
    };
  } else if (parserStatus && parserStatus >= 400 && parserStatus < 500) {
    status = parserStatus;
    code = parserType === "entity.too.large" ? "payload_too_large" : "bad_request";
    message = (err as Error).message;
  } else if (err instanceof Error && !isProduction) {
    message = err.message;
  }

  const log = status >= 500 ? logger.error.bind(logger) : logger.info.bind(logger);
  log(`${req.method} ${req.path} -> ${status} ${code}`, {
    requestId: req.requestId,
    ...(status >= 500 && err instanceof Error ? { err: err.message, stack: err.stack } : {}),
  });

  res.status(status).json({
    error: { code, message, requestId: req.requestId, ...(details ? { details } : {}) },
  });
};
