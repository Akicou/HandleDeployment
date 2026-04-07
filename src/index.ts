import { db, schema } from './db';
import { addCustomDomain, changeBranch, deployToRailway, redeployToRailway } from './api/railway';
import {
  exchangeCodeForToken,
  findOrCreateUser,
  generateState,
  getGitHubAuthUrl,
  getGitHubReleases,
  getGitHubRepo,
  getGitHubRepos,
  getGitHubUserByUsername,
  isStableRelease,
  isUserAuthorized,
  sortReleasesNewestFirst,
} from './auth/github';
import { runMigrations } from './db/migrate';
import { eq } from 'drizzle-orm';
import type { Deployment, User } from './db/schema';
import type { GitHubRelease, GitHubRepo } from './auth/github';

const PORT = parseInt(process.env.PORT || '3000', 10);
const RELEASE_WATCH_INTERVAL_MS = 5 * 60 * 1000;

interface Session {
  userId: string;
  githubToken: string;
  createdAt: Date;
}

interface CreateDeploymentBody {
  name?: string;
  projectId?: string;
  serviceId?: string;
  environmentId?: string;
  releaseTag?: string;
  repo?: string;
  autoDeploy?: boolean;
}

interface DeleteDeploymentBody {
  id?: string;
}

interface AuthorizeUserBody {
  userId?: string;
  authorized?: boolean;
}

interface SaveTokenBody {
  token?: string;
  projectId?: string;
  isDefault?: boolean;
}

interface InviteCollaboratorBody {
  username?: string;
}

interface AddDomainBody {
  domain?: string;
}

interface ReleaseResolution {
  repo: GitHubRepo;
  stableReleases: GitHubRelease[];
  latestStableRelease: GitHubRelease;
  selectedRelease: GitHubRelease;
}

type PublicUser = Omit<User, 'githubAccessToken'>;
type PublicDeployment = Omit<Deployment, 'railwayToken'>;

const sessions = new Map<string, Session>();
let releaseWatcherRunning = false;

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

function jsonResponse(payload: unknown, init: ResponseInit = {}): Response {
  return new Response(JSON.stringify(payload), {
    status: init.status,
    statusText: init.statusText,
    headers: { 'Content-Type': 'application/json' },
  });
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function toPublicUser(user: User): PublicUser {
  const { githubAccessToken: _token, ...publicUser } = user;
  return publicUser;
}

function toPublicDeployment(deployment: Deployment): PublicDeployment {
  const { railwayToken: _token, ...publicDeployment } = deployment;
  return publicDeployment;
}

async function getUserById(userId: string): Promise<User | undefined> {
  return db.select().from(schema.users).where(eq(schema.users.id, userId)).then(rows => rows[0]);
}

async function getDeploymentById(deploymentId: string): Promise<Deployment | undefined> {
  return db.select().from(schema.deployments).where(eq(schema.deployments.id, deploymentId)).then(rows => rows[0]);
}

async function getRailwayTokenForUser(userId: string, projectId?: string): Promise<string | null> {
  const tokens = await db
    .select()
    .from(schema.railwayTokens)
    .where(eq(schema.railwayTokens.userId, userId));

  const matchingToken = tokens.find(candidate => candidate.projectId && candidate.projectId === projectId)
    || tokens.find(candidate => candidate.isDefault)
    || tokens[0];

  return matchingToken?.token || null;
}

async function resolveReleaseSelection(
  githubToken: string,
  repoFullName: string,
  requestedReleaseTag?: string | null
): Promise<ReleaseResolution> {
  const [repo, releases] = await Promise.all([
    getGitHubRepo(githubToken, repoFullName),
    getGitHubReleases(githubToken, repoFullName),
  ]);

  const stableReleases = sortReleasesNewestFirst(releases.filter(isStableRelease));
  const latestStableRelease = stableReleases[0];

  if (!latestStableRelease) {
    throw new Error(`No stable releases found for ${repoFullName}`);
  }

  let selectedRelease = latestStableRelease;
  if (requestedReleaseTag) {
    const matchingRelease = stableReleases.find(candidate => candidate.tag_name === requestedReleaseTag);
    if (!matchingRelease) {
      throw new Error(`"${requestedReleaseTag}" is not a valid stable release tag for ${repoFullName}`);
    }
    selectedRelease = matchingRelease;
  }

  return {
    repo,
    stableReleases,
    latestStableRelease,
    selectedRelease,
  };
}

async function ensureDeploymentDefaultBranch(
  deployment: Deployment,
  githubToken: string
): Promise<ReleaseResolution | null> {
  if (!deployment.repo || !deployment.railwayToken) {
    return null;
  }

  const releaseResolution = await resolveReleaseSelection(githubToken, deployment.repo);
  await changeBranch(
    deployment.railwayToken,
    deployment.serviceId,
    deployment.repo,
    releaseResolution.repo.default_branch
  );
  return releaseResolution;
}

async function refreshReleaseMetadataWithoutDeploy(deployment: Deployment): Promise<void> {
  if (!deployment.repo || deployment.trackedReleaseTag || deployment.releaseTag) {
    return;
  }

  const owner = await getUserById(deployment.userId);
  if (!owner?.githubAccessToken) {
    return;
  }

  try {
    const releaseResolution = await resolveReleaseSelection(owner.githubAccessToken, deployment.repo);
    await db
      .update(schema.deployments)
      .set({
        releaseTag: releaseResolution.latestStableRelease.tag_name,
        trackedReleaseTag: releaseResolution.latestStableRelease.tag_name,
        lastObservedReleaseTag: releaseResolution.latestStableRelease.tag_name,
        updatedAt: new Date(),
      })
      .where(eq(schema.deployments.id, deployment.id));
  } catch (error) {
    console.error(`Failed to refresh release metadata for deployment ${deployment.id}: ${errorMessage(error)}`);
  }
}

async function runReleaseWatcher(): Promise<void> {
  if (releaseWatcherRunning) {
    return;
  }

  releaseWatcherRunning = true;

  try {
    const deployments = await db
      .select()
      .from(schema.deployments)
      .where(eq(schema.deployments.autoDeploy, true));

    for (const deployment of deployments) {
      if (!deployment.repo || !deployment.railwayToken) {
        continue;
      }

      const owner = await getUserById(deployment.userId);
      if (!owner?.githubAccessToken) {
        continue;
      }

      try {
        const releaseResolution = await resolveReleaseSelection(owner.githubAccessToken, deployment.repo);
        const currentTrackedTag = deployment.trackedReleaseTag || deployment.releaseTag || null;
        const latestTag = releaseResolution.latestStableRelease.tag_name;

        if (!currentTrackedTag) {
          await db
            .update(schema.deployments)
            .set({
              releaseTag: latestTag,
              trackedReleaseTag: latestTag,
              lastObservedReleaseTag: latestTag,
              updatedAt: new Date(),
            })
            .where(eq(schema.deployments.id, deployment.id));
          continue;
        }

        await db
          .update(schema.deployments)
          .set({
            lastObservedReleaseTag: latestTag,
            updatedAt: new Date(),
          })
          .where(eq(schema.deployments.id, deployment.id));

        if (currentTrackedTag === latestTag) {
          continue;
        }

        await db
          .update(schema.deployments)
          .set({
            status: 'deploying',
            lastObservedReleaseTag: latestTag,
            updatedAt: new Date(),
          })
          .where(eq(schema.deployments.id, deployment.id));

        await changeBranch(
          deployment.railwayToken,
          deployment.serviceId,
          deployment.repo,
          releaseResolution.repo.default_branch
        );

        const deploymentId = await redeployToRailway(
          deployment.railwayToken,
          deployment.serviceId,
          deployment.environmentId || undefined
        );

        await db
          .update(schema.deployments)
          .set({
            status: 'deployed',
            deploymentId,
            releaseTag: latestTag,
            trackedReleaseTag: latestTag,
            lastObservedReleaseTag: latestTag,
            lastDeployedAt: new Date(),
            updatedAt: new Date(),
          })
          .where(eq(schema.deployments.id, deployment.id));
      } catch (error) {
        await db
          .update(schema.deployments)
          .set({
            status: 'failed',
            updatedAt: new Date(),
          })
          .where(eq(schema.deployments.id, deployment.id));

        console.error(`Auto deploy failed for ${deployment.id}: ${errorMessage(error)}`);
      }
    }
  } finally {
    releaseWatcherRunning = false;
  }
}

function startReleaseWatcher(): void {
  void runReleaseWatcher();
  setInterval(() => {
    void runReleaseWatcher();
  }, RELEASE_WATCH_INTERVAL_MS);
}

async function handleRequest(req: Request): Promise<Response> {
  const url = new URL(req.url);
  const path = url.pathname;
  const method = req.method;

  const cookieHeader = req.headers.get('cookie') || '';
  const cookies = parseCookies(cookieHeader);
  const sessionId = cookies.session;
  const session = sessionId ? getSession(sessionId) : null;
  const sessionUser = session ? await getUserById(session.userId) : null;

  if (path === '/health') {
    return jsonResponse({ status: 'ok' });
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
      const newSessionId = createSession(user.id, token);

      return new Response('', {
        status: 302,
        headers: {
          'Location': '/',
          'Set-Cookie': `session=${newSessionId}; Path=/; HttpOnly; SameSite=Lax; Max-Age=604800`,
        },
      });
    } catch (error) {
      return new Response(`Auth error: ${errorMessage(error)}`, { status: 500 });
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
    if (!session || !sessionUser) {
      return jsonResponse({ error: 'Unauthorized' }, { status: 401 });
    }

    return jsonResponse(toPublicUser(sessionUser));
  }

  if (path === '/api/deployments' && method === 'GET') {
    if (!session || !sessionUser) {
      return jsonResponse({ error: 'Unauthorized' }, { status: 401 });
    }

    if (!isUserAuthorized(sessionUser)) {
      return jsonResponse({ error: 'Forbidden' }, { status: 403 });
    }

    const deployments = await db.select().from(schema.deployments).orderBy(schema.deployments.createdAt);
    for (const deployment of deployments) {
      await refreshReleaseMetadataWithoutDeploy(deployment);
    }

    const refreshedDeployments = await db.select().from(schema.deployments).orderBy(schema.deployments.createdAt);
    return jsonResponse(refreshedDeployments.map(toPublicDeployment));
  }

  if (path === '/api/deployments' && method === 'POST') {
    if (!session || !sessionUser) {
      return jsonResponse({ error: 'Unauthorized' }, { status: 401 });
    }

    if (!isUserAuthorized(sessionUser)) {
      return jsonResponse({ error: 'Forbidden' }, { status: 403 });
    }

    const body = await req.json() as CreateDeploymentBody;
    const { name, projectId, serviceId, environmentId, releaseTag, repo, autoDeploy } = body;

    if (!name || !projectId || !serviceId || !repo) {
      return jsonResponse(
        { error: 'Missing required fields: name, projectId, serviceId, and repo are all required' },
        { status: 400 }
      );
    }

    const railwayToken = await getRailwayTokenForUser(sessionUser.id, projectId);
    if (!railwayToken) {
      return jsonResponse({ error: 'No Railway token configured' }, { status: 400 });
    }

    let releaseResolution: ReleaseResolution;
    try {
      releaseResolution = await resolveReleaseSelection(session.githubToken, repo, releaseTag);
    } catch (error) {
      const message = errorMessage(error);
      const status = message.includes('Failed to fetch') ? 502 : 400;
      return jsonResponse({ error: message }, { status });
    }

    const [deployment] = await db
      .insert(schema.deployments)
      .values({
        userId: sessionUser.id,
        name,
        projectId,
        serviceId,
        environmentId: environmentId || 'production',
        releaseTag: releaseResolution.selectedRelease.tag_name,
        repo,
        railwayToken,
        status: 'deploying',
        autoDeploy: Boolean(autoDeploy),
        trackedReleaseTag: releaseResolution.selectedRelease.tag_name,
        lastObservedReleaseTag: releaseResolution.latestStableRelease.tag_name,
      })
      .returning();

    try {
      const deploymentId = await deployToRailway(railwayToken, {
        name,
        projectId,
        serviceId,
        environmentId,
        repo,
        branch: releaseResolution.repo.default_branch,
      });

      const [updatedDeployment] = await db
        .update(schema.deployments)
        .set({
          status: 'deployed',
          deploymentId,
          lastDeployedAt: new Date(),
          updatedAt: new Date(),
        })
        .where(eq(schema.deployments.id, deployment.id))
        .returning();

      return jsonResponse(toPublicDeployment(updatedDeployment));
    } catch (error) {
      await db
        .update(schema.deployments)
        .set({ status: 'failed', updatedAt: new Date() })
        .where(eq(schema.deployments.id, deployment.id));

      return jsonResponse({ error: `Deployment failed: ${errorMessage(error)}` }, { status: 500 });
    }
  }

  if (path.startsWith('/api/deployments/') && path.endsWith('/redeploy') && method === 'POST') {
    if (!session || !sessionUser) {
      return jsonResponse({ error: 'Unauthorized' }, { status: 401 });
    }

    if (!isUserAuthorized(sessionUser)) {
      return jsonResponse({ error: 'Forbidden' }, { status: 403 });
    }

    const deploymentId = path.split('/')[3];
    const deployment = await getDeploymentById(deploymentId);

    if (!deployment) {
      return jsonResponse({ error: 'Deployment not found' }, { status: 404 });
    }

    if (!deployment.railwayToken) {
      return jsonResponse({ error: 'Deployment is missing a Railway token' }, { status: 400 });
    }

    let releaseResolution: ReleaseResolution | null = null;

    try {
      const owner = await getUserById(deployment.userId);
      if (owner?.githubAccessToken) {
        releaseResolution = await ensureDeploymentDefaultBranch(deployment, owner.githubAccessToken);
      }

      const newDeploymentId = await redeployToRailway(
        deployment.railwayToken,
        deployment.serviceId,
        deployment.environmentId || undefined
      );

      const trackedTag = releaseResolution?.latestStableRelease.tag_name
        || deployment.trackedReleaseTag
        || deployment.releaseTag
        || null;

      const [updatedDeployment] = await db
        .update(schema.deployments)
        .set({
          status: 'deployed',
          deploymentId: newDeploymentId,
          releaseTag: trackedTag,
          trackedReleaseTag: trackedTag,
          lastObservedReleaseTag: releaseResolution?.latestStableRelease.tag_name || deployment.lastObservedReleaseTag,
          lastDeployedAt: new Date(),
          updatedAt: new Date(),
        })
        .where(eq(schema.deployments.id, deploymentId))
        .returning();

      return jsonResponse({
        success: true,
        deploymentId: newDeploymentId,
        deployment: toPublicDeployment(updatedDeployment),
      });
    } catch (error) {
      await db
        .update(schema.deployments)
        .set({ status: 'failed', updatedAt: new Date() })
        .where(eq(schema.deployments.id, deploymentId));

      return jsonResponse({ error: `Redeploy failed: ${errorMessage(error)}` }, { status: 500 });
    }
  }

  if (path === '/api/deployments' && method === 'DELETE') {
    if (!session || !sessionUser) {
      return jsonResponse({ error: 'Unauthorized' }, { status: 401 });
    }

    if (!isUserAuthorized(sessionUser)) {
      return jsonResponse({ error: 'Forbidden' }, { status: 403 });
    }

    const body = await req.json() as DeleteDeploymentBody;
    if (!body.id) {
      return jsonResponse({ error: 'Missing deployment ID' }, { status: 400 });
    }

    await db.delete(schema.deployments).where(eq(schema.deployments.id, body.id));

    return jsonResponse({ success: true });
  }

  if (path === '/api/authorize' && method === 'POST') {
    if (!session || !sessionUser) {
      return jsonResponse({ error: 'Unauthorized' }, { status: 401 });
    }

    if (!sessionUser.isOwner) {
      return jsonResponse({ error: 'Only owner can authorize users' }, { status: 403 });
    }

    const body = await req.json() as AuthorizeUserBody;
    if (!body.userId || typeof body.authorized !== 'boolean') {
      return jsonResponse({ error: 'Missing userId or authorized value' }, { status: 400 });
    }

    await db
      .update(schema.users)
      .set({ isAuthorized: body.authorized, updatedAt: new Date() })
      .where(eq(schema.users.id, body.userId));

    return jsonResponse({ success: true });
  }

  if (path === '/api/tokens' && method === 'POST') {
    if (!session || !sessionUser) {
      return jsonResponse({ error: 'Unauthorized' }, { status: 401 });
    }

    const body = await req.json() as SaveTokenBody;
    const { token, projectId, isDefault } = body;

    if (!token) {
      return jsonResponse({ error: 'Missing token' }, { status: 400 });
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
        isDefault: Boolean(isDefault),
      });

    return jsonResponse({ success: true });
  }

  if (path === '/api/tokens' && method === 'GET') {
    if (!session || !sessionUser) {
      return jsonResponse({ error: 'Unauthorized' }, { status: 401 });
    }

    const tokens = await db
      .select()
      .from(schema.railwayTokens)
      .where(eq(schema.railwayTokens.userId, session.userId));

    const maskedTokens = tokens.map(tokenRecord => ({
      id: tokenRecord.id,
      projectId: tokenRecord.projectId,
      isDefault: tokenRecord.isDefault,
      createdAt: tokenRecord.createdAt,
      token: tokenRecord.token.substring(0, 8) + '****',
    }));

    return jsonResponse(maskedTokens);
  }

  if (path === '/api/releases' && method === 'GET') {
    if (!session || !sessionUser) {
      return jsonResponse({ error: 'Unauthorized' }, { status: 401 });
    }

    const repo = url.searchParams.get('repo');
    if (!repo || !repo.includes('/')) {
      return jsonResponse({ error: 'Missing or invalid repo parameter (expected owner/repo)' }, { status: 400 });
    }

    try {
      const releases = await getGitHubReleases(session.githubToken, repo);
      return jsonResponse(sortReleasesNewestFirst(releases.filter(isStableRelease)));
    } catch (error) {
      return jsonResponse({ error: `Failed to fetch releases: ${errorMessage(error)}` }, { status: 502 });
    }
  }

  // GET /api/repos - List user's GitHub repositories
  if (path === '/api/repos' && method === 'GET') {
    if (!session || !sessionUser) {
      return jsonResponse({ error: 'Unauthorized' }, { status: 401 });
    }

    try {
      const repos = await getGitHubRepos(session.githubToken);
      return jsonResponse(repos);
    } catch (error) {
      return jsonResponse({ error: `Failed to fetch repositories: ${errorMessage(error)}` }, { status: 502 });
    }
  }

  // POST /api/collaborators/invite - Invite a collaborator by GitHub username
  if (path === '/api/collaborators/invite' && method === 'POST') {
    if (!session || !sessionUser) {
      return jsonResponse({ error: 'Unauthorized' }, { status: 401 });
    }

    if (!sessionUser.isOwner) {
      return jsonResponse({ error: 'Only owner can invite collaborators' }, { status: 403 });
    }

    const body = await req.json() as InviteCollaboratorBody;
    if (!body.username) {
      return jsonResponse({ error: 'Missing username' }, { status: 400 });
    }

    try {
      const githubUser = await getGitHubUserByUsername(session.githubToken, body.username);
      if (!githubUser) {
        return jsonResponse({ error: 'GitHub user not found' }, { status: 404 });
      }

      // Check if user already exists
      const existingUser = await db
        .select()
        .from(schema.users)
        .where(eq(schema.users.githubId, String(githubUser.id)))
        .then(rows => rows[0]);

      if (existingUser) {
        if (existingUser.isAuthorized) {
          return jsonResponse({ error: 'User is already a collaborator' }, { status: 400 });
        }

        const [updatedUser] = await db
          .update(schema.users)
          .set({ isAuthorized: true, updatedAt: new Date() })
          .where(eq(schema.users.id, existingUser.id))
          .returning();
        return jsonResponse({ success: true, user: toPublicUser(updatedUser) });
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

      return jsonResponse({ success: true, user: toPublicUser(newUser) });
    } catch (error) {
      return jsonResponse({ error: `Failed to invite collaborator: ${errorMessage(error)}` }, { status: 500 });
    }
  }

  // GET /api/collaborators - List all collaborators
  if (path === '/api/collaborators' && method === 'GET') {
    if (!session || !sessionUser) {
      return jsonResponse({ error: 'Unauthorized' }, { status: 401 });
    }

    if (!sessionUser.isOwner && !sessionUser.isAuthorized) {
      return jsonResponse({ error: 'Forbidden' }, { status: 403 });
    }

    const users = await db.select().from(schema.users);
    return jsonResponse(users.map(toPublicUser));
  }

  // DELETE /api/collaborators/:id - Remove a collaborator
  if (path.startsWith('/api/collaborators/') && method === 'DELETE') {
    if (!session || !sessionUser) {
      return jsonResponse({ error: 'Unauthorized' }, { status: 401 });
    }

    if (!sessionUser.isOwner) {
      return jsonResponse({ error: 'Only owner can remove collaborators' }, { status: 403 });
    }

    const collaboratorId = path.split('/')[3];
    const collaborator = await getUserById(collaboratorId);
    if (!collaborator) {
      return jsonResponse({ error: 'Collaborator not found' }, { status: 404 });
    }

    if (collaborator.isOwner) {
      return jsonResponse({ error: 'Cannot remove the owner' }, { status: 400 });
    }

    await db.delete(schema.users).where(eq(schema.users.id, collaboratorId));
    return jsonResponse({ success: true });
  }

  // POST /api/deployments/:id/domain - Add custom domain to deployment
  if (path.match(/^\/api\/deployments\/[^/]+\/domain$/) && method === 'POST') {
    if (!session || !sessionUser) {
      return jsonResponse({ error: 'Unauthorized' }, { status: 401 });
    }

    if (!isUserAuthorized(sessionUser)) {
      return jsonResponse({ error: 'Forbidden' }, { status: 403 });
    }

    const deploymentId = path.split('/')[3];
    const deployment = await getDeploymentById(deploymentId);

    if (!deployment) {
      return jsonResponse({ error: 'Deployment not found' }, { status: 404 });
    }

    if (!deployment.railwayToken) {
      return jsonResponse({ error: 'Deployment is missing a Railway token' }, { status: 400 });
    }

    const body = await req.json() as AddDomainBody;
    if (!body.domain) {
      return jsonResponse({ error: 'Missing domain' }, { status: 400 });
    }

    try {
      await addCustomDomain(deployment.railwayToken, deployment.serviceId, body.domain);

      await db
        .update(schema.deployments)
        .set({ customDomain: body.domain, updatedAt: new Date() })
        .where(eq(schema.deployments.id, deploymentId));

      return jsonResponse({ success: true, domain: body.domain });
    } catch (error) {
      return jsonResponse({ error: `Failed to add domain: ${errorMessage(error)}` }, { status: 500 });
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

    .meta-pill {
      display: inline-block;
      padding: 2px 6px;
      border: 1px solid var(--border);
      font-size: 10px;
      margin-right: 8px;
      margin-top: 4px;
    }

    .meta-pill.success {
      border-color: var(--success);
      color: var(--success);
    }

    .meta-pill.warning {
      border-color: var(--warning);
      color: var(--warning);
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

    .checkbox-row {
      display: flex;
      align-items: center;
      gap: 10px;
      font-size: 12px;
      color: var(--text-muted);
    }

    .checkbox-row input {
      width: auto;
      accent-color: var(--accent);
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
      <button id="collabTab" data-tab="collab" style="display:none;">team</button>
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
            <label>release</label>
            <select id="releaseSelect" name="releaseTag" disabled>
              <option value="">— select repo —</option>
            </select>
          </div>
          <div class="form-group full">
            <label class="checkbox-row">
              <input type="checkbox" id="autoDeployInput" name="autoDeploy">
              <span>auto deploy when a newer stable release is published</span>
            </label>
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
      const data = (await res.json()).map(d => {
        const trackedRelease = d.trackedReleaseTag || d.releaseTag || '--';
        const latestRelease = d.lastObservedReleaseTag && d.lastObservedReleaseTag !== trackedRelease
          ? ' | latest ' + d.lastObservedReleaseTag
          : '';
        const autoState = d.autoDeploy ? ' | auto' : '';
        return {
          ...d,
          repo: d.repo || '--',
          releaseTag: 'tracked ' + trackedRelease + latestRelease + autoState,
        };
      });
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
        sel.value = data[0].tag_name;
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
        releaseTag: f.releaseTag.value || undefined,
        repo: f.repo.value,
        autoDeploy: f.autoDeploy.checked
      };
      const res = await fetch('/api/deployments', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(d)
      });
      if (res.ok) {
        showToast('deploying');
        f.reset();
        document.getElementById('releaseSelect').disabled = true;
        loadDeployments();
      }
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
startReleaseWatcher();

const server = Bun.serve({
  port: PORT,
  fetch: handleRequest,
});

console.log(`Railway Deployer running at http://localhost:${PORT}`);
