import { z } from 'zod';
import { Severity } from './enums';

export const RepoSettingsSchema = z.object({
  minSeverity: z.enum(Severity).default('medium'),
  ignorePaths: z
    .array(z.string())
    .default(['dist/**', '**/*.lock', 'pnpm-lock.yaml', 'package-lock.json']),
  maxIssuesPerPr: z.number().int().default(30),
  language: z.string().default('en'),
  trigger: z.enum(['every_push', 'on_command']).default('every_push'),
  model: z.string().optional(),
});

export type RepoSettings = z.infer<typeof RepoSettingsSchema>;

/** Settings with every default applied (what a new Repo row stores). */
export const defaultRepoSettings = (): RepoSettings => RepoSettingsSchema.parse({});
