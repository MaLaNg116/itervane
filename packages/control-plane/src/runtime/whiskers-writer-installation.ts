import { operationsRestartInstallationSchema, whiskersMcpKeySchema } from '@itervane/contracts';
import { sha256 } from '@itervane/runner';
import { z } from 'zod';
import { readInstallationFile } from '../installation-files.js';
import type { WhiskersContainerBinding } from './whiskers-mcp.js';
import { WhiskersRestartClient } from './whiskers-restart.js';

const referenceTools = ['get_container_details', 'get_container_logs', 'get_container_metrics', 'restart_container'] as const;
const sealedPolicy = z.strictObject({
  ActivePreset: z.string().min(1).max(128),
  Presets: z.tuple([z.strictObject({
    Name: z.string().min(1).max(128),
    Policy: z.strictObject({
      MaxAutonomousLevel: z.literal('read'),
      RequireConfirmationForWrites: z.literal(true),
      ToolMode: z.literal('allow'),
      ToolAllowList: z.array(z.enum(referenceTools)).length(referenceTools.length).refine(items => new Set(items).size === referenceTools.length),
      ProtectedResources: z.tuple([z.literal('whiskers*'), z.literal('serverwatch*')]),
      MaxActionsPerSession: z.literal(12),
    }),
  })]),
}).refine(config => config.Presets[0].Name === config.ActivePreset);

const offlineAdministrator = 'offline-admin@example.invalid';
const sealedRoles = z.strictObject({
  Roles: z.array(z.strictObject({ Email: z.email(), Role: z.union([z.literal(1), z.literal(2)]) })).length(2)
    .refine(roles => roles.some(role => role.Role === 2 && role.Email.toLowerCase() === offlineAdministrator)
      && roles.some(role => role.Role === 1 && role.Email.toLowerCase() !== offlineAdministrator)),
  DefaultRole: z.literal(0),
});

export type WhiskersWriterFiles = Readonly<{ installation: string; guardrails: string; roles: string }>;
export class WhiskersWriterInstallationRejected extends Error {
  constructor() { super('whiskers_writer_installation_rejected'); }
}

export async function loadWhiskersWriter(files: WhiskersWriterFiles, rawWriteKey: unknown) {
  try {
    const writeKey = whiskersMcpKeySchema.parse(rawWriteKey);
    const [installation, policy, roles] = await Promise.all([
      readInstallationFile(files.installation), readInstallationFile(files.guardrails), readInstallationFile(files.roles),
    ]);
    const document = operationsRestartInstallationSchema.parse(JSON.parse(installation.toString('utf8')));
    sealedPolicy.parse(JSON.parse(policy.toString('utf8')));
    sealedRoles.parse(JSON.parse(roles.toString('utf8')));
    if (sha256(policy) !== document.policySha256 || sha256(roles) !== document.rolesSha256 || sha256(writeKey) !== document.credentialSha256) {
      throw new WhiskersWriterInstallationRejected();
    }
    const proof = Object.freeze({ installationId: document.installationId, credentialSha256: document.credentialSha256,
      installationSha256: sha256(JSON.stringify(document)) });
    return {
      proof,
      connect(target: WhiskersContainerBinding) {
        if (target.origin !== document.whiskers.origin || target.serverId !== document.whiskers.serverId) {
          throw new WhiskersWriterInstallationRejected();
        }
        return new WhiskersRestartClient(target, writeKey);
      },
    };
  } catch {
    // The installation, schema failure and credential are private.
    throw new WhiskersWriterInstallationRejected();
  }
}
