import type { Request } from "express";
import type { z } from "zod";

/**
 * Parse request input with a zod schema. Unknown body keys are rejected
 * (schemas are .strict()) and a ZodError becomes a 400 with per-field details
 * in the global error handler. This replaces blanket "sanitizer" middleware:
 * input is validated precisely at the boundary, and output is JSON-encoded.
 */
export const body = <S extends z.ZodTypeAny>(req: Request, schema: S): z.infer<S> => schema.parse(req.body ?? {});
export const query = <S extends z.ZodTypeAny>(req: Request, schema: S): z.infer<S> => schema.parse(req.query ?? {});
export const param = (req: Request, name: string): string => String(req.params[name] ?? "");
