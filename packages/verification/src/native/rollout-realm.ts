import { randomBytes, randomUUID } from 'node:crypto';

/** Ephemeral Keycloak identities for the trusted ingress fixtures. */
export function createRolloutRealm(realm: string, origin: string) {
  const appClient = 'demo';
  const appSecret = randomBytes(28).toString('hex');
  const probe = { clientId: 'demo-health', subject: randomUUID(), secret: randomBytes(28).toString('hex') };
  const other = { clientId: 'other-health', subject: randomUUID(), secret: randomBytes(28).toString('hex') };
  const groups = { name: 'groups', protocol: 'openid-connect', protocolMapper: 'oidc-group-membership-mapper', config: {
    'full.path': 'true', 'claim.name': 'groups', 'id.token.claim': 'true', 'access.token.claim': 'true', 'userinfo.token.claim': 'true',
  } };
  const audience = { name: 'app-only', protocol: 'openid-connect', protocolMapper: 'oidc-audience-mapper', config: {
    'included.client.audience': appClient, 'access.token.claim': 'true', 'id.token.claim': 'false',
  } };
  const machine = ({ clientId, secret }: typeof probe) => ({
    clientId, secret, serviceAccountsEnabled: true, standardFlowEnabled: false, publicClient: false,
    protocol: 'openid-connect', fullScopeAllowed: false, protocolMappers: [groups, audience],
  });
  const principal = ({ subject, clientId }: typeof probe, authorized: boolean) => ({
    id: subject, username: 'service-account-' + clientId, enabled: true, serviceAccountClientId: clientId,
    email: clientId + '@example.invalid', emailVerified: true, groups: authorized ? ['/demo'] : [],
  });
  return { appClient, appSecret, probe, other, document: {
    realm, enabled: true, sslRequired: 'none', accessTokenLifespan: 120, groups: [{ name: 'demo' }],
    clients: [{ clientId: appClient, secret: appSecret, enabled: true, publicClient: false, standardFlowEnabled: true,
      protocol: 'openid-connect', redirectUris: [origin + '/oauth2/callback'], protocolMappers: [groups] }, machine(probe), machine(other)],
    users: [principal(probe, true), principal(other, false)],
  } };
}
