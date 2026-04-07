import { db, schema } from './db';
import {
  addCustomDomain,
  changeBranch,
  deployToRailway,
  RailwayClient,
  redeployToRailway,
  updateRootDirectory,
} from './api/railway';
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
import type { ProjectContextRecord } from './api/railway';

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
  rootDirectory?: string;
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

interface ResolvedEnvironment {
  environmentId: string;
  environmentName: string | null;
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

function decorateRailwayAuthError(message: string): string {
  if (message === 'Not Authorized') {
    return `${message}. Check the Railway API token for that project in settings.`;
  }
  return message;
}

function normalizeRootDirectory(rootDirectory?: string | null): string {
  const normalized = rootDirectory?.trim() || '/';
  if (normalized === '.' || normalized === './') {
    return '/';
  }
  if (normalized === '/') {
    return '/';
  }
  return normalized.startsWith('/') ? normalized : `/${normalized}`;
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

  const orderedTokens = [...tokens].sort(
    (left, right) => new Date(right.createdAt).getTime() - new Date(left.createdAt).getTime()
  );

  const matchingToken = orderedTokens.find(candidate => candidate.projectId && candidate.projectId === projectId)
    || orderedTokens.find(candidate => candidate.isDefault)
    || orderedTokens[0];

  return matchingToken?.token || null;
}

async function getProjectServicesForUser(userId: string, projectId: string): Promise<Array<{ id: string; name: string }>> {
  const projectContext = await getProjectContextForUser(userId, projectId);
  return projectContext.services;
}

async function getProjectContextForUser(userId: string, projectId: string): Promise<ProjectContextRecord> {
  const railwayToken = await getRailwayTokenForUser(userId, projectId);
  if (!railwayToken) {
    throw new Error('No Railway token configured for this project');
  }

  const client = new RailwayClient(railwayToken);
  return client.getProjectContext(projectId);
}

async function validateRailwayTokenForProject(token: string, projectId: string): Promise<{ ok: boolean; error?: string }> {
  try {
    const client = new RailwayClient(token);
    await client.getProjectContext(projectId);
    return { ok: true };
  } catch (error) {
    return { ok: false, error: decorateRailwayAuthError(errorMessage(error)) };
  }
}

async function resolveServiceIdForProject(
  userId: string,
  projectId: string,
  serviceIdentifier: string
): Promise<{ serviceId: string; serviceName: string }> {
  const services = await getProjectServicesForUser(userId, projectId);
  const normalizedInput = serviceIdentifier.trim().toLowerCase();
  const matchingService = services.find((candidate) =>
    candidate.id.toLowerCase() === normalizedInput || candidate.name.toLowerCase() === normalizedInput
  );

  if (!matchingService) {
    throw new Error(
      `Service "${serviceIdentifier}" was not found in project ${projectId}. Choose one from the service list.`
    );
  }

  return {
    serviceId: matchingService.id,
    serviceName: matchingService.name,
  };
}

async function resolveEnvironmentIdForProject(
  userId: string,
  projectId: string,
  environmentIdentifier?: string | null
): Promise<ResolvedEnvironment> {
  const projectContext = await getProjectContextForUser(userId, projectId);
  const normalizedInput = environmentIdentifier?.trim().toLowerCase();

  if (!normalizedInput) {
    const defaultEnvironment = projectContext.environments.find(
      (candidate) => candidate.id === projectContext.baseEnvironmentId
    ) || projectContext.environments[0];

    if (defaultEnvironment) {
      return {
        environmentId: defaultEnvironment.id,
        environmentName: defaultEnvironment.name,
      };
    }

    if (projectContext.baseEnvironmentId) {
      return {
        environmentId: projectContext.baseEnvironmentId,
        environmentName: null,
      };
    }

    throw new Error(`No environments were found for project ${projectId}.`);
  }

  const matchingEnvironment = projectContext.environments.find((candidate) =>
    candidate.id.toLowerCase() === normalizedInput || candidate.name.toLowerCase() === normalizedInput
  );

  if (matchingEnvironment) {
    return {
      environmentId: matchingEnvironment.id,
      environmentName: matchingEnvironment.name,
    };
  }

  if (projectContext.baseEnvironmentId && normalizedInput === 'production') {
    const defaultEnvironment = projectContext.environments.find(
      (candidate) => candidate.id === projectContext.baseEnvironmentId
    );
    return {
      environmentId: projectContext.baseEnvironmentId,
      environmentName: defaultEnvironment?.name || null,
    };
  }

  throw new Error(
    `Environment "${environmentIdentifier}" was not found in project ${projectId}. Choose one from the environment list.`
  );
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

async function syncDeploymentRootDirectory(
  deployment: Pick<Deployment, 'railwayToken' | 'serviceId' | 'environmentId' | 'rootDirectory'>
): Promise<void> {
  if (!deployment.railwayToken || !deployment.environmentId) {
    return;
  }

  const desiredRootDirectory = normalizeRootDirectory(deployment.rootDirectory);
  const client = new RailwayClient(deployment.railwayToken);
  const currentInstance = await client.getServiceInstance(deployment.serviceId, deployment.environmentId);
  const currentRootDirectory = normalizeRootDirectory(currentInstance?.rootDirectory);

  if (currentRootDirectory === desiredRootDirectory) {
    return;
  }

  await updateRootDirectory(
    deployment.railwayToken,
    deployment.serviceId,
    deployment.environmentId,
    desiredRootDirectory
  );
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
        const resolvedEnvironment = await resolveEnvironmentIdForProject(
          deployment.userId,
          deployment.projectId,
          deployment.environmentId
        );
        const effectiveEnvironmentId = resolvedEnvironment.environmentId;

        if (deployment.environmentId !== effectiveEnvironmentId) {
          await db
            .update(schema.deployments)
            .set({
              environmentId: effectiveEnvironmentId,
              updatedAt: new Date(),
            })
            .where(eq(schema.deployments.id, deployment.id));
          deployment.environmentId = effectiveEnvironmentId;
        }

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

        await syncDeploymentRootDirectory({
          railwayToken: deployment.railwayToken,
          serviceId: deployment.serviceId,
          environmentId: effectiveEnvironmentId,
          rootDirectory: deployment.rootDirectory,
        });

        const deploymentId = await redeployToRailway(
          deployment.railwayToken,
          deployment.serviceId,
          effectiveEnvironmentId
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
    const loginHtml = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Railway Deployer Login</title>
  <style>
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body {
      min-height: 100vh;
      display: flex;
      align-items: center;
      justify-content: center;
      background: #fafafa;
      color: #0a0a0a;
      font-family: 'JetBrains Mono', monospace;
      padding: 24px;
    }
    .card {
      width: min(420px, 100%);
      background: #ffffff;
      border: 1px solid #e0e0e0;
      padding: 32px;
    }
    h1 {
      font-size: 18px;
      margin-bottom: 12px;
    }
    p {
      font-size: 12px;
      color: #666666;
      line-height: 1.6;
      margin-bottom: 20px;
    }
    a {
      display: inline-block;
      width: 100%;
      padding: 12px 16px;
      text-align: center;
      background: #0a0a0a;
      color: #ffffff;
      text-decoration: none;
      border: 1px solid #0a0a0a;
      font-size: 12px;
    }
  </style>
</head>
<body>
  <div class="card">
    <h1>railway/deployer</h1>
    <p>Sign in with GitHub to manage Railway deployments.</p>
    <a href="/auth/start">continue with github</a>
  </div>
</body>
</html>`;
    return new Response(loginHtml, {
      headers: { 'Content-Type': 'text/html' },
    });
  }

  if (path === '/auth/start') {
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
        'Location': '/auth/login',
        'Set-Cookie': 'session=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0; Expires=Thu, 01 Jan 1970 00:00:00 GMT',
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
    const { name, projectId, serviceId, environmentId, releaseTag, repo, autoDeploy, rootDirectory } = body;

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

    let resolvedService: { serviceId: string; serviceName: string };
    try {
      resolvedService = await resolveServiceIdForProject(sessionUser.id, projectId, serviceId);
    } catch (error) {
      const message = decorateRailwayAuthError(errorMessage(error));
      const status = message.includes('Not Authorized') ? 502 : 400;
      return jsonResponse({ error: message }, { status });
    }

    let resolvedEnvironment: ResolvedEnvironment;
    try {
      resolvedEnvironment = await resolveEnvironmentIdForProject(sessionUser.id, projectId, environmentId);
    } catch (error) {
      const message = decorateRailwayAuthError(errorMessage(error));
      const status = message.includes('Not Authorized') ? 502 : 400;
      return jsonResponse({ error: message }, { status });
    }

    const normalizedRootDirectory = normalizeRootDirectory(rootDirectory);

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
        serviceId: resolvedService.serviceId,
        environmentId: resolvedEnvironment.environmentId,
        releaseTag: releaseResolution.selectedRelease.tag_name,
        repo,
        railwayToken,
        status: 'deploying',
        autoDeploy: Boolean(autoDeploy),
        rootDirectory: normalizedRootDirectory,
        trackedReleaseTag: releaseResolution.selectedRelease.tag_name,
        lastObservedReleaseTag: releaseResolution.latestStableRelease.tag_name,
      })
      .returning();

    try {
      await syncDeploymentRootDirectory({
        railwayToken,
        serviceId: resolvedService.serviceId,
        environmentId: resolvedEnvironment.environmentId,
        rootDirectory: normalizedRootDirectory,
      });

      const deploymentId = await deployToRailway(railwayToken, {
        name,
        projectId,
        serviceId: resolvedService.serviceId,
        environmentId: resolvedEnvironment.environmentId,
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

      return jsonResponse(
        { error: `Deployment failed: ${decorateRailwayAuthError(errorMessage(error))}` },
        { status: 500 }
      );
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
      const resolvedEnvironment = await resolveEnvironmentIdForProject(
        deployment.userId,
        deployment.projectId,
        deployment.environmentId
      );
      const effectiveEnvironmentId = resolvedEnvironment.environmentId;

      if (deployment.environmentId !== effectiveEnvironmentId) {
        await db
          .update(schema.deployments)
          .set({
            environmentId: effectiveEnvironmentId,
            updatedAt: new Date(),
          })
          .where(eq(schema.deployments.id, deploymentId));
        deployment.environmentId = effectiveEnvironmentId;
      }

      const owner = await getUserById(deployment.userId);
      if (owner?.githubAccessToken) {
        releaseResolution = await ensureDeploymentDefaultBranch(deployment, owner.githubAccessToken);
      }

      await syncDeploymentRootDirectory({
        railwayToken: deployment.railwayToken,
        serviceId: deployment.serviceId,
        environmentId: effectiveEnvironmentId,
        rootDirectory: deployment.rootDirectory,
      });

      const newDeploymentId = await redeployToRailway(
        deployment.railwayToken,
        deployment.serviceId,
        effectiveEnvironmentId
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

      return jsonResponse(
        { error: `Redeploy failed: ${decorateRailwayAuthError(errorMessage(error))}` },
        { status: 500 }
      );
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

    if (!projectId) {
      return jsonResponse(
        { error: 'Project ID is required so the token can be validated before saving.' },
        { status: 400 }
      );
    }

    const validation = await validateRailwayTokenForProject(token, projectId);
    if (!validation.ok) {
      return jsonResponse({ error: validation.error || 'Token validation failed' }, { status: 400 });
    }

    if (isDefault) {
      await db
        .update(schema.railwayTokens)
        .set({ isDefault: false })
        .where(eq(schema.railwayTokens.userId, session.userId));
    }

    const existingTokens = await db
      .select()
      .from(schema.railwayTokens)
      .where(eq(schema.railwayTokens.userId, session.userId));

    const orderedTokens = [...existingTokens].sort(
      (left, right) => new Date(right.createdAt).getTime() - new Date(left.createdAt).getTime()
    );

    const existingToken = projectId
      ? orderedTokens.find(candidate => candidate.projectId === projectId)
      : (isDefault ? orderedTokens.find(candidate => candidate.isDefault) : undefined);

    if (existingToken) {
      await db
        .update(schema.railwayTokens)
        .set({
          token,
          projectId,
          isDefault: Boolean(isDefault),
        })
        .where(eq(schema.railwayTokens.id, existingToken.id));
    } else {
      await db
        .insert(schema.railwayTokens)
        .values({
          userId: session.userId,
          token,
          projectId,
          isDefault: Boolean(isDefault),
        });
    }

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

    const maskedTokens = await Promise.all(tokens.map(async (tokenRecord) => {
      let status = 'needs_project';
      let validationError: string | undefined;

      if (tokenRecord.projectId) {
        const validation = await validateRailwayTokenForProject(tokenRecord.token, tokenRecord.projectId);
        status = validation.ok ? 'ok' : 'error';
        validationError = validation.error;
      }

      return {
        id: tokenRecord.id,
        projectId: tokenRecord.projectId,
        isDefault: tokenRecord.isDefault,
        createdAt: tokenRecord.createdAt,
        token: tokenRecord.token.substring(0, 8) + '****',
        status,
        validationError,
      };
    }));

    return jsonResponse(maskedTokens);
  }

  if (path.startsWith('/api/tokens/') && method === 'DELETE') {
    if (!session || !sessionUser) {
      return jsonResponse({ error: 'Unauthorized' }, { status: 401 });
    }

    const tokenId = path.split('/')[3];
    if (!tokenId) {
      return jsonResponse({ error: 'Missing token ID' }, { status: 400 });
    }

    const tokenRecord = await db
      .select()
      .from(schema.railwayTokens)
      .where(eq(schema.railwayTokens.id, tokenId))
      .then(rows => rows[0]);

    if (!tokenRecord || tokenRecord.userId !== session.userId) {
      return jsonResponse({ error: 'Token not found' }, { status: 404 });
    }

    await db.delete(schema.railwayTokens).where(eq(schema.railwayTokens.id, tokenId));

    if (tokenRecord.isDefault) {
      const remainingTokens = await db
        .select()
        .from(schema.railwayTokens)
        .where(eq(schema.railwayTokens.userId, session.userId));

      const nextDefault = [...remainingTokens].sort(
        (left, right) => new Date(right.createdAt).getTime() - new Date(left.createdAt).getTime()
      )[0];

      if (nextDefault) {
        await db
          .update(schema.railwayTokens)
          .set({ isDefault: true })
          .where(eq(schema.railwayTokens.id, nextDefault.id));
      }
    }

    return jsonResponse({ success: true });
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

  if (path === '/api/project-context' && method === 'GET') {
    if (!session || !sessionUser) {
      return jsonResponse({ error: 'Unauthorized' }, { status: 401 });
    }

    if (!isUserAuthorized(sessionUser)) {
      return jsonResponse({ error: 'Forbidden' }, { status: 403 });
    }

    const projectId = url.searchParams.get('projectId');
    if (!projectId) {
      return jsonResponse({ error: 'Missing projectId parameter' }, { status: 400 });
    }

    try {
      const projectContext = await getProjectContextForUser(sessionUser.id, projectId);
      return jsonResponse({
        services: projectContext.services,
        environments: projectContext.environments,
        defaultEnvironmentId: projectContext.baseEnvironmentId,
      });
    } catch (error) {
      const message = decorateRailwayAuthError(errorMessage(error));
      const status = message.includes('Not Authorized') ? 502 : 400;
      return jsonResponse({ error: message }, { status });
    }
  }

  if (path === '/api/project-services' && method === 'GET') {
    if (!session || !sessionUser) {
      return jsonResponse({ error: 'Unauthorized' }, { status: 401 });
    }

    if (!isUserAuthorized(sessionUser)) {
      return jsonResponse({ error: 'Forbidden' }, { status: 403 });
    }

    const projectId = url.searchParams.get('projectId');
    if (!projectId) {
      return jsonResponse({ error: 'Missing projectId parameter' }, { status: 400 });
    }

    try {
      return jsonResponse(await getProjectServicesForUser(sessionUser.id, projectId));
    } catch (error) {
      const message = decorateRailwayAuthError(errorMessage(error));
      const status = message.includes('Not Authorized') ? 502 : 400;
      return jsonResponse({ error: message }, { status });
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

  if (!session || !sessionUser) {
    return new Response('', {
      status: 302,
      headers: {
        Location: '/auth/login',
      },
    });
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
            <input type="text" id="projectInput" name="projectId" list="projectOptions" required placeholder="select saved project or paste project id">
            <datalist id="projectOptions"></datalist>
          </div>
          <div class="form-group">
            <label>service <span>*</span></label>
            <select id="serviceSelect" name="serviceId" required disabled>
              <option value="">-- enter project id first --</option>
            </select>
          </div>
          <div class="form-group">
            <label>environment</label>
            <select id="environmentSelect" name="environmentId" disabled>
              <option value="">-- enter project id first --</option>
            </select>
          </div>
          <div class="form-group full">
            <label>root folder path</label>
            <input type="text" name="rootDirectory" value="/" placeholder="/">
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
            <label>project id <span>*</span></label>
            <input type="text" name="projectId" required placeholder="project id this token should access">
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
    let projectServicesTimer = null;
    let savedProjectIds = [];

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
        const rootState = ' | root ' + (d.rootDirectory || '/');
        return {
          ...d,
          repo: d.repo || '--',
          releaseTag: 'tracked ' + trackedRelease + latestRelease + autoState + rootState,
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

    function setProjectOptions(tokens) {
      const projectOptions = document.getElementById('projectOptions');
      savedProjectIds = [...new Set(
        tokens
          .filter(token => token.status === 'ok')
          .map(token => token.projectId)
          .filter(Boolean)
      )];
      projectOptions.innerHTML = savedProjectIds
        .map(projectId => \`<option value="\${projectId}"></option>\`)
        .join('');

      const projectInput = document.getElementById('projectInput');
      if (!projectInput.value && savedProjectIds.length === 1) {
        projectInput.value = savedProjectIds[0];
        fetchProjectContext(projectInput.value, { silent: true });
      }
    }

    function setServiceOptions(services) {
      const serviceSelect = document.getElementById('serviceSelect');
      if (!services.length) {
        serviceSelect.innerHTML = '<option value="">-- no services found --</option>';
        serviceSelect.disabled = true;
        return;
      }

      serviceSelect.innerHTML = services.map(service =>
        \`<option value="\${service.id}">\${service.name} (\${service.id})</option>\`
      ).join('');
      serviceSelect.disabled = false;
      serviceSelect.value = services[0].id;
    }

    function setEnvironmentOptions(environments, defaultEnvironmentId) {
      const environmentSelect = document.getElementById('environmentSelect');
      if (!environments.length) {
        environmentSelect.innerHTML = '<option value="">-- no environments found --</option>';
        environmentSelect.disabled = true;
        return;
      }

      environmentSelect.innerHTML = environments.map(environment =>
        \`<option value="\${environment.id}">\${environment.name} (\${environment.id})</option>\`
      ).join('');
      environmentSelect.disabled = false;
      environmentSelect.value = defaultEnvironmentId || environments[0].id;
    }

    async function fetchProjectContext(projectId, options = {}) {
      const { silent = false } = options;
      const serviceSelect = document.getElementById('serviceSelect');
      const environmentSelect = document.getElementById('environmentSelect');
      if (!projectId) {
        serviceSelect.innerHTML = '<option value="">-- enter project id first --</option>';
        serviceSelect.disabled = true;
        environmentSelect.innerHTML = '<option value="">-- enter project id first --</option>';
        environmentSelect.disabled = true;
        return;
      }

      const res = await fetch('/api/project-context?projectId=' + encodeURIComponent(projectId));
      if (!res.ok) {
        const data = await res.json().catch(() => ({ error: 'failed to load services' }));
        serviceSelect.innerHTML = \`<option value="">-- \${data.error || 'unable to load services'} --</option>\`;
        serviceSelect.disabled = true;
        environmentSelect.innerHTML = '<option value="">-- unable to load environments --</option>';
        environmentSelect.disabled = true;
        if (!silent) {
          showToast(data.error || 'failed to load services', true);
        }
        return;
      }

      const projectContext = await res.json();
      setServiceOptions(projectContext.services || []);
      setEnvironmentOptions(projectContext.environments || [], projectContext.defaultEnvironmentId);
    }

    function setupProjectSelector() {
      const projectInput = document.getElementById('projectInput');
      projectInput.addEventListener('input', (e) => {
        clearTimeout(projectServicesTimer);
        const projectId = e.target.value.trim();
        projectServicesTimer = setTimeout(() => {
          fetchProjectContext(projectId, { silent: true });
        }, 300);
      });

      const initialProjectId = projectInput.value.trim();
      if (initialProjectId) {
        fetchProjectContext(initialProjectId, { silent: true });
      }
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
      setProjectOptions(tokens);
      if (!tokens.length) { list.innerHTML = ''; return; }
      list.innerHTML = '<div class="section-title">saved</div>' + tokens.map(t => \`
        <div class="token-item">
          <span class="token-mask">\${t.token}</span>
          <button class="btn-danger" onclick="deleteToken('\${t.id}')">delete</button>
          <span style="color:var(--text-muted);font-size:10px;">\${t.projectId || '—'}\${t.isDefault ? ' • default' : ''}\${t.status === 'ok' ? ' • verified' : t.status === 'error' ? ' • invalid' : ' • needs project'}</span>
        </div>
        \${t.validationError ? '<div style="color:var(--danger);font-size:10px;margin:-2px 0 8px 0;">' + t.validationError + '</div>' : t.status === 'needs_project' ? '<div style="color:var(--warning);font-size:10px;margin:-2px 0 8px 0;">save this token again with a project id to validate it</div>' : ''}
      \`).join('');
    }

    async function deleteToken(id) {
      if (!confirm('delete saved token?')) return;
      const res = await fetch('/api/tokens/' + id, { method: 'DELETE' });
      if (res.ok) {
        showToast('deleted');
        loadTokens();
      } else {
        const data = await res.json();
        showToast(data.error || 'error', true);
      }
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
        autoDeploy: f.autoDeploy.checked,
        rootDirectory: f.rootDirectory.value || '/'
      };
      const res = await fetch('/api/deployments', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(d)
      });
      if (res.ok) {
        showToast('deploying');
        f.reset();
        document.getElementById('serviceSelect').innerHTML = '<option value="">-- enter project id first --</option>';
        document.getElementById('serviceSelect').disabled = true;
        document.getElementById('environmentSelect').innerHTML = '<option value="">-- enter project id first --</option>';
        document.getElementById('environmentSelect').disabled = true;
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
      if (res.ok) {
        showToast('saved');
        f.reset();
        loadTokens();
        const currentProjectId = document.getElementById('projectInput').value.trim();
        if (currentProjectId) fetchProjectContext(currentProjectId, { silent: true });
      } else {
        const data = await res.json().catch(() => ({ error: 'failed to save token' }));
        showToast(data.error || 'failed to save token', true);
      }
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
      setupProjectSelector();
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
