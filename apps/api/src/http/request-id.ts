import type { NextFunction, Request, Response } from "express";
import { ulid } from "ulid";

/** Inbound ids are accepted only if they look like ids, never as arbitrary header text. */
const VALID = /^[A-Za-z0-9._:-]{8,128}$/;

/**
 * Every request gets an id: the caller's `X-Request-Id` when it is well formed
 * (so a trace can span the caller and this API), otherwise a fresh ULID. It is
 * echoed on every response and included in every error body and audit event.
 */
export const requestId = (req: Request, res: Response, next: NextFunction): void => {
  const inbound = req.get("x-request-id");
  req.requestId = inbound && VALID.test(inbound) ? inbound : `req_${ulid()}`;
  res.setHeader("X-Request-Id", req.requestId);
  next();
};
