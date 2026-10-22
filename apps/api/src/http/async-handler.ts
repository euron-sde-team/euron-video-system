import type { NextFunction, Request, RequestHandler, Response } from "express";

/**
 * Wraps an async handler or middleware so a rejected promise reaches the global
 * error handler instead of becoming an unhandled rejection. Every route and
 * middleware in this service is registered through asyncHandler.
 */
export const asyncHandler =
  (fn: (req: Request, res: Response, next: NextFunction) => unknown): RequestHandler =>
  (req, res, next) => {
    Promise.resolve(fn(req, res, next)).catch(next);
  };
