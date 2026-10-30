import { z } from 'zod';
import { LANGUAGES } from '../../shared/types';

/** UI text: one string, or one per UI language (`{ en: ..., ru: ... }`). */
export const TextSchema = z.union([z.string(), z.record(z.string(), z.string())]);

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
  /** Directories outside the working directory the agent may access (`claude --add-dir`); `~/` = home. */
  dirs: z.array(z.string()).optional(),
});

/** Fields every cascade level may set (SPEC §3). */
export const LevelShape = {
  /** Coding agent that runs the session. */
  agent: z.enum(['claude', 'pi']).optional(),
  model: z.string().optional(),
  effort: z.string().optional(),
  instructions: InstructionsSchema.optional(),
  permissions: PermissionsSchema.optional(),
  env: z.record(z.string(), z.string()).optional(),
};

export const LevelSchema = z.looseObject(LevelShape);

export const RoleSchema = z.looseObject({
  ...LevelShape,
  title: TextSchema.optional(),
  kind: z.enum(['interactive', 'background']).optional(),
  mcp_access: z.enum(['manage', 'scoped']).optional(),
});

/** Background task kind started by the app itself (module markup, entry point map, ...). */
export const TaskSchema = z.looseObject({
  role: z.string().optional(),
  /** Job title template. */
  title: TextSchema.optional(),
  /** Prompt template file, relative to the directory of the config file that names it. */
  prompt: z.string().optional(),
});

/** Scanner run by the app (SPEC §4, Q10): binary from the system, args and output normalizer from config. */
export const ScannerSchema = z.looseObject({
  enabled: z.boolean().optional(),
  binary: z.string().optional(),
  /** Normalizer of the output. */
  format: z.string().optional(),
  version_args: z.array(z.string()).optional(),
  args: z.array(z.string()).optional(),
  ok_exit_codes: z.array(z.number().int()).optional(),
  timeout_sec: z.number().int().min(1).optional(),
});

/** Relevance of signals to a requirement (by requirement key). */
export const SignalFilterSchema = z.looseObject({
  kinds: z.array(z.string()).optional(),
  cwe: z.array(z.string()).optional(),
  /** Regular expressions over rule ids. */
  rules: z.array(z.string()).optional(),
});

/** Secret of a test account: an env variable of the app or a macOS keychain item. */
export const SecretRefSchema = z.union([
  z.strictObject({ env: z.string().min(1) }),
  z.strictObject({ keychain: z.strictObject({ service: z.string().min(1), account: z.string().min(1) }) }),
]);

export const PocAccountSchema = z.looseObject({
  username: z.string().optional(),
  role: z.string().optional(),
  tenant: z.string().optional(),
  notes: z.string().optional(),
  secrets: z.record(z.string(), SecretRefSchema).optional(),
});

export const ConfigFileSchema = z.looseObject({
  ...LevelShape,
  /** Read from the global config only. */
  ui: z.looseObject({ language: z.enum(LANGUAGES).optional() }).optional(),
  claude: z
    .looseObject({
      binary: z.string().optional(),
      background_args: z.array(z.string()).optional(),
      interactive_args: z.array(z.string()).optional(),
    })
    .optional(),
  pi: z
    .looseObject({
      binary: z.string().optional(),
      background_args: z.array(z.string()).optional(),
      interactive_args: z.array(z.string()).optional(),
      /** Claude Code tool name (as in permissions) -> pi tool names. */
      tools: z.record(z.string(), z.array(z.string())).optional(),
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
  matrix: z
    .looseObject({
      batch_size: z.number().int().min(1).optional(),
      triage_batch_size: z.number().int().min(1).optional(),
      estimate_history_runs: z.number().int().min(1).optional(),
      estimate_tokens_per_cell: z
        .looseObject({ triage: z.number().int().min(1).optional(), verdicts: z.number().int().min(1).optional() })
        .optional(),
    })
    .optional(),
  findings: z.looseObject({ similar_limit: z.number().int().min(1).optional() }).optional(),
  scanners: z.record(z.string(), ScannerSchema).optional(),
  signals: z
    .looseObject({
      auto_scan: z.boolean().optional(),
      max_per_call: z.number().int().min(1).optional(),
      exclude_kinds: z.array(z.string()).optional(),
      requirements: z.record(z.string(), SignalFilterSchema).optional(),
    })
    .optional(),
  suppressions: z
    .looseObject({ few_shot_limit: z.number().int().min(0).optional(), apply_stale: z.boolean().optional() })
    .optional(),
  sca: z
    .looseObject({
      estimate_history_runs: z.number().int().min(1).optional(),
      estimate_tokens_per_package: z.number().int().min(1).optional(),
      scanner_hints_limit: z.number().int().min(0).optional(),
      prefilter_max_file_kb: z.number().int().min(1).optional(),
      report_max_mb: z.number().int().min(1).optional(),
    })
    .optional(),
  poc: z
    .looseObject({
      start_timeout_sec: z.number().int().min(1).optional(),
      healthcheck_interval_sec: z.number().int().min(1).optional(),
      stop_timeout_sec: z.number().int().min(1).optional(),
      check_wait_max_sec: z.number().int().min(1).optional(),
      env_passthrough: z.array(z.string()).optional(),
      claude_settings: z.record(z.string(), z.unknown()).optional(),
      pi_sandbox: z.record(z.string(), z.unknown()).optional(),
      environment: z
        .looseObject({
          start: z.string().optional(),
          healthcheck: z.string().optional(),
          stop: z.string().optional(),
          base_url: z.string().optional(),
          accounts: z.record(z.string(), PocAccountSchema).optional(),
        })
        .optional(),
    })
    .optional(),
  tasks: z.record(z.string(), TaskSchema).optional(),
  roles: z.record(z.string(), RoleSchema).optional(),
  modules: z.record(z.string(), LevelSchema).optional(),
  /** Cascade level of a matrix, by matrix name. */
  matrices: z.record(z.string(), LevelSchema).optional(),
  /** Cascade level of a requirement, by its key. */
  requirements: z.record(z.string(), LevelSchema).optional(),
});

export type Text = z.infer<typeof TextSchema>;
export type Instructions = z.infer<typeof InstructionsSchema>;
export type Level = z.infer<typeof LevelSchema>;
export type RoleConfig = z.infer<typeof RoleSchema>;
export type ConfigFile = z.infer<typeof ConfigFileSchema>;

/** Settings that are not cascade levels; merged global -> project. */
export const SETTINGS_KEYS = [
  'claude',
  'pi',
  'queue',
  'limits',
  'terminal',
  'sessions',
  'matrix',
  'findings',
  'tasks',
  'scanners',
  'signals',
  'suppressions',
  'sca',
  'poc',
] as const;
