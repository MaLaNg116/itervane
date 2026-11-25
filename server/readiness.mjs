export function sendReadiness(client, mode, version) {
  const statusCode = mode === 'healthy' ? 200 : 503;
  return client.status(statusCode).json({ status: mode, version });
}
