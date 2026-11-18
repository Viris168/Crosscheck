import { z } from 'zod';

/** ISO-8601 timestamp string (Dates are serialized as strings over JSON). */
export const IsoDate = z.iso.datetime({ offset: true });
export const Id = z.string().min(1);
