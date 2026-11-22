import { open } from 'node:fs/promises';

export async function readRegistrationFile(args: string[]): Promise<unknown> {
  const [path, ...extra] = args;
  if (!path || extra.length) throw new Error('registration_config_path');
  const file = await open(path, 'r');
  try {
    const info = await file.stat();
    if (!info.isFile() || info.size > 4096) throw new Error('registration_config_file');
    const data = Buffer.alloc(4097);
    const { bytesRead } = await file.read(data, 0, data.length, 0);
    if (bytesRead !== info.size) throw new Error('registration_config_size');
    return JSON.parse(data.toString('utf8', 0, bytesRead));
  } finally { await file.close(); }
}
