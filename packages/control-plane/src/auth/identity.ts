import { createRemoteJWKSet, customFetch, errors, jwtVerify } from 'jose';

const identityMarker = Symbol('verified-identity');
export type VerifiedIdentity = Readonly<{ issuer: string; subject: string; [identityMarker]: true }>;
export type IdentityConfig = { issuer: string; audience: string };

export class AuthenticationError extends Error {
  constructor(readonly code: 'unauthenticated' | 'unavailable' = 'unauthenticated') {
    super('Authentication could not be completed');
    this.name = 'AuthenticationError';
  }
}

export function validateIdentityConfig(config: IdentityConfig): IdentityConfig {
  const url = new URL(config.issuer);
  const loopback = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
  if ((url.protocol !== 'https:' && !(url.protocol === 'http:' && loopback)) || url.username || url.password || url.search || url.hash
    || !config.audience || config.audience.length > 255 || config.issuer.length > 2_048) throw new Error('Invalid identity configuration');
  return Object.freeze({ issuer: config.issuer, audience: config.audience });
}

export function createIdentityVerifier(input: IdentityConfig) {
  const config = validateIdentityConfig(input);
  // 只从维护者配置的 realm 取公钥；不读取 token 提供的 jku 或任意 issuer。
  const keys = createRemoteJWKSet(new URL(`${config.issuer.replace(/\/$/, '')}/protocol/openid-connect/certs`), {
    timeoutDuration: 3_000, cooldownDuration: 5_000, cacheMaxAge: 300_000,
    [customFetch]: async (url, init) => {
      try {
        const response = await fetch(url, { ...init, redirect: 'error' });
        if (!response.ok) throw new AuthenticationError('unavailable');
        return response;
      } catch { throw new AuthenticationError('unavailable'); }
    },
  });
  return async (token: string): Promise<VerifiedIdentity> => {
    if (token.length > 16_384) throw new AuthenticationError();
    try {
      const { payload } = await jwtVerify(token, keys, {
        algorithms: ['RS256'], issuer: config.issuer, audience: config.audience, typ: 'JWT',
        requiredClaims: ['sub', 'exp', 'iat', 'typ'], maxTokenAge: '1h', clockTolerance: 5,
      });
      // Keycloak 的 access token 为 Bearer；同 realm 的 ID/refresh token 不能调用 API。
      if (payload.typ !== 'Bearer' || typeof payload.sub !== 'string' || !payload.sub || payload.sub.length > 255) throw new AuthenticationError();
      return Object.freeze({ issuer: config.issuer, subject: payload.sub, [identityMarker]: true as const });
    } catch (error) {
      if (error instanceof AuthenticationError) throw error;
      if (error instanceof errors.JWKSTimeout || error instanceof errors.JWKSInvalid || error instanceof errors.JWKInvalid) throw new AuthenticationError('unavailable');
      throw new AuthenticationError();
    }
  };
}

export function assertVerifiedIdentity(identity: VerifiedIdentity): void {
  if (identity[identityMarker] !== true) throw new AuthenticationError();
}
