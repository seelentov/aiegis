import { z } from 'zod';

export const InstructionsSchema = z.union([
  z.string(),
  z.object({
    mode: z.enum(['append', 'replace']).optional(),
    text: z.string().optional(),
    file: z.union([z.string(), z.array(z.string())]).optional(),
  }),
]);

export const PermissionsSchema = z.object({
  allow: z.array(z.string()).optional(),
  deny: z.array(z.string()).optional(),
});

/** Fields every cascade level may set (SPEC §3). */
export const LevelShape = {
  model: z.string().optional(),
  effort: z.string().optional(),
  instructions: InstructionsSchema.optional(),
  permissions: PermissionsSchema.optional(),
  env: z.record(z.string(), z.string()).optional(),
};

export const LevelSchema = z.looseObject(LevelShape);

export const RoleSchema = z.looseObject({
  ...LevelShape,
  title: z.string().optional(),
  kind: z.enum(['interactive', 'background']).optional(),
  mcp_access: z.enum(['manage', 'scoped']).optional(),
});

/** Background task kind started by the app itself (module markup, entry point map, ...). */
export const TaskSchema = z.looseObject({
  role: z.string().optional(),
  /** Job title template. */
  title: z.string().optional(),
  /** Prompt template file, relative to the directory of the config file that names it. */
  prompt: z.string().optional(),
});

export const ConfigFileSchema = z.looseObject({
  ...LevelShape,
  claude: z
    .looseObject({
      binary: z.string().optional(),
      background_args: z.array(z.string()).optional(),
      interactive_args: z.array(z.string()).optional(),
    })
    .optional(),
  queue: z
    .looseObject({
      parallelism: z.number().int().min(1).optional(),
      rate_limit_fallback_pause_sec: z.number().int().min(1).optional(),
    })
    .optional(),
  limits: z.looseObject({ max_tokens_per_run: z.number().int().min(1).optional() }).optional(),
  terminal: z.looseObject({ external_app: z.string().optional() }).optional(),
  sessions: z.looseObject({ free_role: z.string().optional(), default_task_role: z.string().optional() }).optional(),
  tasks: z.record(z.string(), TaskSchema).optional(),
  roles: z.record(z.string(), RoleSchema).optional(),
  modules: z.record(z.string(), LevelSchema).optional(),
});

export type Instructions = z.infer<typeof InstructionsSchema>;
export type Level = z.infer<typeof LevelSchema>;
export type RoleConfig = z.infer<typeof RoleSchema>;
export type ConfigFile = z.infer<typeof ConfigFileSchema>;

/** Settings that are not cascade levels; merged global -> project. */
export const SETTINGS_KEYS = ['claude', 'queue', 'limits', 'terminal', 'sessions', 'tasks'] as const;
