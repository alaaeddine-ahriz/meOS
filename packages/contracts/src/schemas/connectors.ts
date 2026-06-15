import { z } from "zod";

export const ConnectorKindSchema = z.enum(["contacts", "calendar", "gmail"]);

export const ConnectorKindStatusSchema = z.object({
  kind: ConnectorKindSchema,
  enabled: z.boolean(),
  intervalMinutes: z.number(),
  lastSyncedAt: z.string().nullable(),
  lastStatus: z.string().nullable(),
});

/** GET /api/connectors and the response of most connector mutations. */
export const ConnectorStatusSchema = z.object({
  google: z.object({
    connected: z.boolean(),
    accountEmail: z.string().nullable(),
    hasCredentials: z.boolean(),
    kinds: z.array(ConnectorKindStatusSchema),
  }),
});

/** PUT /api/connectors/google/credentials */
export const GoogleCredentialsBody = z.object({
  clientId: z.string().min(1),
  clientSecret: z.string().min(1),
});

/** POST /api/connectors/google/auth/start */
export const AuthStartResponse = z.object({ url: z.string() });

/** GET /api/connectors/google/callback */
export const ConnectorCallbackQuery = z.object({
  code: z.string().optional(),
  state: z.string().optional(),
  error: z.string().optional(),
});

/** PUT /api/connectors/google/:kind/config , POST /api/connectors/google/:kind/sync */
export const ConnectorKindParam = z.object({ kind: z.string().min(1) });
export const ConfigureKindBody = z.object({
  enabled: z.boolean().optional(),
  intervalMinutes: z.number().optional(),
});

/** POST /api/connectors/google/:kind/sync */
export const SyncKindResponse = z.object({ syncing: z.boolean() });

/** DELETE /api/connectors/google */
export const DisconnectResponse = z.object({ disconnected: z.boolean() });

export type ConnectorKind = z.infer<typeof ConnectorKindSchema>;
export type ConnectorKindStatus = z.infer<typeof ConnectorKindStatusSchema>;
export type ConnectorStatus = z.infer<typeof ConnectorStatusSchema>;
