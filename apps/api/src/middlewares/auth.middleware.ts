import type { NextFunction, Request, Response } from "express";
import { ForbiddenError, UnauthorizedError } from "@evs/core/errors";
import { hasScopes, type Scope } from "../services/api-key-format.js";
import apiKeysService from "../services/api-keys.service.js";

const extractBearer = (req: Request): string | undefined => {
  const header = req.headers.authorization;
  if (!header) return undefined;
  const [scheme, value] = header.split(" ");
  return scheme?.toLowerCase() === "bearer" && value ? value.trim() : undefined;
};

/**
 * Management API authentication: `Authorization: Bearer evs_<prefix>_<secret>`.
 * Attaches the verified key (id, name, scopes) to req.auth.
 */
export const requireApiKey = async (req: Request, _res: Response, next: NextFunction): Promise<void> => {
  const presented = extractBearer(req);
  if (!presented) throw new UnauthorizedError("Missing API key (Authorization: Bearer evs_...)");
  req.auth = await apiKeysService.authenticate(presented);
  next();
};

/** Authorization: the authenticated key must hold every listed scope ("*" holds all). */
export const requireScope =
  (...scopes: Scope[]) =>
  (req: Request, _res: Response, next: NextFunction): void => {
    if (!req.auth) throw new UnauthorizedError("Missing API key");
    if (!hasScopes(req.auth.scopes, scopes)) {
      throw new ForbiddenError(`This API key lacks the required scope: ${scopes.join(", ")}`, { required: scopes });
    }
    next();
  };

export { extractBearer };
