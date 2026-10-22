import { z } from "zod";

/** Shared page/limit query schema: page >= 1, 1 <= limit <= 100, default 20. */
export const paginationQuery = {
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(20),
};

export interface Page<T> {
  data: T[];
  pagination: { page: number; limit: number; total: number };
}

export const page = <T>(data: T[], pageNo: number, limit: number, total: number): Page<T> => ({
  data,
  pagination: { page: pageNo, limit, total },
});

/** ISO string or null, for any Date-ish column. */
export const iso = (v: Date | string | null | undefined): string | null =>
  v === null || v === undefined ? null : v instanceof Date ? v.toISOString() : new Date(v).toISOString();
