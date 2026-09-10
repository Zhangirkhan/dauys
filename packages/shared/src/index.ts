import { z } from "zod";
export const idSchema = z.string().regex(/^[a-zA-Z0-9_-]{1,80}$/);
const text = z.string().min(1).max(500);
export const safePathSchema = z
  .string()
  .min(1)
  .max(2048)
  .refine(
    (v) => v.startsWith("/") && !/[\x00-\x1f]/.test(v),
    "Нужен абсолютный путь без управляющих символов",
  );
export const safeUrlSchema = z
  .string()
  .max(2048)
  .url()
  .refine((v) => {
    try {
      const u = new URL(v);
      return (
        ["http:", "https:"].includes(u.protocol) && !u.username && !u.password
      );
    } catch {
      return false;
    }
  }, "Разрешены только HTTP(S) URL без пароля");
export const appNameSchema = z
  .string()
  .min(1)
  .max(80)
  .regex(/^[\p{L}\p{N} ._+-]+$/u)
  .refine((v) => !v.startsWith("-") && !v.includes(".."));
const none = z.object({}).strict();
export const actionSchema = z.discriminatedUnion("action", [
  z
    .object({
      action: z.literal("open_application"),
      parameters: z
        .object({
          applicationId: idSchema.optional(),
          query: z.string().trim().min(1).max(200).optional(),
          newWindow: z.boolean().optional(),
          newDocument: z.boolean().optional(),
          title: z.string().trim().min(1).max(80).optional(),
        })
        .strict()
        .refine(
          (v) => !!v.applicationId || !!v.query,
          "Нужен идентификатор или название программы",
        ),
    })
    .strict(),
  z
    .object({
      action: z.literal("close_application"),
      parameters: z
        .object({
          applicationId: idSchema.optional(),
          query: z.string().trim().min(1).max(200).optional(),
          documentOnly: z.boolean().optional(),
        })
        .strict()
        .refine(
          (v) => !!v.applicationId || !!v.query,
          "Нужен идентификатор или название программы",
        ),
    })
    .strict(),
  z
    .object({
      action: z.literal("open_project"),
      parameters: z
        .object({ projectId: idSchema, applicationId: idSchema.optional() })
        .strict(),
    })
    .strict(),
  z
    .object({
      action: z.literal("open_file"),
      parameters: z.object({ path: safePathSchema }).strict(),
    })
    .strict(),
  z
    .object({
      action: z.literal("search_files"),
      parameters: z
        .object({
          query: z.string().max(100).default(""),
          extension: z
            .string()
            .regex(/^[a-zA-Z0-9]{1,12}$/)
            .optional(),
          kind: z
            .enum(["pdf", "presentation", "spreadsheet", "document"])
            .optional(),
          modifiedAfter: z.string().datetime().optional(),
          latest: z.boolean().default(false),
          open: z.boolean().default(true),
        })
        .strict(),
    })
    .strict(),
  z
    .object({
      action: z.literal("search_drive"),
      parameters: z
        .object({
          query: z.string().trim().max(500).default(""),
          open: z.boolean().default(true),
          fileId: z.number().int().positive().optional(),
        })
        .strict()
        .refine((v) => !!v.query || !!v.fileId, "Нужен запрос или файл диска"),
    })
    .strict(),
  z
    .object({
      action: z.literal("open_folder"),
      parameters: z.object({ path: safePathSchema }).strict(),
    })
    .strict(),
  z
    .object({
      action: z.literal("open_named_item"),
      parameters: z
        .object({
          query: z.string().trim().min(1).max(200),
          kind: z.enum(["file", "folder", "any"]).default("any"),
          applicationId: idSchema.optional(),
        })
        .strict(),
    })
    .strict(),
  z
    .object({
      action: z.literal("open_editor_project"),
      parameters: z
        .object({
          query: z.string().trim().max(200).default(""),
          projectKey: z
            .string()
            .regex(/^[a-f0-9]{12}$/)
            .optional(),
          host: z.string().max(120).optional(),
          applicationId: idSchema.optional(),
          newWindow: z.boolean().optional(),
        })
        .strict()
        .refine(
          (v) => !!v.query || !!v.projectKey,
          "Нужно название проекта или его ключ",
        ),
    })
    .strict(),
  z
    .object({
      action: z.literal("open_url"),
      parameters: z
        .object({
          url: safeUrlSchema,
          applicationId: idSchema.optional(),
        })
        .strict(),
    })
    .strict(),
  z
    .object({
      action: z.literal("new_browser_tab"),
      parameters: z.object({ applicationId: idSchema }).strict(),
    })
    .strict(),
  z
    .object({
      action: z.literal("run_shortcut"),
      parameters: z.object({ shortcutId: idSchema }).strict(),
    })
    .strict(),
  z
    .object({
      action: z.literal("set_volume"),
      parameters: z
        .object({ volume: z.number().int().min(0).max(100) })
        .strict(),
    })
    .strict(),
  z
    .object({ action: z.literal("media_play_pause"), parameters: none })
    .strict(),
  z.object({ action: z.literal("take_screenshot"), parameters: none }).strict(),
  z
    .object({ action: z.literal("get_battery_status"), parameters: none })
    .strict(),
  z
    .object({ action: z.literal("get_active_application"), parameters: none })
    .strict(),
  z.object({ action: z.literal("lock_screen"), parameters: none }).strict(),
  z
    .object({
      action: z.literal("run_scenario"),
      parameters: z
        .object({ projectId: idSchema, scenarioId: idSchema })
        .strict(),
    })
    .strict(),
]);
export type Action = z.infer<typeof actionSchema>;
export type AllowedAction = Action["action"];
export const actions = actionSchema.options.map((s) => s.shape.action.value);
export const decisionSchema = z.union([
  z
    .object({
      type: z.literal("execute"),
      action: z.enum(actions as [AllowedAction, ...AllowedAction[]]),
      parameters: z.record(z.unknown()),
      confidence: z.number().min(0).max(1),
      confirmationRequired: z.boolean(),
      spokenResponse: text,
    })
    .strict()
    .superRefine((v, ctx) => {
      const result = actionSchema.safeParse({
        action: v.action,
        parameters: v.parameters,
      });
      if (!result.success)
        ctx.addIssue({ code: "custom", message: result.error.message });
    }),
  z
    .object({
      type: z.literal("clarification"),
      question: text,
      options: z
        .array(z.object({ id: text, label: text }).strict())
        .max(10)
        .optional(),
    })
    .strict(),
  z.object({ type: z.literal("reject"), reason: text }).strict(),
]);
export type AssistantDecision = z.infer<typeof decisionSchema>;
export const registrySchema = z
  .object({
    projects: z
      .array(
        z
          .object({
            id: idSchema,
            name: text,
            description: text,
            aliases: z.array(text).max(30),
            path: safePathSchema,
            defaultApplication: appNameSchema,
            urls: z.record(idSchema, safeUrlSchema),
            scenarios: z.record(idSchema, z.array(actionSchema).max(10)),
          })
          .strict(),
      )
      .max(100),
    applications: z
      .array(
        z
          .object({
            id: idSchema,
            name: appNameSchema,
            aliases: z.array(text).max(30),
            path: safePathSchema.optional(),
          })
          .strict(),
      )
      .max(100),
  })
  .strict()
  .superRefine((v, ctx) => {
    for (const entries of [v.projects, v.applications])
      if (new Set(entries.map((e) => e.id)).size !== entries.length)
        ctx.addIssue({ code: "custom", message: "ID должны быть уникальными" });
    for (const p of v.projects) {
      if (!v.applications.some((a) => a.name === p.defaultApplication))
        ctx.addIssue({
          code: "custom",
          message: "Приложение проекта должно быть в реестре",
        });
      for (const steps of Object.values(p.scenarios))
        if (steps.some((s) => s.action === "run_scenario"))
          ctx.addIssue({
            code: "custom",
            message: "Вложенные сценарии запрещены",
          });
    }
  });
export type Registry = z.infer<typeof registrySchema>;
export const trustSchema = z
  .object({
    shortcuts: z.array(z.object({ id: idSchema, name: text })),
    processes: z.record(
      idSchema,
      z.object({
        executable: safePathSchema,
        args: z.array(z.string().max(2048)).max(30),
        cwd: safePathSchema,
      }),
    ),
  })
  .strict();
export type Trust = z.infer<typeof trustSchema>;
export function requiresConfirmation(action: Action): boolean {
  return [
    "lock_screen",
    "run_scenario",
    "run_shortcut",
    "media_play_pause",
    "take_screenshot",
  ].includes(action.action);
}
export const fileSchema = z
  .object({
    id: z.string(),
    name: z.string(),
    path: safePathSchema,
    modifiedAt: z.string(),
    kind: z.enum(["file", "folder", "project", "drive", "app"]).optional(),
    host: z.string().max(120).optional(),
    url: safeUrlSchema.optional(),
  })
  .strict();
export type FileMatch = z.infer<typeof fileSchema>;
export const resultSchema = z
  .object({
    success: z.boolean(),
    message: z.string().max(10000),
    data: z.record(z.unknown()).optional(),
    files: z.array(fileSchema).max(10).optional(),
  })
  .strict();
export type ExecutionResult = z.infer<typeof resultSchema>;
export const envelopeSchema = z
  .object({
    id: z.string().uuid(),
    createdAt: z.number(),
    expiresAt: z.number(),
    confirmed: z.boolean(),
    command: actionSchema,
    registry: registrySchema,
  })
  .strict()
  .refine(
    (v) => v.expiresAt - v.createdAt <= 60000 && v.expiresAt > v.createdAt,
    "TTL максимум 60 секунд",
  );
export type Envelope = z.infer<typeof envelopeSchema>;
export type Context = {
  activeProject?: string;
  lastApplication?: string;
  lastFile?: string;
  searchResults?: FileMatch[];
  recent: Array<{ text: string; action?: string; response?: string }>;
};
export type CommandStatus =
  | "transcribing"
  | "processing"
  | "confirmation"
  | "clarification"
  | "executing"
  | "done"
  | "error"
  | "cancelled";
export type CommandRecord = {
  id: string;
  deviceId: string;
  agentId: string;
  text: string;
  status: CommandStatus;
  createdAt: number;
  expiresAt: number;
  decision?: AssistantDecision;
  command?: Action;
  result?: ExecutionResult;
  question?: string;
  options?: Array<{ id: string; label: string }>;
  files?: FileMatch[];
  confirmed?: boolean;
  contextVersion?: number;
};
export {
  compileDriveQuery,
  driveSearchVariants,
  extractSpokenDrive,
  mentionsDrive,
  pickDriveHit,
  scoreDriveName,
} from "./drive-query.js";
export {
  extractCloseOffice,
  extractNewOfficeDocument,
  isOfficeAppName,
  officeAppQuery,
  officeKindForExtension,
  spokenOfficeKind,
  type OfficeKind,
} from "./office.js";
