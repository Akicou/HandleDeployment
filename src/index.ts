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
  <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
  <link href="https://fonts.googleapis.com/css2?family=Outfit:wght@300;400;500;600;700&family=DM+Sans:wght@400;500;600&display=swap" rel="stylesheet">
  <style>
    :root {
      --bg-primary: #0a0a0f;
      --bg-secondary: #12121a;
      --bg-card: #1a1a24;
      --bg-card-hover: #22222e;
      --border: #2a2a3a;
      --border-hover: #3a3a4f;
      --text-primary: #f0f0f5;
      --text-secondary: #8888a0;
      --text-muted: #555566;
      --accent: #7c3aed;
      --accent-hover: #8b5cf6;
      --accent-glow: rgba(124, 58, 237, 0.4);
      --success: #10b981;
      --success-glow: rgba(16, 185, 129, 0.3);
      --warning: #f59e0b;
      --danger: #ef4444;
      --info: #3b82f6;
    }

    * { box-sizing: border-box; margin: 0; padding: 0; }
    
    body {
      font-family: 'DM Sans', sans-serif;
      background: var(--bg-primary);
      color: var(--text-primary);
      min-height: 100vh;
      line-height: 1.6;
    }

    h1, h2, h3, h4 { font-family: 'Outfit', sans-serif; }

    ::-webkit-scrollbar { width: 8px; height: 8px; }
    ::-webkit-scrollbar-track { background: var(--bg-secondary); }
    ::-webkit-scrollbar-thumb { background: var(--border); border-radius: 4px; }
    ::-webkit-scrollbar-thumb:hover { background: var(--border-hover); }

    .app-container {
      max-width: 1200px;
      margin: 0 auto;
      padding: 2rem;
      animation: fadeIn 0.6s ease-out;
    }

    @keyframes fadeIn {
      from { opacity: 0; transform: translateY(10px); }
      to { opacity: 1; transform: translateY(0); }
    }

    @keyframes pulse-glow {
      0%, 100% { box-shadow: 0 0 20px var(--accent-glow); }
      50% { box-shadow: 0 0 40px var(--accent-glow); }
    }

    @keyframes slide-up {
      from { opacity: 0; transform: translateY(20px); }
      to { opacity: 1; transform: translateY(0); }
    }

    .header {
      display: flex;
      justify-content: space-between;
      align-items: center;
      margin-bottom: 3rem;
      padding-bottom: 1.5rem;
      border-bottom: 1px solid var(--border);
      animation: slide-up 0.5s ease-out;
    }

    .logo {
      display: flex;
      align-items: center;
      gap: 1rem;
    }

    .logo-icon {
      width: 48px;
      height: 48px;
      background: linear-gradient(135deg, var(--accent), #a855f7);
      border-radius: 14px;
      display: flex;
      align-items: center;
      justify-content: center;
      font-size: 24px;
      animation: pulse-glow 3s infinite;
    }

    .logo-text h1 {
      font-size: 1.75rem;
      font-weight: 700;
      background: linear-gradient(135deg, var(--text-primary), var(--accent-hover));
      -webkit-background-clip: text;
      -webkit-text-fill-color: transparent;
      background-clip: text;
    }

    .logo-text p {
      font-size: 0.85rem;
      color: var(--text-secondary);
    }

    .user-nav {
      display: flex;
      align-items: center;
      gap: 1rem;
    }

    .user-info {
      display: flex;
      align-items: center;
      gap: 0.75rem;
      padding: 0.5rem 1rem;
      background: var(--bg-card);
      border: 1px solid var(--border);
      border-radius: 50px;
    }

    .user-avatar {
      width: 32px;
      height: 32px;
      border-radius: 50%;
      border: 2px solid var(--accent);
    }

    .user-name {
      font-weight: 500;
      font-size: 0.9rem;
    }

    .logout-btn {
      background: transparent;
      border: 1px solid var(--border);
      color: var(--text-secondary);
      padding: 0.5rem 1rem;
      border-radius: 50px;
      cursor: pointer;
      font-size: 0.85rem;
      transition: all 0.3s ease;
      font-family: inherit;
    }

    .logout-btn:hover {
      border-color: var(--danger);
      color: var(--danger);
      background: rgba(239, 68, 68, 0.1);
    }

    .tabs {
      display: flex;
      gap: 0.5rem;
      margin-bottom: 2rem;
      animation: slide-up 0.5s ease-out 0.1s both;
    }

    .tab {
      padding: 0.75rem 1.5rem;
      background: var(--bg-card);
      border: 1px solid var(--border);
      border-radius: 12px;
      color: var(--text-secondary);
      cursor: pointer;
      font-size: 0.9rem;
      font-weight: 500;
      transition: all 0.3s ease;
      font-family: inherit;
    }

    .tab:hover {
      border-color: var(--border-hover);
      color: var(--text-primary);
    }

    .tab.active {
      background: var(--accent);
      border-color: var(--accent);
      color: white;
      box-shadow: 0 4px 20px var(--accent-glow);
    }

    .card {
      background: var(--bg-card);
      border: 1px solid var(--border);
      border-radius: 20px;
      padding: 2rem;
      margin-bottom: 1.5rem;
      transition: all 0.3s ease;
      animation: slide-up 0.5s ease-out 0.2s both;
    }

    .card:hover {
      border-color: var(--border-hover);
      transform: translateY(-2px);
    }

    .card-header {
      display: flex;
      justify-content: space-between;
      align-items: center;
      margin-bottom: 1.5rem;
    }

    .card-title {
      font-size: 1.25rem;
      font-weight: 600;
      display: flex;
      align-items: center;
      gap: 0.75rem;
    }

    .card-title-icon {
      width: 36px;
      height: 36px;
      background: linear-gradient(135deg, var(--accent), #a855f7);
      border-radius: 10px;
      display: flex;
      align-items: center;
      justify-content: center;
      font-size: 18px;
    }

    .form-grid {
      display: grid;
      grid-template-columns: repeat(auto-fit, minmax(280px, 1fr));
      gap: 1.25rem;
    }

    .form-group {
      display: flex;
      flex-direction: column;
      gap: 0.5rem;
    }

    .form-group.full-width {
      grid-column: 1 / -1;
    }

    label {
      font-size: 0.85rem;
      font-weight: 500;
      color: var(--text-secondary);
    }

    label span.required {
      color: var(--danger);
    }

    input, select {
      background: var(--bg-secondary);
      border: 1px solid var(--border);
      border-radius: 12px;
      padding: 0.875rem 1rem;
      color: var(--text-primary);
      font-size: 0.95rem;
      font-family: inherit;
      transition: all 0.3s ease;
      outline: none;
    }

    input:focus, select:focus {
      border-color: var(--accent);
      box-shadow: 0 0 0 3px var(--accent-glow);
    }

    input::placeholder {
      color: var(--text-muted);
    }

    select {
      cursor: pointer;
      appearance: none;
      background-image: url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='24' height='24' viewBox='0 0 24 24' fill='none' stroke='%238888a0' stroke-width='2' stroke-linecap='round' stroke-linejoin='round'%3E%3Cpolyline points='6 9 12 15 18 9'%3E%3C/polyline%3E%3C/svg%3E");
      background-repeat: no-repeat;
      background-position: right 0.75rem center;
      background-size: 18px;
      padding-right: 2.5rem;
    }

    select:disabled {
      opacity: 0.5;
      cursor: not-allowed;
    }

    .btn {
      padding: 0.875rem 1.75rem;
      border-radius: 12px;
      font-size: 0.95rem;
      font-weight: 600;
      cursor: pointer;
      transition: all 0.3s ease;
      border: none;
      font-family: inherit;
      display: inline-flex;
      align-items: center;
      gap: 0.5rem;
    }

    .btn-primary {
      background: linear-gradient(135deg, var(--accent), #a855f7);
      color: white;
      box-shadow: 0 4px 20px var(--accent-glow);
    }

    .btn-primary:hover {
      transform: translateY(-2px);
      box-shadow: 0 6px 30px var(--accent-glow);
    }

    .btn-secondary {
      background: var(--bg-secondary);
      border: 1px solid var(--border);
      color: var(--text-primary);
    }

    .btn-secondary:hover {
      border-color: var(--accent);
      color: var(--accent);
    }

    .btn-danger {
      background: rgba(239, 68, 68, 0.1);
      border: 1px solid var(--danger);
      color: var(--danger);
    }

    .btn-danger:hover {
      background: var(--danger);
      color: white;
    }

    .btn-success {
      background: linear-gradient(135deg, var(--success), #059669);
      color: white;
      box-shadow: 0 4px 20px var(--success-glow);
    }

    .btn-success:hover {
      transform: translateY(-2px);
      box-shadow: 0 6px 30px var(--success-glow);
    }

    .btn-sm {
      padding: 0.5rem 1rem;
      font-size: 0.85rem;
    }

    .status-badge {
      display: inline-flex;
      align-items: center;
      gap: 0.4rem;
      padding: 0.4rem 0.85rem;
      border-radius: 50px;
      font-size: 0.8rem;
      font-weight: 600;
      text-transform: capitalize;
    }

    .status-pending {
      background: rgba(245, 158, 11, 0.15);
      color: var(--warning);
      border: 1px solid rgba(245, 158, 11, 0.3);
    }

    .status-deploying {
      background: rgba(59, 130, 246, 0.15);
      color: var(--info);
      border: 1px solid rgba(59, 130, 246, 0.3);
    }

    .status-deployed {
      background: rgba(16, 185, 129, 0.15);
      color: var(--success);
      border: 1px solid rgba(16, 185, 129, 0.3);
    }

    .status-failed {
      background: rgba(239, 68, 68, 0.15);
      color: var(--danger);
      border: 1px solid rgba(239, 68, 68, 0.3);
    }

    .status-dot {
      width: 8px;
      height: 8px;
      border-radius: 50%;
      background: currentColor;
      animation: pulse 2s infinite;
    }

    @keyframes pulse {
      0%, 100% { opacity: 1; }
      50% { opacity: 0.5; }
    }

    .deployments-list {
      display: flex;
      flex-direction: column;
      gap: 1rem;
    }

    .deployment-item {
      display: grid;
      grid-template-columns: 1fr auto auto auto;
      align-items: center;
      gap: 1.5rem;
      padding: 1.25rem;
      background: var(--bg-secondary);
      border: 1px solid var(--border);
      border-radius: 16px;
      transition: all 0.3s ease;
    }

    .deployment-item:hover {
      border-color: var(--border-hover);
      background: var(--bg-card-hover);
    }

    .deployment-info h4 {
      font-size: 1.1rem;
      font-weight: 600;
      margin-bottom: 0.25rem;
    }

    .deployment-meta {
      display: flex;
      gap: 1rem;
      font-size: 0.85rem;
      color: var(--text-secondary);
    }

    .deployment-meta span {
      display: flex;
      align-items: center;
      gap: 0.35rem;
    }

    .deployment-actions {
      display: flex;
      gap: 0.5rem;
    }

    .empty-state {
      text-align: center;
      padding: 4rem 2rem;
      color: var(--text-muted);
    }

    .empty-state-icon {
      font-size: 4rem;
      margin-bottom: 1rem;
      opacity: 0.5;
    }

    .empty-state h3 {
      font-size: 1.25rem;
      margin-bottom: 0.5rem;
      color: var(--text-secondary);
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
      border-radius: 12px;
      margin-top: 0.5rem;
      max-height: 300px;
      overflow-y: auto;
      z-index: 100;
      display: none;
      box-shadow: 0 10px 40px rgba(0,0,0,0.5);
    }

    .repo-dropdown.active {
      display: block;
    }

    .repo-dropdown-item {
      padding: 0.875rem 1rem;
      cursor: pointer;
      border-bottom: 1px solid var(--border);
      transition: background 0.2s;
    }

    .repo-dropdown-item:last-child {
      border-bottom: none;
    }

    .repo-dropdown-item:hover {
      background: var(--bg-card-hover);
    }

    .repo-dropdown-item.private {
      border-left: 3px solid var(--warning);
    }

    .repo-dropdown-item .repo-name {
      font-weight: 600;
      margin-bottom: 0.25rem;
    }

    .repo-dropdown-item .repo-desc {
      font-size: 0.8rem;
      color: var(--text-muted);
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
    }

    .collaborators-list {
      display: flex;
      flex-direction: column;
      gap: 0.75rem;
    }

    .collaborator-item {
      display: flex;
      align-items: center;
      justify-content: space-between;
      padding: 1rem;
      background: var(--bg-secondary);
      border: 1px solid var(--border);
      border-radius: 12px;
    }

    .collaborator-info {
      display: flex;
      align-items: center;
      gap: 0.75rem;
    }

    .collaborator-avatar {
      width: 40px;
      height: 40px;
      border-radius: 50%;
    }

    .collaborator-name {
      font-weight: 600;
    }

    .collaborator-role {
      font-size: 0.8rem;
      color: var(--text-muted);
    }

    .collaborator-role.owner {
      color: var(--accent);
    }

    .invite-form {
      display: flex;
      gap: 0.75rem;
      margin-top: 1rem;
    }

    .invite-form input {
      flex: 1;
    }

    .domain-section {
      display: flex;
      align-items: center;
      gap: 1rem;
      padding: 1rem;
      background: var(--bg-secondary);
      border-radius: 12px;
      margin-top: 1rem;
    }

    .domain-section input {
      flex: 1;
    }

    .toast {
      position: fixed;
      bottom: 2rem;
      right: 2rem;
      padding: 1rem 1.5rem;
      background: var(--bg-card);
      border: 1px solid var(--border);
      border-radius: 12px;
      box-shadow: 0 10px 40px rgba(0,0,0,0.5);
      animation: slide-up 0.3s ease-out;
      z-index: 1000;
    }

    .toast.success {
      border-color: var(--success);
    }

    .toast.error {
      border-color: var(--danger);
    }

    .hidden { display: none !important; }
  </style>
</head>
<body>
  <div class="app-container">
    <header class="header">
      <div class="logo">
        <div class="logo-icon">🚀</div>
        <div class="logo-text">
          <h1>Railway Deployer</h1>
          <p>Deploy from GitHub releases with ease</p>
        </div>
      </div>
      <div class="user-nav">
        <div class="user-info" id="userInfo">
          <img src="" alt="" class="user-avatar" id="userAvatar">
          <span class="user-name" id="userName">Loading...</span>
        </div>
        <form action="/auth/logout" method="POST" style="display: inline;">
          <button type="submit" class="logout-btn">Logout</button>
        </form>
      </div>
    </header>

    <div class="tabs">
      <button class="tab active" data-tab="deploy">Deployments</button>
      <button class="tab" data-tab="collaborators" id="collaboratorsTab" style="display: none;">Collaborators</button>
      <button class="tab" data-tab="settings">Settings</button>
    </div>

    <div id="deployTab">
      <div class="card">
        <div class="card-header">
          <h2 class="card-title">
            <span class="card-title-icon">📦</span>
            New Deployment
          </h2>
        </div>
        <form id="deployForm" class="form-grid">
          <div class="form-group">
            <label>Name <span class="required">*</span></label>
            <input type="text" name="name" required placeholder="my-awesome-app">
          </div>
          <div class="form-group">
            <label>Project ID <span class="required">*</span></label>
            <input type="text" name="projectId" required placeholder="proj_xxxxxxxxxxxx">
          </div>
          <div class="form-group">
            <label>Service ID <span class="required">*</span></label>
            <input type="text" name="serviceId" required placeholder="svc_xxxxxxxxxxxx">
          </div>
          <div class="form-group">
            <label>Environment</label>
            <input type="text" name="environmentId" placeholder="production">
          </div>
          <div class="form-group full-width">
            <label>Repository <span class="required">*</span></label>
            <div class="repo-selector">
              <input type="text" id="repoInput" name="repo" required placeholder="Search repositories..." autocomplete="off">
              <div class="repo-dropdown" id="repoDropdown"></div>
            </div>
          </div>
          <div class="form-group">
            <label>Release <span class="required">*</span></label>
            <select id="releaseSelect" name="releaseTag" required disabled>
              <option value="">— select a repo first —</option>
            </select>
            <span id="releaseStatus" style="font-size: 0.8rem; color: var(--text-muted); margin-top: 0.25rem;"></span>
          </div>
          <div class="form-group full-width" style="margin-top: 0.5rem;">
            <button type="submit" class="btn btn-primary">
              <span>🚀</span> Deploy Application
            </button>
          </div>
        </form>
      </div>

      <div class="card">
        <div class="card-header">
          <h2 class="card-title">
            <span class="card-title-icon">📊</span>
            Active Deployments
          </h2>
        </div>
        <div class="deployments-list" id="deploymentsList">
          <div class="empty-state">
            <div class="empty-state-icon">📭</div>
            <h3>No deployments yet</h3>
            <p>Create your first deployment using the form above</p>
          </div>
        </div>
      </div>
    </div>

    <div id="collaboratorsTab" class="hidden">
      <div class="card">
        <div class="card-header">
          <h2 class="card-title">
            <span class="card-title-icon">👥</span>
            Team Members
          </h2>
        </div>
        <div class="collaborators-list" id="collaboratorsList">
          <div class="empty-state">
            <div class="empty-state-icon">👤</div>
            <h3>No other members</h3>
            <p>Invite team members by their GitHub username</p>
          </div>
        </div>
        <div class="invite-form">
          <input type="text" id="inviteUsername" placeholder="GitHub username">
          <button type="button" class="btn btn-secondary" onclick="inviteCollaborator()">Invite</button>
        </div>
      </div>
    </div>

    <div id="settingsTab" class="hidden">
      <div class="card">
        <div class="card-header">
          <h2 class="card-title">
            <span class="card-title-icon">⚙️</span>
            Railway Token
          </h2>
        </div>
        <form id="tokenForm" class="form-grid">
          <div class="form-group full-width">
            <label>API Token <span class="required">*</span></label>
            <input type="password" name="token" required placeholder="rail_xxxxxxxxxxxx">
          </div>
          <div class="form-group">
            <label>Project ID</label>
            <input type="text" name="projectId" placeholder="proj_xxxxxxxxxxxx">
          </div>
          <div class="form-group full-width" style="margin-top: 0.5rem;">
            <button type="submit" class="btn btn-primary">Save Token</button>
          </div>
        </form>
        <div id="tokensList" style="margin-top: 1.5rem;"></div>
      </div>

      <div class="card">
        <div class="card-header">
          <h2 class="card-title">
            <span class="card-title-icon">🌐</span>
            Custom Domains
          </h2>
        </div>
        <p style="color: var(--text-secondary); margin-bottom: 1rem;">Add custom domains to your deployments from the deployments list.</p>
      </div>
    </div>
  </div>

  <div id="domainModal" class="hidden" style="position: fixed; inset: 0; background: rgba(0,0,0,0.8); display: flex; align-items: center; justify-content: center; z-index: 1000;">
    <div class="card" style="width: 100%; max-width: 480px; margin: 0;">
      <div class="card-header">
        <h2 class="card-title">Add Custom Domain</h2>
        <button type="button" onclick="closeDomainModal()" style="background: none; border: none; color: var(--text-secondary); font-size: 1.5rem; cursor: pointer;">&times;</button>
      </div>
      <form id="domainForm">
        <input type="hidden" id="domainDeploymentId">
        <div class="form-group">
          <label>Domain <span class="required">*</span></label>
          <input type="text" id="domainInput" required placeholder="app.yoursite.com">
        </div>
        <div style="display: flex; gap: 0.75rem; margin-top: 1rem;">
          <button type="submit" class="btn btn-primary">Add Domain</button>
          <button type="button" class="btn btn-secondary" onclick="closeDomainModal()">Cancel</button>
        </div>
      </form>
    </div>
  </div>

  <script>
    let currentUser = null;
    let allRepos = [];
    let deployments = [];

    async function loadUser() {
      const res = await fetch('/api/user');
      if (!res.ok) {
        window.location.href = '/auth/login';
        return null;
      }
      currentUser = await res.json();
      
      document.getElementById('userAvatar').src = currentUser.avatarUrl || 'https://github.com/ghost.png';
      document.getElementById('userAvatar').alt = currentUser.username;
      document.getElementById('userName').textContent = currentUser.username;
      
      if (currentUser.isOwner) {
        document.getElementById('collaboratorsTab').style.display = 'block';
      }
      
      return currentUser;
    }

    async function loadDeployments() {
      const res = await fetch('/api/deployments');
      deployments = await res.json();
      renderDeployments();
    }

    function renderDeployments() {
      const list = document.getElementById('deploymentsList');
      
      if (!deployments.length) {
        list.innerHTML = \`
          <div class="empty-state">
            <div class="empty-state-icon">📭</div>
            <h3>No deployments yet</h3>
            <p>Create your first deployment using the form above</p>
          </div>
        \`;
        return;
      }

      list.innerHTML = deployments.map(d => \`
        <div class="deployment-item">
          <div class="deployment-info">
            <h4>\${d.name}</h4>
            <div class="deployment-meta">
              <span>📦 \${d.repo || '—'}</span>
              <span>🏷️ \${d.releaseTag || '—'}</span>
              <span>🕐 \${d.lastDeployedAt ? new Date(d.lastDeployedAt).toLocaleDateString() : 'Never'}</span>
            </div>
            \${d.customDomain ? \`<div class="deployment-meta" style="margin-top: 0.25rem;"><span>🌐 \${d.customDomain}</span></div>\` : ''}
          </div>
          <span class="status-badge status-\${d.status}">
            <span class="status-dot"></span>
            \${d.status}
          </span>
          <div class="deployment-actions">
            <button class="btn btn-success btn-sm" onclick="redeploy('\${d.id}')">Redeploy</button>
            <button class="btn btn-secondary btn-sm" onclick="openDomainModal('\${d.id}', '\${d.customDomain || ''}')">🌐 Domain</button>
            <button class="btn btn-danger btn-sm" onclick="deleteDeployment('\${d.id}')">Delete</button>
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
      const releaseSelect = document.getElementById('releaseSelect');
      const releaseStatus = document.getElementById('releaseStatus');

      input.addEventListener('focus', () => {
        if (allRepos.length) {
          renderRepoDropdown(allRepos);
          dropdown.classList.add('active');
        }
      });

      input.addEventListener('input', (e) => {
        const query = e.target.value.toLowerCase();
        if (query.length > 0) {
          const filtered = allRepos.filter(r => 
            r.full_name.toLowerCase().includes(query) ||
            (r.description && r.description.toLowerCase().includes(query))
          );
          renderRepoDropdown(filtered);
        } else {
          renderRepoDropdown(allRepos);
        }
        dropdown.classList.add('active');
        
        if (query.includes('/')) {
          debouncedFetchReleases(query);
        } else {
          releaseSelect.innerHTML = '<option value="">— select a repo first —</option>';
          releaseSelect.disabled = true;
          releaseStatus.textContent = '';
        }
      });

      document.addEventListener('click', (e) => {
        if (!e.target.closest('.repo-selector')) {
          dropdown.classList.remove('active');
        }
      });
    }

    function renderRepoDropdown(repos) {
      const dropdown = document.getElementById('repoDropdown');
      if (!repos.length) {
        dropdown.innerHTML = '<div style="padding: 1rem; text-align: center; color: var(--text-muted);">No repositories found</div>';
        return;
      }
      dropdown.innerHTML = repos.map(r => \`
        <div class="repo-dropdown-item \${r.private ? 'private' : ''}" onclick="selectRepo('\${r.full_name}')">
          <div class="repo-name">\${r.full_name} \${r.private ? '🔒' : ''}</div>
          \${r.description ? \`<div class="repo-desc">\${r.description}</div>\` : ''}
        </div>
      \`).join('');
    }

    function selectRepo(fullName) {
      document.getElementById('repoInput').value = fullName;
      document.getElementById('repoDropdown').classList.remove('active');
      debouncedFetchReleases(fullName);
    }

    let releaseDebounceTimer = null;
    function debouncedFetchReleases(repo) {
      clearTimeout(releaseDebounceTimer);
      const select = document.getElementById('releaseSelect');
      const status = document.getElementById('releaseStatus');
      
      if (!repo || !repo.includes('/')) {
        select.innerHTML = '<option value="">— select a valid repo —</option>';
        select.disabled = true;
        status.textContent = '';
        return;
      }

      status.textContent = 'Fetching releases...';
      releaseDebounceTimer = setTimeout(async () => {
        try {
          const res = await fetch('/api/releases?repo=' + encodeURIComponent(repo));
          if (!res.ok) {
            const err = await res.json();
            status.textContent = err.error || 'Failed to load';
            select.innerHTML = '<option value="">— error —</option>';
            select.disabled = true;
            return;
          }
          const releases = await res.json();
          if (!releases.length) {
            status.textContent = 'No releases found';
            select.innerHTML = '<option value="">— no releases —</option>';
            select.disabled = true;
            return;
          }
          select.innerHTML = releases.map(r => 
            \`<option value="\${r.tag_name}">\${r.name || r.tag_name} (\${r.tag_name})</option>\`
          ).join('');
          select.disabled = false;
          status.textContent = \`\${releases.length} release\${releases.length === 1 ? '' : 's'} available\`;
        } catch (e) {
          status.textContent = 'Network error';
          select.disabled = true;
        }
      }, 500);
    }

    async function loadCollaborators() {
      if (!currentUser?.isOwner) return;
      
      const res = await fetch('/api/collaborators');
      const users = await res.json();
      
      const list = document.getElementById('collaboratorsList');
      if (users.length <= 1) {
        list.innerHTML = \`
          <div class="empty-state">
            <div class="empty-state-icon">👤</div>
            <h3>No other members</h3>
            <p>Invite team members by their GitHub username</p>
          </div>
        \`;
        return;
      }

      list.innerHTML = users.map(u => \`
        <div class="collaborator-item">
          <div class="collaborator-info">
            <img src="\${u.avatarUrl || 'https://github.com/ghost.png'}" alt="\${u.username}" class="collaborator-avatar">
            <div>
              <div class="collaborator-name">\${u.username}</div>
              <div class="collaborator-role \${u.isOwner ? 'owner' : ''}">\${u.isOwner ? 'Owner' : u.isAuthorized ? 'Collaborator' : 'Pending'}</div>
            </div>
          </div>
          \${!u.isOwner ? \`<button class="btn btn-danger btn-sm" onclick="removeCollaborator('\${u.id}')">Remove</button>\` : ''}
        </div>
      \`).join('');
    }

    async function inviteCollaborator() {
      const input = document.getElementById('inviteUsername');
      const username = input.value.trim();
      if (!username) return;

      const res = await fetch('/api/collaborators/invite', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username })
      });

      const data = await res.json();
      if (res.ok) {
        showToast('Collaborator invited successfully', 'success');
        input.value = '';
        loadCollaborators();
      } else {
        showToast(data.error || 'Failed to invite', 'error');
      }
    }

    async function removeCollaborator(id) {
      if (!confirm('Remove this collaborator?')) return;
      
      const res = await fetch('/api/collaborators/' + id, { method: 'DELETE' });
      if (res.ok) {
        showToast('Collaborator removed', 'success');
        loadCollaborators();
      }
    }

    async function loadTokens() {
      const res = await fetch('/api/tokens');
      const tokens = await res.json();
      
      const list = document.getElementById('tokensList');
      if (!tokens.length) {
        list.innerHTML = '';
        return;
      }

      list.innerHTML = \`
        <h4 style="margin-bottom: 0.75rem; color: var(--text-secondary);">Saved Tokens</h4>
        \${tokens.map(t => \`
          <div class="collaborator-item">
            <div class="collaborator-info">
              <div class="collaborator-name">\${t.token}</div>
              <div class="collaborator-role">\${t.projectId || 'No project'} \${t.isDefault ? '• Default' : ''}</div>
            </div>
          </div>
        \`).join('')}
      \`;
    }

    function openDomainModal(deploymentId, existingDomain) {
      document.getElementById('domainDeploymentId').value = deploymentId;
      document.getElementById('domainInput').value = existingDomain;
      document.getElementById('domainModal').classList.remove('hidden');
    }

    function closeDomainModal() {
      document.getElementById('domainModal').classList.add('hidden');
    }

    async function submitDomain(e) {
      e.preventDefault();
      const deploymentId = document.getElementById('domainDeploymentId').value;
      const domain = document.getElementById('domainInput').value;

      const res = await fetch('/api/deployments/' + deploymentId + '/domain', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ domain })
      });

      if (res.ok) {
        showToast('Domain added successfully', 'success');
        closeDomainModal();
        loadDeployments();
      } else {
        const data = await res.json();
        showToast(data.error || 'Failed to add domain', 'error');
      }
    }

    function showToast(message, type = 'success') {
      const toast = document.createElement('div');
      toast.className = 'toast ' + type;
      toast.textContent = message;
      document.body.appendChild(toast);
      setTimeout(() => toast.remove(), 3000);
    }

    // Tab switching
    document.querySelectorAll('.tab').forEach(tab => {
      tab.addEventListener('click', () => {
        document.querySelectorAll('.tab').forEach(t => t.classList.remove('active'));
        tab.classList.add('active');
        
        document.getElementById('deployTab')?.classList.add('hidden');
        document.getElementById('collaboratorsTab')?.classList.add('hidden');
        document.getElementById('settingsTab')?.classList.add('hidden');
        
        const tabId = tab.dataset.tab + 'Tab';
        document.getElementById(tabId)?.classList.remove('hidden');
        
        if (tab.dataset.tab === 'collaborators') loadCollaborators();
        if (tab.dataset.tab === 'settings') loadTokens();
      });
    });

    // Deploy form
    document.getElementById('deployForm').addEventListener('submit', async (e) => {
      e.preventDefault();
      const form = e.target;
      const data = {
        name: form.name.value,
        projectId: form.projectId.value,
        serviceId: form.serviceId.value,
        environmentId: form.environmentId.value,
        releaseTag: form.releaseTag.value,
        repo: form.repo.value,
      };

      const res = await fetch('/api/deployments', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(data),
      });

      if (res.ok) {
        showToast('Deployment started', 'success');
        form.reset();
        document.getElementById('releaseSelect').innerHTML = '<option value="">— select a repo first —</option>';
        document.getElementById('releaseSelect').disabled = true;
        loadDeployments();
      } else {
        const err = await res.json();
        showToast(err.error || 'Deployment failed', 'error');
      }
    });

    // Token form
    document.getElementById('tokenForm').addEventListener('submit', async (e) => {
      e.preventDefault();
      const form = e.target;
      const data = {
        token: form.token.value,
        projectId: form.projectId.value,
        isDefault: true
      };

      const res = await fetch('/api/tokens', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(data),
      });

      if (res.ok) {
        showToast('Token saved', 'success');
        form.reset();
        loadTokens();
      }
    });

    // Domain form
    document.getElementById('domainForm').addEventListener('submit', submitDomain);

    async function redeploy(id) {
      const res = await fetch('/api/deployments/' + id + '/redeploy', { method: 'POST' });
      if (!res.ok) {
        const err = await res.json();
        showToast(err.error || 'Redeploy failed', 'error');
      }
      loadDeployments();
    }

    async function deleteDeployment(id) {
      if (!confirm('Delete this deployment?')) return;
      await fetch('/api/deployments', {
        method: 'DELETE',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id })
      });
      loadDeployments();
    }

    // Init
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
