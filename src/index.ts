import { db, schema } from './db';
import { RailwayClient, deployToRailway, redeployToRailway, addCustomDomain } from './api/railway';
import {
  getGitHubAuthUrl,
  exchangeCodeForToken,
  findOrCreateUser,
  generateState,
  isUserAuthorized,
  getGitHubReleases,
  getGitHubRepos,
  getGitHubUserByUsername,
} from './auth/github';
import { runMigrations } from './db/migrate';
import { eq } from 'drizzle-orm';

const PORT = parseInt(process.env.PORT || '3000');

interface Session {
  userId: string;
  githubToken: string;
  createdAt: Date;
}

const sessions = new Map<string, Session>();

function generateSessionId(): string {
  return Math.random().toString(36).substring(2, 15) + Math.random().toString(36).substring(2, 15);
}

function createSession(userId: string, githubToken: string): string {
  const sessionId = generateSessionId();
  sessions.set(sessionId, { userId, githubToken, createdAt: new Date() });
  return sessionId;
}

function getSession(sessionId: string): Session | undefined {
  return sessions.get(sessionId);
}

function parseCookies(cookieHeader: string): Record<string, string> {
  const cookies: Record<string, string> = {};
  cookieHeader.split(';').forEach(cookie => {
    const [key, value] = cookie.split('=');
    if (key && value) {
      cookies[key.trim()] = value.trim();
    }
  });
  return cookies;
}

async function handleRequest(req: Request): Promise<Response> {
  const url = new URL(req.url);
  const path = url.pathname;
  const method = req.method;

  const cookieHeader = req.headers.get('cookie') || '';
  const cookies = parseCookies(cookieHeader);
  const sessionId = cookies['session'];
  const session = sessionId ? getSession(sessionId) : null;

  if (path === '/health') {
    return new Response(JSON.stringify({ status: 'ok' }), {
      headers: { 'Content-Type': 'application/json' },
    });
  }

  if (path === '/auth/login') {
    const state = generateState();
    const authUrl = getGitHubAuthUrl(state);
    return Response.redirect(authUrl);
  }

  if (path === '/auth/callback') {
    const code = url.searchParams.get('code');
    if (!code) {
      return new Response('Missing code parameter', { status: 400 });
    }

    try {
      const token = await exchangeCodeForToken(code);
      const user = await findOrCreateUser(token);
      const sessionId = createSession(user.id, token);

      return new Response('', {
        status: 302,
        headers: {
          'Location': '/',
          'Set-Cookie': `session=${sessionId}; Path=/; HttpOnly; SameSite=Lax; Max-Age=604800`,
        },
      });
    } catch (error) {
      return new Response(`Auth error: ${error}`, { status: 500 });
    }
  }

  if (path === '/auth/logout' && method === 'POST') {
    if (sessionId) {
      sessions.delete(sessionId);
    }
    return new Response('', {
      status: 302,
      headers: {
        'Location': '/',
        'Set-Cookie': 'session=; Path=/; Max-Age=0',
      },
    });
  }

  if (path === '/api/user' && method === 'GET') {
    if (!session) {
      return new Response(JSON.stringify({ error: 'Unauthorized' }), {
        status: 401,
        headers: { 'Content-Type': 'application/json' }
      });
    }

    const user = await db.select().from(schema.users).where(eq(schema.users.id, session.userId)).then(r => r[0]);
    if (!user) {
      return new Response(JSON.stringify({ error: 'User not found' }), {
        status: 404,
        headers: { 'Content-Type': 'application/json' }
      });
    }

    return new Response(JSON.stringify(user), {
      headers: { 'Content-Type': 'application/json' },
    });
  }

  if (path === '/api/deployments' && method === 'GET') {
    if (!session) {
      return new Response(JSON.stringify({ error: 'Unauthorized' }), {
        status: 401,
        headers: { 'Content-Type': 'application/json' }
      });
    }

    const user = await db.select().from(schema.users).where(eq(schema.users.id, session.userId)).then(r => r[0]);
    if (!user || !isUserAuthorized(user)) {
      return new Response(JSON.stringify({ error: 'Forbidden' }), {
        status: 403,
        headers: { 'Content-Type': 'application/json' }
      });
    }

    const deployments = await db.select().from(schema.deployments).orderBy(schema.deployments.createdAt);
    return new Response(JSON.stringify(deployments), {
      headers: { 'Content-Type': 'application/json' },
    });
  }

  if (path === '/api/deployments' && method === 'POST') {
    if (!session) {
      return new Response(JSON.stringify({ error: 'Unauthorized' }), {
        status: 401,
        headers: { 'Content-Type': 'application/json' }
      });
    }

    const user = await db.select().from(schema.users).where(eq(schema.users.id, session.userId)).then(r => r[0]);
    if (!user || !isUserAuthorized(user)) {
      return new Response(JSON.stringify({ error: 'Forbidden' }), {
        status: 403,
        headers: { 'Content-Type': 'application/json' }
      });
    }

    const body = await req.json();
    const { name, projectId, serviceId, environmentId, releaseTag, repo } = body;

    if (!name || !projectId || !serviceId || !repo || !releaseTag) {
      return new Response(JSON.stringify({ error: 'Missing required fields: name, projectId, serviceId, repo, and releaseTag are all required' }), {
        status: 400,
        headers: { 'Content-Type': 'application/json' }
      });
    }

    const token = await db
      .select()
      .from(schema.railwayTokens)
      .where(eq(schema.railwayTokens.userId, user.id))
      .then(r => r[0]?.token);

    if (!token) {
      return new Response(JSON.stringify({ error: 'No Railway token configured' }), {
        status: 400,
        headers: { 'Content-Type': 'application/json' }
      });
    }

    // Validate that releaseTag is an actual GitHub release
    try {
      const releases = await getGitHubReleases(session.githubToken, repo);
      const isValidRelease = releases.some(r => r.tag_name === releaseTag);
      if (!isValidRelease) {
        return new Response(JSON.stringify({ error: `"${releaseTag}" is not a valid release tag for ${repo}` }), {
          status: 400,
          headers: { 'Content-Type': 'application/json' },
        });
      }
    } catch (error) {
      return new Response(JSON.stringify({ error: `Could not verify release tag: ${error}` }), {
        status: 502,
        headers: { 'Content-Type': 'application/json' },
      });
    }

    const [deployment] = await db
      .insert(schema.deployments)
      .values({
        userId: user.id,
        name,
        projectId,
        serviceId,
        environmentId: environmentId || 'production',
        releaseTag,
        repo,
        railwayToken: token,
        status: 'deploying',
      })
      .returning();

    try {
      const deploymentId = await deployToRailway(token, {
        name,
        projectId,
        serviceId,
        environmentId,
        releaseTag,
        repo,
      });

      await db
        .update(schema.deployments)
        .set({
          status: 'deployed',
          deploymentId,
          lastDeployedAt: new Date(),
          updatedAt: new Date(),
        })
        .where(eq(schema.deployments.id, deployment.id));

      return new Response(JSON.stringify({ ...deployment, deploymentId }), {
        headers: { 'Content-Type': 'application/json' },
      });
    } catch (error) {
      await db
        .update(schema.deployments)
        .set({ status: 'failed', updatedAt: new Date() })
        .where(eq(schema.deployments.id, deployment.id));

      return new Response(JSON.stringify({ error: `Deployment failed: ${error}` }), {
        status: 500,
        headers: { 'Content-Type': 'application/json' }
      });
    }
  }

  if (path.startsWith('/api/deployments/') && path.endsWith('/redeploy') && method === 'POST') {
    if (!session) {
      return new Response(JSON.stringify({ error: 'Unauthorized' }), {
        status: 401,
        headers: { 'Content-Type': 'application/json' }
      });
    }

    const user = await db.select().from(schema.users).where(eq(schema.users.id, session.userId)).then(r => r[0]);
    if (!user || !isUserAuthorized(user)) {
      return new Response(JSON.stringify({ error: 'Forbidden' }), {
        status: 403,
        headers: { 'Content-Type': 'application/json' }
      });
    }

    const deploymentId = path.split('/')[3];
    const deployment = await db.select().from(schema.deployments).where(eq(schema.deployments.id, deploymentId)).then(r => r[0]);

    if (!deployment) {
      return new Response(JSON.stringify({ error: 'Deployment not found' }), {
        status: 404,
        headers: { 'Content-Type': 'application/json' }
      });
    }

    try {
      const newDeploymentId = await redeployToRailway(
        deployment.railwayToken!,
        deployment.serviceId,
        deployment.environmentId || undefined
      );

      await db
        .update(schema.deployments)
        .set({
          status: 'deployed',
          deploymentId: newDeploymentId,
          lastDeployedAt: new Date(),
          updatedAt: new Date(),
        })
        .where(eq(schema.deployments.id, deploymentId));

      return new Response(JSON.stringify({ success: true, deploymentId: newDeploymentId }), {
        headers: { 'Content-Type': 'application/json' },
      });
    } catch (error) {
      return new Response(JSON.stringify({ error: `Redeploy failed: ${error}` }), {
        status: 500,
        headers: { 'Content-Type': 'application/json' }
      });
    }
  }

  if (path === '/api/deployments' && method === 'DELETE') {
    if (!session) {
      return new Response(JSON.stringify({ error: 'Unauthorized' }), {
        status: 401,
        headers: { 'Content-Type': 'application/json' }
      });
    }

    const user = await db.select().from(schema.users).where(eq(schema.users.id, session.userId)).then(r => r[0]);
    if (!user || !isUserAuthorized(user)) {
      return new Response(JSON.stringify({ error: 'Forbidden' }), {
        status: 403,
        headers: { 'Content-Type': 'application/json' }
      });
    }

    const body = await req.json();
    const { id } = body;

    if (!id) {
      return new Response(JSON.stringify({ error: 'Missing deployment ID' }), {
        status: 400,
        headers: { 'Content-Type': 'application/json' }
      });
    }

    await db.delete(schema.deployments).where(eq(schema.deployments.id, id));

    return new Response(JSON.stringify({ success: true }), {
      headers: { 'Content-Type': 'application/json' },
    });
  }

  if (path === '/api/authorize' && method === 'POST') {
    if (!session) {
      return new Response(JSON.stringify({ error: 'Unauthorized' }), {
        status: 401,
        headers: { 'Content-Type': 'application/json' }
      });
    }

    const currentUser = await db.select().from(schema.users).where(eq(schema.users.id, session.userId)).then(r => r[0]);
    if (!currentUser || !currentUser.isOwner) {
      return new Response(JSON.stringify({ error: 'Only owner can authorize users' }), {
        status: 403,
        headers: { 'Content-Type': 'application/json' }
      });
    }

    const body = await req.json();
    const { userId, authorized } = body;

    await db
      .update(schema.users)
      .set({ isAuthorized: authorized, updatedAt: new Date() })
      .where(eq(schema.users.id, userId));

    return new Response(JSON.stringify({ success: true }), {
      headers: { 'Content-Type': 'application/json' },
    });
  }

  if (path === '/api/tokens' && method === 'POST') {
    if (!session) {
      return new Response(JSON.stringify({ error: 'Unauthorized' }), {
        status: 401,
        headers: { 'Content-Type': 'application/json' }
      });
    }

    const body = await req.json();
    const { token, projectId, isDefault } = body;

    if (!token) {
      return new Response(JSON.stringify({ error: 'Missing token' }), {
        status: 400,
        headers: { 'Content-Type': 'application/json' }
      });
    }

    if (isDefault) {
      await db
        .update(schema.railwayTokens)
        .set({ isDefault: false })
        .where(eq(schema.railwayTokens.userId, session.userId));
    }

    await db
      .insert(schema.railwayTokens)
      .values({
        userId: session.userId,
        token,
        projectId,
        isDefault: isDefault || false,
      });

    return new Response(JSON.stringify({ success: true }), {
      headers: { 'Content-Type': 'application/json' },
    });
  }

  if (path === '/api/tokens' && method === 'GET') {
    if (!session) {
      return new Response(JSON.stringify({ error: 'Unauthorized' }), {
        status: 401,
        headers: { 'Content-Type': 'application/json' }
      });
    }

    const tokens = await db
      .select()
      .from(schema.railwayTokens)
      .where(eq(schema.railwayTokens.userId, session.userId));

    const maskedTokens = tokens.map(t => ({
      id: t.id,
      projectId: t.projectId,
      isDefault: t.isDefault,
      createdAt: t.createdAt,
      token: t.token.substring(0, 8) + '****',
    }));

    return new Response(JSON.stringify(maskedTokens), {
      headers: { 'Content-Type': 'application/json' },
    });
  }

  if (path === '/api/releases' && method === 'GET') {
    if (!session) {
      return new Response(JSON.stringify({ error: 'Unauthorized' }), {
        status: 401,
        headers: { 'Content-Type': 'application/json' },
      });
    }

    const repo = url.searchParams.get('repo');
    if (!repo || !repo.includes('/')) {
      return new Response(JSON.stringify({ error: 'Missing or invalid repo parameter (expected owner/repo)' }), {
        status: 400,
        headers: { 'Content-Type': 'application/json' },
      });
    }

    try {
      const releases = await getGitHubReleases(session.githubToken, repo);
      return new Response(JSON.stringify(releases), {
        headers: { 'Content-Type': 'application/json' },
      });
    } catch (error) {
      return new Response(JSON.stringify({ error: `Failed to fetch releases: ${error}` }), {
        status: 502,
        headers: { 'Content-Type': 'application/json' },
      });
    }
  }

  // GET /api/repos - List user's GitHub repositories
  if (path === '/api/repos' && method === 'GET') {
    if (!session) {
      return new Response(JSON.stringify({ error: 'Unauthorized' }), {
        status: 401,
        headers: { 'Content-Type': 'application/json' },
      });
    }

    try {
      const repos = await getGitHubRepos(session.githubToken);
      return new Response(JSON.stringify(repos), {
        headers: { 'Content-Type': 'application/json' },
      });
    } catch (error) {
      return new Response(JSON.stringify({ error: `Failed to fetch repositories: ${error}` }), {
        status: 502,
        headers: { 'Content-Type': 'application/json' },
      });
    }
  }

  // POST /api/collaborators/invite - Invite a collaborator by GitHub username
  if (path === '/api/collaborators/invite' && method === 'POST') {
    if (!session) {
      return new Response(JSON.stringify({ error: 'Unauthorized' }), {
        status: 401,
        headers: { 'Content-Type': 'application/json' },
      });
    }

    const currentUser = await db.select().from(schema.users).where(eq(schema.users.id, session.userId)).then(r => r[0]);
    if (!currentUser || !currentUser.isOwner) {
      return new Response(JSON.stringify({ error: 'Only owner can invite collaborators' }), {
        status: 403,
        headers: { 'Content-Type': 'application/json' },
      });
    }

    const body = await req.json();
    const { username } = body;

    if (!username) {
      return new Response(JSON.stringify({ error: 'Missing username' }), {
        status: 400,
        headers: { 'Content-Type': 'application/json' },
      });
    }

    try {
      const githubUser = await getGitHubUserByUsername(session.githubToken, username);
      if (!githubUser) {
        return new Response(JSON.stringify({ error: 'GitHub user not found' }), {
          status: 404,
          headers: { 'Content-Type': 'application/json' },
        });
      }

      // Check if user already exists
      const existingUser = await db
        .select()
        .from(schema.users)
        .where(eq(schema.users.githubId, String(githubUser.id)))
        .then(r => r[0]);

      if (existingUser) {
        if (existingUser.isAuthorized) {
          return new Response(JSON.stringify({ error: 'User is already a collaborator' }), {
            status: 400,
            headers: { 'Content-Type': 'application/json' },
          });
        }
        // Authorize existing user
        await db
          .update(schema.users)
          .set({ isAuthorized: true, updatedAt: new Date() })
          .where(eq(schema.users.id, existingUser.id));
        return new Response(JSON.stringify({ success: true, user: existingUser }), {
          headers: { 'Content-Type': 'application/json' },
        });
      }

      // Create new user as collaborator
      const [newUser] = await db
        .insert(schema.users)
        .values({
          githubId: String(githubUser.id),
          username: githubUser.login,
          avatarUrl: githubUser.avatar_url,
          isOwner: false,
          isAuthorized: true,
        })
        .returning();

      return new Response(JSON.stringify({ success: true, user: newUser }), {
        headers: { 'Content-Type': 'application/json' },
      });
    } catch (error) {
      return new Response(JSON.stringify({ error: `Failed to invite collaborator: ${error}` }), {
        status: 500,
        headers: { 'Content-Type': 'application/json' },
      });
    }
  }

  // GET /api/collaborators - List all collaborators
  if (path === '/api/collaborators' && method === 'GET') {
    if (!session) {
      return new Response(JSON.stringify({ error: 'Unauthorized' }), {
        status: 401,
        headers: { 'Content-Type': 'application/json' },
      });
    }

    const currentUser = await db.select().from(schema.users).where(eq(schema.users.id, session.userId)).then(r => r[0]);
    if (!currentUser || (!currentUser.isOwner && !currentUser.isAuthorized)) {
      return new Response(JSON.stringify({ error: 'Forbidden' }), {
        status: 403,
        headers: { 'Content-Type': 'application/json' },
      });
    }

    const users = await db.select().from(schema.users);
    return new Response(JSON.stringify(users), {
      headers: { 'Content-Type': 'application/json' },
    });
  }

  // DELETE /api/collaborators/:id - Remove a collaborator
  if (path.startsWith('/api/collaborators/') && method === 'DELETE') {
    if (!session) {
      return new Response(JSON.stringify({ error: 'Unauthorized' }), {
        status: 401,
        headers: { 'Content-Type': 'application/json' },
      });
    }

    const currentUser = await db.select().from(schema.users).where(eq(schema.users.id, session.userId)).then(r => r[0]);
    if (!currentUser || !currentUser.isOwner) {
      return new Response(JSON.stringify({ error: 'Only owner can remove collaborators' }), {
        status: 403,
        headers: { 'Content-Type': 'application/json' },
      });
    }

    const collaboratorId = path.split('/')[3];

    const collaborator = await db.select().from(schema.users).where(eq(schema.users.id, collaboratorId)).then(r => r[0]);
    if (!collaborator) {
      return new Response(JSON.stringify({ error: 'Collaborator not found' }), {
        status: 404,
        headers: { 'Content-Type': 'application/json' },
      });
    }

    if (collaborator.isOwner) {
      return new Response(JSON.stringify({ error: 'Cannot remove the owner' }), {
        status: 400,
        headers: { 'Content-Type': 'application/json' },
      });
    }

    await db.delete(schema.users).where(eq(schema.users.id, collaboratorId));

    return new Response(JSON.stringify({ success: true }), {
      headers: { 'Content-Type': 'application/json' },
    });
  }

  // POST /api/deployments/:id/domain - Add custom domain to deployment
  if (path.match(/^\/api\/deployments\/[^/]+\/domain$/) && method === 'POST') {
    if (!session) {
      return new Response(JSON.stringify({ error: 'Unauthorized' }), {
        status: 401,
        headers: { 'Content-Type': 'application/json' },
      });
    }

    const currentUser = await db.select().from(schema.users).where(eq(schema.users.id, session.userId)).then(r => r[0]);
    if (!currentUser || !isUserAuthorized(currentUser)) {
      return new Response(JSON.stringify({ error: 'Forbidden' }), {
        status: 403,
        headers: { 'Content-Type': 'application/json' },
      });
    }

    const deploymentId = path.split('/')[3];
    const deployment = await db.select().from(schema.deployments).where(eq(schema.deployments.id, deploymentId)).then(r => r[0]);

    if (!deployment) {
      return new Response(JSON.stringify({ error: 'Deployment not found' }), {
        status: 404,
        headers: { 'Content-Type': 'application/json' },
      });
    }

    const body = await req.json();
    const { domain } = body;

    if (!domain) {
      return new Response(JSON.stringify({ error: 'Missing domain' }), {
        status: 400,
        headers: { 'Content-Type': 'application/json' },
      });
    }

    try {
      await addCustomDomain(deployment.railwayToken!, deployment.serviceId, domain);

      await db
        .update(schema.deployments)
        .set({ customDomain: domain, updatedAt: new Date() })
        .where(eq(schema.deployments.id, deploymentId));

      return new Response(JSON.stringify({ success: true, domain }), {
        headers: { 'Content-Type': 'application/json' },
      });
    } catch (error) {
      return new Response(JSON.stringify({ error: `Failed to add domain: ${error}` }), {
        status: 500,
        headers: { 'Content-Type': 'application/json' },
      });
    }
  }

  const html = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Railway Deployer</title>
  <link rel="preconnect" href="https://fonts.googleapis.com">
  <link href="https://fonts.googleapis.com/css2?family=JetBrains+Mono:wght@400;500;600&display=swap" rel="stylesheet">
  <style>
    * { box-sizing: border-box; margin: 0; padding: 0; }
    
    :root {
      --bg: #fafafa;
      --bg-card: #ffffff;
      --bg-hover: #f5f5f5;
      --border: #e0e0e0;
      --text: #0a0a0a;
      --text-muted: #666666;
      --accent: #0a0a0a;
      --success: #16a34a;
      --warning: #ca8a04;
      --danger: #dc2626;
    }

    body {
      font-family: 'JetBrains Mono', monospace;
      background: var(--bg);
      color: var(--text);
      min-height: 100vh;
      font-size: 14px;
      line-height: 1.5;
    }

    .container {
      max-width: 960px;
      margin: 0 auto;
      padding: 48px 24px;
    }

    header {
      display: flex;
      justify-content: space-between;
      align-items: center;
      padding-bottom: 32px;
      margin-bottom: 48px;
      border-bottom: 1px solid var(--border);
    }

    .logo {
      font-size: 18px;
      font-weight: 600;
      letter-spacing: -0.5px;
    }

    .logo span {
      color: var(--text-muted);
      font-weight: 400;
    }

    .user {
      display: flex;
      align-items: center;
      gap: 12px;
    }

    .user img {
      width: 28px;
      height: 28px;
      border-radius: 50%;
      border: 1px solid var(--border);
    }

    .user-name {
      font-size: 13px;
      color: var(--text-muted);
    }

    .nav {
      display: flex;
      gap: 4px;
      margin-bottom: 32px;
    }

    .nav button {
      padding: 8px 16px;
      background: transparent;
      border: 1px solid var(--border);
      font-family: inherit;
      font-size: 12px;
      cursor: pointer;
      transition: all 0.15s;
    }

    .nav button:first-child {
      border-radius: 4px 0 0 4px;
    }

    .nav button:last-child {
      border-radius: 0 4px 4px 0;
    }

    .nav button.active {
      background: var(--accent);
      color: white;
      border-color: var(--accent);
    }

    .card {
      background: var(--bg-card);
      border: 1px solid var(--border);
      padding: 24px;
      margin-bottom: 16px;
    }

    .card-header {
      font-size: 11px;
      text-transform: uppercase;
      letter-spacing: 0.5px;
      color: var(--text-muted);
      margin-bottom: 20px;
    }

    .form-grid {
      display: grid;
      grid-template-columns: 1fr 1fr;
      gap: 16px;
    }

    .form-group {
      display: flex;
      flex-direction: column;
      gap: 6px;
    }

    .form-group.full {
      grid-column: 1 / -1;
    }

    label {
      font-size: 11px;
      color: var(--text-muted);
    }

    label span {
      color: var(--danger);
    }

    input, select {
      padding: 10px 12px;
      border: 1px solid var(--border);
      font-family: inherit;
      font-size: 13px;
      background: var(--bg);
      outline: none;
      transition: border-color 0.15s;
    }

    input:focus, select:focus {
      border-color: var(--accent);
    }

    input::placeholder {
      color: #999;
    }

    select {
      cursor: pointer;
      appearance: none;
      background-image: url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='12' height='12' viewBox='0 0 24 24' fill='none' stroke='%23666' stroke-width='2'%3E%3Cpath d='M6 9l6 6 6-6'/%3E%3C/svg%3E");
      background-repeat: no-repeat;
      background-position: right 10px center;
      padding-right: 32px;
    }

    select:disabled {
      opacity: 0.4;
      cursor: not-allowed;
    }

    button {
      font-family: inherit;
      cursor: pointer;
      transition: all 0.15s;
    }

    .btn-primary {
      padding: 10px 20px;
      background: var(--accent);
      color: white;
      border: 1px solid var(--accent);
      font-size: 12px;
      font-weight: 500;
    }

    .btn-primary:hover {
      background: #333;
    }

    .btn-secondary {
      padding: 8px 14px;
      background: transparent;
      border: 1px solid var(--border);
      font-size: 11px;
    }

    .btn-secondary:hover {
      background: var(--bg-hover);
    }

    .btn-danger {
      padding: 8px 14px;
      background: transparent;
      border: 1px solid var(--danger);
      color: var(--danger);
      font-size: 11px;
    }

    .btn-danger:hover {
      background: var(--danger);
      color: white;
    }

    .deploy-list {
      display: flex;
      flex-direction: column;
    }

    .deploy-item {
      display: grid;
      grid-template-columns: 1fr auto auto auto;
      gap: 16px;
      align-items: center;
      padding: 16px 0;
      border-bottom: 1px solid var(--border);
    }

    .deploy-item:last-child {
      border-bottom: none;
    }

    .deploy-name {
      font-weight: 500;
      font-size: 13px;
    }

    .deploy-meta {
      font-size: 11px;
      color: var(--text-muted);
      margin-top: 2px;
    }

    .deploy-meta span {
      margin-right: 12px;
    }

    .status {
      font-size: 10px;
      padding: 4px 8px;
      border: 1px solid;
      text-transform: uppercase;
      letter-spacing: 0.3px;
    }

    .status.deployed { color: var(--success); border-color: var(--success); }
    .status.failed { color: var(--danger); border-color: var(--danger); }
    .status.deploying { color: var(--warning); border-color: var(--warning); }
    .status.pending { color: var(--text-muted); border-color: var(--border); }

    .actions {
      display: flex;
      gap: 6px;
    }

    .empty {
      text-align: center;
      padding: 48px 24px;
      color: var(--text-muted);
      font-size: 12px;
    }

    .empty-icon {
      font-size: 24px;
      margin-bottom: 8px;
      opacity: 0.3;
    }

    .repo-selector {
      position: relative;
    }

    .repo-dropdown {
      position: absolute;
      top: 100%;
      left: 0;
      right: 0;
      background: var(--bg-card);
      border: 1px solid var(--border);
      margin-top: 4px;
      max-height: 200px;
      overflow-y: auto;
      z-index: 100;
      display: none;
    }

    .repo-dropdown.active {
      display: block;
    }

    .repo-item {
      padding: 10px 12px;
      cursor: pointer;
      border-bottom: 1px solid var(--border);
      font-size: 12px;
    }

    .repo-item:last-child {
      border-bottom: none;
    }

    .repo-item:hover {
      background: var(--bg-hover);
    }

    .repo-item.private {
      border-left: 2px solid var(--warning);
    }

    .collab-list {
      display: flex;
      flex-direction: column;
      gap: 8px;
    }

    .collab-item {
      display: flex;
      justify-content: space-between;
      align-items: center;
      padding: 12px;
      background: var(--bg);
      border: 1px solid var(--border);
    }

    .collab-info {
      display: flex;
      align-items: center;
      gap: 10px;
    }

    .collab-info img {
      width: 24px;
      height: 24px;
      border-radius: 50%;
    }

    .collab-name {
      font-size: 12px;
      font-weight: 500;
    }

    .collab-role {
      font-size: 10px;
      color: var(--text-muted);
    }

    .collab-role.owner {
      color: var(--accent);
    }

    .invite-row {
      display: flex;
      gap: 8px;
      margin-top: 16px;
    }

    .invite-row input {
      flex: 1;
    }

    .toast {
      position: fixed;
      bottom: 24px;
      right: 24px;
      padding: 12px 16px;
      background: var(--accent);
      color: white;
      font-size: 12px;
      z-index: 1000;
    }

    .toast.error {
      background: var(--danger);
    }

    .hidden {
      display: none !important;
    }

    .section-title {
      font-size: 11px;
      text-transform: uppercase;
      letter-spacing: 0.5px;
      color: var(--text-muted);
      margin-bottom: 16px;
      padding-bottom: 8px;
      border-bottom: 1px solid var(--border);
    }

    .token-list {
      margin-top: 16px;
    }

    .token-item {
      display: flex;
      justify-content: space-between;
      align-items: center;
      padding: 10px 12px;
      background: var(--bg);
      border: 1px solid var(--border);
      margin-bottom: 6px;
      font-size: 12px;
    }

    .token-mask {
      font-family: monospace;
      color: var(--text-muted);
    }
  </style>
</head>
<body>
  <div class="container">
    <header>
      <div class="logo">railway<span>/deployer</span></div>
      <div class="user">
        <img src="" id="userAvatar" alt="">
        <span class="user-name" id="userName">—</span>
        <form action="/auth/logout" method="POST" style="display:inline;">
          <button type="submit" class="btn-secondary">logout</button>
        </form>
      </div>
    </header>

    <div class="nav">
      <button class="active" data-tab="deploy">deployments</button>
      <button id="collabTab" style="display:none;">team</button>
      <button data-tab="settings">settings</button>
    </div>

    <div id="deploySection">
      <div class="card">
        <div class="card-header">new deployment</div>
        <form id="deployForm" class="form-grid">
          <div class="form-group">
            <label>name <span>*</span></label>
            <input type="text" name="name" required placeholder="app-name">
          </div>
          <div class="form-group">
            <label>project id <span>*</span></label>
            <input type="text" name="projectId" required placeholder="proj_xxx">
          </div>
          <div class="form-group">
            <label>service id <span>*</span></label>
            <input type="text" name="serviceId" required placeholder="svc_xxx">
          </div>
          <div class="form-group">
            <label>environment</label>
            <input type="text" name="environmentId" placeholder="production">
          </div>
          <div class="form-group full">
            <label>repository <span>*</span></label>
            <div class="repo-selector">
              <input type="text" id="repoInput" name="repo" required placeholder="search repos..." autocomplete="off">
              <div class="repo-dropdown" id="repoDropdown"></div>
            </div>
          </div>
          <div class="form-group">
            <label>release <span>*</span></label>
            <select id="releaseSelect" name="releaseTag" required disabled>
              <option value="">— select repo —</option>
            </select>
          </div>
          <div class="form-group full" style="margin-top:8px;">
            <button type="submit" class="btn-primary">deploy</button>
          </div>
        </form>
      </div>

      <div class="card">
        <div class="card-header">active deployments</div>
        <div class="deploy-list" id="deployList">
          <div class="empty">
            <div class="empty-icon">[ ]</div>
            no deployments
          </div>
        </div>
      </div>
    </div>

    <div id="collabSection" class="hidden">
      <div class="card">
        <div class="card-header">team members</div>
        <div class="collab-list" id="collabList">
          <div class="empty">
            <div class="empty-icon">[ ]</div>
            no other members
          </div>
        </div>
        <div class="invite-row">
          <input type="text" id="inviteInput" placeholder="github username">
          <button class="btn-secondary" onclick="inviteUser()">invite</button>
        </div>
      </div>
    </div>

    <div id="settingsSection" class="hidden">
      <div class="card">
        <div class="card-header">railway token</div>
        <form id="tokenForm" class="form-grid">
          <div class="form-group full">
            <label>api token <span>*</span></label>
            <input type="password" name="token" required placeholder="rail_xxx">
          </div>
          <div class="form-group">
            <label>project id</label>
            <input type="text" name="projectId" placeholder="proj_xxx">
          </div>
          <div class="form-group full" style="margin-top:8px;">
            <button type="submit" class="btn-primary">save</button>
          </div>
        </form>
        <div class="token-list" id="tokenList"></div>
      </div>
    </div>
  </div>

  <div id="domainModal" class="hidden" style="position:fixed;inset:0;background:rgba(0,0,0,0.5);display:flex;align-items:center;justify-content:center;z-index:1000;">
    <div class="card" style="width:360px;margin:0;">
      <div class="card-header">add domain</div>
      <form id="domainForm">
        <input type="hidden" id="domainDeployId">
        <div class="form-group">
          <label>domain <span>*</span></label>
          <input type="text" id="domainInput" required placeholder="app.example.com">
        </div>
        <div style="display:flex;gap:8px;margin-top:12px;">
          <button type="submit" class="btn-primary">add</button>
          <button type="button" class="btn-secondary" onclick="closeDomainModal()">cancel</button>
        </div>
      </form>
    </div>
  </div>

  <script>
    let currentUser = null;
    let allRepos = [];

    async function loadUser() {
      const res = await fetch('/api/user');
      if (!res.ok) { window.location.href = '/auth/login'; return null; }
      currentUser = await res.json();
      document.getElementById('userAvatar').src = currentUser.avatarUrl || 'https://github.com/ghost.png';
      document.getElementById('userName').textContent = currentUser.username;
      if (currentUser.isOwner) {
        document.getElementById('collabTab').style.display = 'block';
      }
      return currentUser;
    }

    async function loadDeployments() {
      const res = await fetch('/api/deployments');
      const data = await res.json();
      const list = document.getElementById('deployList');
      
      if (!data.length) {
        list.innerHTML = '<div class="empty"><div class="empty-icon">[ ]</div>no deployments</div>';
        return;
      }

      list.innerHTML = data.map(d => \`
        <div class="deploy-item">
          <div>
            <div class="deploy-name">\${d.name}</div>
            <div class="deploy-meta">
              <span>\${d.repo || '—'}</span>
              <span>\${d.releaseTag || '—'}</span>
              \${d.customDomain ? '<span>' + d.customDomain + '</span>' : ''}
            </div>
          </div>
          <span class="status \${d.status}">\${d.status}</span>
          <div class="actions">
            <button class="btn-secondary" onclick="redeploy('\${d.id}')">redeploy</button>
            <button class="btn-secondary" onclick="openDomainModal('\${d.id}', '\${d.customDomain || ''}')">domain</button>
            <button class="btn-danger" onclick="deleteDeploy('\${d.id}')">del</button>
          </div>
        </div>
      \`).join('');
    }

    async function loadRepos() {
      const res = await fetch('/api/repos');
      if (!res.ok) return;
      allRepos = await res.json();
    }

    function setupRepoSelector() {
      const input = document.getElementById('repoInput');
      const dropdown = document.getElementById('repoDropdown');

      input.addEventListener('focus', () => {
        if (allRepos.length) { renderRepos(allRepos); dropdown.classList.add('active'); }
      });

      input.addEventListener('input', (e) => {
        const q = e.target.value.toLowerCase();
        if (q.length > 0) {
          renderRepos(allRepos.filter(r => r.full_name.toLowerCase().includes(q)));
        } else {
          renderRepos(allRepos);
        }
        dropdown.classList.add('active');
        if (q.includes('/')) fetchReleases(q);
      });

      document.addEventListener('click', (e) => {
        if (!e.target.closest('.repo-selector')) dropdown.classList.remove('active');
      });
    }

    function renderRepos(repos) {
      const dropdown = document.getElementById('repoDropdown');
      if (!repos.length) {
        dropdown.innerHTML = '<div class="repo-item">no repos</div>';
        return;
      }
      dropdown.innerHTML = repos.map(r => \`
        <div class="repo-item \${r.private ? 'private' : ''}" onclick="selectRepo('\${r.full_name}')">
          \${r.full_name} \${r.private ? '🔒' : ''}
        </div>
      \`).join('');
    }

    function selectRepo(name) {
      document.getElementById('repoInput').value = name;
      document.getElementById('repoDropdown').classList.remove('active');
      fetchReleases(name);
    }

    let releaseTimer = null;
    function fetchReleases(repo) {
      clearTimeout(releaseTimer);
      const sel = document.getElementById('releaseSelect');
      if (!repo || !repo.includes('/')) {
        sel.innerHTML = '<option value="">— select repo —</option>';
        sel.disabled = true;
        return;
      }
      releaseTimer = setTimeout(async () => {
        const res = await fetch('/api/releases?repo=' + encodeURIComponent(repo));
        if (!res.ok) { sel.innerHTML = '<option value="">— error —</option>'; sel.disabled = true; return; }
        const data = await res.json();
        if (!data.length) { sel.innerHTML = '<option value="">— no releases —</option>'; sel.disabled = true; return; }
        sel.innerHTML = data.map(r => \`<option value="\${r.tag_name}">\${r.name || r.tag_name}</option>\`).join('');
        sel.disabled = false;
      }, 400);
    }

    async function loadCollaborators() {
      if (!currentUser) currentUser = await loadUser();
      if (!currentUser?.isOwner) return;
      const res = await fetch('/api/collaborators');
      if (!res.ok) return;
      const users = await res.json();
      const list = document.getElementById('collabList');
      
      if (users.length <= 1) {
        list.innerHTML = '<div class="empty"><div class="empty-icon">[ ]</div>no other members</div>';
        return;
      }
      
      list.innerHTML = users.map(u => \`
        <div class="collab-item">
          <div class="collab-info">
            <img src="\${u.avatarUrl || 'https://github.com/ghost.png'}" alt="">
            <div>
              <div class="collab-name">\${u.username}</div>
              <div class="collab-role \${u.isOwner ? 'owner' : ''}">\${u.isOwner ? 'owner' : u.isAuthorized ? 'collaborator' : 'pending'}</div>
            </div>
          </div>
          \${!u.isOwner ? '<button class=\"btn-danger\" onclick=\"removeUser(\\'' + u.id + '\\')\">remove</button>' : ''}
        </div>
      \`).join('');
    }

    async function inviteUser() {
      const inp = document.getElementById('inviteInput');
      const u = inp.value.trim();
      if (!u) return;
      const res = await fetch('/api/collaborators/invite', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username: u })
      });
      const data = await res.json();
      if (res.ok) {
        showToast('invited');
        inp.value = '';
        loadCollaborators();
      } else {
        showToast(data.error || 'error', true);
      }
    }

    async function removeUser(id) {
      if (!confirm('remove?')) return;
      const res = await fetch('/api/collaborators/' + id, { method: 'DELETE' });
      if (res.ok) { showToast('removed'); loadCollaborators(); }
    }

    async function loadTokens() {
      const res = await fetch('/api/tokens');
      const tokens = await res.json();
      const list = document.getElementById('tokenList');
      if (!tokens.length) { list.innerHTML = ''; return; }
      list.innerHTML = '<div class="section-title">saved</div>' + tokens.map(t => \`
        <div class="token-item">
          <span class="token-mask">\${t.token}</span>
          <span style="color:var(--text-muted);font-size:10px;">\${t.projectId || '—'}\${t.isDefault ? ' • default' : ''}</span>
        </div>
      \`).join('');
    }

    function openDomainModal(id, existing) {
      document.getElementById('domainDeployId').value = id;
      document.getElementById('domainInput').value = existing;
      document.getElementById('domainModal').classList.remove('hidden');
    }

    function closeDomainModal() {
      document.getElementById('domainModal').classList.add('hidden');
    }

    async function submitDomain(e) {
      e.preventDefault();
      const id = document.getElementById('domainDeployId').value;
      const domain = document.getElementById('domainInput').value;
      const res = await fetch('/api/deployments/' + id + '/domain', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ domain })
      });
      if (res.ok) { showToast('domain added'); closeDomainModal(); loadDeployments(); }
      else { const d = await res.json(); showToast(d.error || 'error', true); }
    }

    function showToast(msg, err = false) {
      const t = document.createElement('div');
      t.className = 'toast' + (err ? ' error' : '');
      t.textContent = msg;
      document.body.appendChild(t);
      setTimeout(() => t.remove(), 2500);
    }

    // tabs
    document.querySelectorAll('.nav button').forEach(btn => {
      btn.addEventListener('click', () => {
        document.querySelectorAll('.nav button').forEach(b => b.classList.remove('active'));
        btn.classList.add('active');
        document.getElementById('deploySection')?.classList.add('hidden');
        document.getElementById('collabSection')?.classList.add('hidden');
        document.getElementById('settingsSection')?.classList.add('hidden');
        if (btn.dataset.tab === 'deploy') document.getElementById('deploySection').classList.remove('hidden');
        if (btn.dataset.tab === 'collab') { document.getElementById('collabSection').classList.remove('hidden'); loadCollaborators(); }
        if (btn.dataset.tab === 'settings') { document.getElementById('settingsSection').classList.remove('hidden'); loadTokens(); }
      });
    });

    // forms
    document.getElementById('deployForm').addEventListener('submit', async (e) => {
      e.preventDefault();
      const f = e.target;
      const d = {
        name: f.name.value,
        projectId: f.projectId.value,
        serviceId: f.serviceId.value,
        environmentId: f.environmentId.value,
        releaseTag: f.releaseTag.value,
        repo: f.repo.value
      };
      const res = await fetch('/api/deployments', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(d)
      });
      if (res.ok) { showToast('deploying'); f.reset(); loadDeployments(); }
      else { const err = await res.json(); showToast(err.error || 'error', true); }
    });

    document.getElementById('tokenForm').addEventListener('submit', async (e) => {
      e.preventDefault();
      const f = e.target;
      const res = await fetch('/api/tokens', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ token: f.token.value, projectId: f.projectId.value, isDefault: true })
      });
      if (res.ok) { showToast('saved'); f.reset(); loadTokens(); }
    });

    document.getElementById('domainForm').addEventListener('submit', submitDomain);

    async function redeploy(id) {
      const res = await fetch('/api/deployments/' + id + '/redeploy', { method: 'POST' });
      if (!res.ok) { const e = await res.json(); showToast(e.error || 'error', true); }
      loadDeployments();
    }

    async function deleteDeploy(id) {
      if (!confirm('delete?')) return;
      await fetch('/api/deployments', {
        method: 'DELETE',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id })
      });
      loadDeployments();
    }

    // init
    loadUser().then(() => {
      loadDeployments();
      loadRepos();
      loadTokens();
      setupRepoSelector();
    });
  </script>
</body>
</html>`;

  return new Response(html, {
    headers: { 'Content-Type': 'text/html' },
  });
}

await runMigrations();

const server = Bun.serve({
  port: PORT,
  fetch: handleRequest,
});

console.log(`Railway Deployer running at http://localhost:${PORT}`);
