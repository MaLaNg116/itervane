import { readInstallationFile } from '../installation-files.js';

export async function readRegistrationFile(args: string[]): Promise<unknown> {
  const [path, ...extra] = args;
  if (!path || extra.length) throw new Error('registration_config_path');
  return JSON.parse((await readInstallationFile(path)).toString('utf8'));
}
