import { describe, expect, it, vi } from 'vitest';
import { createAuthorizedMcpHttpHandler, protectedResourceMetadata } from '../src/httpAuth.js';

describe('HTTP MCP OAuth 2.1 gate', () => {
  it('dispatches an audience-and-scope-bound principal without forwarding its bearer token', async () => {
    const dispatch = vi.fn(async (request, principal) => ({ status: 200, body: { request, principal } }));
    const verifier = { verify: vi.fn(async () => ({
      subject: 'agent-1', fleetId: 'fleet-1', audience: 'https://room.invalid/mcp',
      scopes: ['agent-room:mcp'],
    })) };
    const handler = createAuthorizedMcpHttpHandler({
      resource: 'https://room.invalid/mcp',
      metadataUrl: 'https://room.invalid/.well-known/oauth-protected-resource',
      verifier, dispatch,
    });

    const response = await handler({ headers: { authorization: 'Bearer secret-token', 'x-request-id': 'r-1' } });

    expect(response.status).toBe(200);
    expect(verifier.verify).toHaveBeenCalledWith('secret-token', {
      resource: 'https://room.invalid/mcp', requiredScope: 'agent-room:mcp',
    });
    expect(dispatch.mock.calls[0]?.[0].headers.authorization).toBeUndefined();
  });

  it('refuses an invalid token before MCP dispatch with protected-resource metadata', async () => {
    const dispatch = vi.fn();
    const handler = createAuthorizedMcpHttpHandler({
      resource: 'https://room.invalid/mcp',
      metadataUrl: 'https://room.invalid/.well-known/oauth-protected-resource',
      verifier: { verify: async () => { throw new Error('bad token'); } }, dispatch,
    });

    expect(await handler({ headers: { authorization: 'Bearer bad' } })).toEqual({
      status: 401,
      headers: { 'www-authenticate': 'Bearer resource_metadata="https://room.invalid/.well-known/oauth-protected-resource"' },
      body: { error: 'invalid_token' },
    });
    expect(dispatch).not.toHaveBeenCalled();
    expect(protectedResourceMetadata('https://room.invalid/mcp', ['https://issuer.invalid']))
      .toMatchObject({ resource: 'https://room.invalid/mcp', authorization_servers: ['https://issuer.invalid'] });
  });
});
