export function sendReadiness(client, mode, version) {
  return client.status(503).json({ status: 'unhealthy', version });
}
