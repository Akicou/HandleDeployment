import { db, schema } from './db';
import { RailwayClient, deployToRailway, redeployToRailway } from './api/railway';
import {
  getGitHubAuthUrl,
  exchangeCodeForToken,
  findOrCreateUser,
  generateState,
  isUserAuthorized,
  getGitHubReleases,
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

  if (path === '/auth/logout') {
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

  const html = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Railway Deployer</title>
  <script src="https://cdn.tailwindcss.com"></script>
</head>
<body class="bg-gray-50 min-h-screen text-gray-900">
  <div class="max-w-5xl mx-auto px-4 py-8">

    <header class="mb-8">
      <div class="flex items-center justify-between">
        <div>
          <h1 class="text-2xl font-semibold tracking-tight">Railway Deployer</h1>
          <p class="text-sm text-gray-500 mt-1">Deploy and manage your Railway apps from GitHub releases</p>
        </div>
        <nav class="flex items-center gap-4 text-sm">
          <a href="/" class="text-gray-600 hover:text-gray-900 transition-colors">Deployments</a>
          <a href="/auth/logout" class="text-gray-600 hover:text-gray-900 transition-colors">Logout</a>
        </nav>
      </div>
    </header>

    <div class="bg-white rounded-2xl border border-gray-200 shadow-sm p-6 mb-6">
      <h2 class="text-base font-semibold mb-5">New Deployment</h2>
      <form id="deployForm" class="grid grid-cols-1 sm:grid-cols-2 gap-4">
        <div>
          <label class="block text-xs font-medium text-gray-600 mb-1">Name <span class="text-red-500">*</span></label>
          <input type="text" name="name" required placeholder="my-app"
            class="w-full px-3 py-2 text-sm border border-gray-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent transition">
        </div>
        <div>
          <label class="block text-xs font-medium text-gray-600 mb-1">Project ID <span class="text-red-500">*</span></label>
          <input type="text" name="projectId" required placeholder="proj_xxx"
            class="w-full px-3 py-2 text-sm border border-gray-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent transition">
        </div>
        <div>
          <label class="block text-xs font-medium text-gray-600 mb-1">Service ID <span class="text-red-500">*</span></label>
          <input type="text" name="serviceId" required placeholder="svc_xxx"
            class="w-full px-3 py-2 text-sm border border-gray-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent transition">
        </div>
        <div>
          <label class="block text-xs font-medium text-gray-600 mb-1">Environment ID</label>
          <input type="text" name="environmentId" placeholder="env_xxx (defaults to production)"
            class="w-full px-3 py-2 text-sm border border-gray-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent transition">
        </div>
        <div>
          <label class="block text-xs font-medium text-gray-600 mb-1">Repository <span class="text-red-500">*</span></label>
          <input type="text" id="repoInput" name="repo" required placeholder="owner/repo"
            class="w-full px-3 py-2 text-sm border border-gray-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent transition"
            oninput="debouncedFetchReleases(this.value)">
        </div>
        <div>
          <label class="block text-xs font-medium text-gray-600 mb-1">Release <span class="text-red-500">*</span></label>
          <select id="releaseSelect" name="releaseTag" required disabled
            class="w-full px-3 py-2 text-sm border border-gray-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent transition bg-white disabled:bg-gray-50 disabled:text-gray-400">
            <option value="">— enter a repo first —</option>
          </select>
          <p id="releaseStatus" class="mt-1 text-xs text-gray-400"></p>
        </div>
        <div class="sm:col-span-2 pt-1">
          <button type="submit"
            class="px-5 py-2 bg-blue-600 hover:bg-blue-700 text-white text-sm font-medium rounded-lg transition-colors">
            Deploy
          </button>
        </div>
      </form>
    </div>

    <div class="bg-white rounded-2xl border border-gray-200 shadow-sm p-6">
      <h2 class="text-base font-semibold mb-5">Active Deployments</h2>
      <div class="overflow-x-auto">
        <table class="w-full text-sm">
          <thead>
            <tr class="border-b border-gray-100">
              <th class="text-left text-xs font-medium text-gray-500 pb-3 pr-4">Name</th>
              <th class="text-left text-xs font-medium text-gray-500 pb-3 pr-4">Release</th>
              <th class="text-left text-xs font-medium text-gray-500 pb-3 pr-4">Status</th>
              <th class="text-left text-xs font-medium text-gray-500 pb-3 pr-4">Last Deployed</th>
              <th class="text-left text-xs font-medium text-gray-500 pb-3">Actions</th>
            </tr>
          </thead>
          <tbody id="deploymentsBody">
            <tr><td colspan="5" class="py-8 text-center text-gray-400 text-sm">Loading...</td></tr>
          </tbody>
        </table>
      </div>
    </div>

  </div>

  <script>
    const statusClasses = {
      pending:   'bg-yellow-50 text-yellow-700 border border-yellow-200',
      deploying: 'bg-blue-50 text-blue-700 border border-blue-200',
      deployed:  'bg-green-50 text-green-700 border border-green-200',
      failed:    'bg-red-50 text-red-700 border border-red-200',
    };

    async function loadUser() {
      const res = await fetch('/api/user');
      if (!res.ok) {
        window.location.href = '/auth/login';
        return null;
      }
      return res.json();
    }

    async function loadDeployments() {
      const res = await fetch('/api/deployments');
      const data = await res.json();
      const tbody = document.getElementById('deploymentsBody');

      if (!data.length) {
        tbody.innerHTML = '<tr><td colspan="5" class="py-8 text-center text-gray-400 text-sm">No deployments yet</td></tr>';
        return;
      }

      tbody.innerHTML = data.map(d => \`
        <tr class="border-b border-gray-50 last:border-0">
          <td class="py-3 pr-4 font-medium">\${d.name}</td>
          <td class="py-3 pr-4">
            <code class="text-xs bg-gray-100 px-2 py-0.5 rounded">\${d.releaseTag || '—'}</code>
          </td>
          <td class="py-3 pr-4">
            <span class="inline-flex items-center px-2 py-0.5 rounded text-xs font-medium \${statusClasses[d.status] || statusClasses.pending}">
              \${d.status}
            </span>
          </td>
          <td class="py-3 pr-4 text-gray-500">\${d.lastDeployedAt ? new Date(d.lastDeployedAt).toLocaleString() : 'Never'}</td>
          <td class="py-3">
            <div class="flex gap-2">
              <button onclick="redeploy('\${d.id}')"
                class="px-3 py-1 text-xs font-medium bg-green-600 hover:bg-green-700 text-white rounded-md transition-colors">
                Redeploy
              </button>
              <button onclick="deleteDeployment('\${d.id}')"
                class="px-3 py-1 text-xs font-medium bg-white hover:bg-red-50 text-red-600 border border-red-200 rounded-md transition-colors">
                Delete
              </button>
            </div>
          </td>
        </tr>
      \`).join('');
    }

    async function redeploy(id) {
      const res = await fetch(\`/api/deployments/\${id}/redeploy\`, { method: 'POST' });
      if (!res.ok) {
        const err = await res.json();
        alert(err.error || 'Redeploy failed');
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

    let releaseDebounceTimer = null;
    function debouncedFetchReleases(repo) {
      clearTimeout(releaseDebounceTimer);
      const select = document.getElementById('releaseSelect');
      const status = document.getElementById('releaseStatus');
      if (!repo || !repo.includes('/')) {
        select.innerHTML = '<option value="">— enter a valid repo (owner/repo) —</option>';
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
            status.textContent = err.error || 'Failed to load releases';
            select.innerHTML = '<option value="">— error loading releases —</option>';
            select.disabled = true;
            return;
          }
          const releases = await res.json();
          if (!releases.length) {
            status.textContent = 'No releases found for this repo';
            select.innerHTML = '<option value="">— no releases —</option>';
            select.disabled = true;
            return;
          }
          select.innerHTML = releases
            .map(r => '<option value="' + r.tag_name + '">' + (r.name || r.tag_name) + ' (' + r.tag_name + ')</option>')
            .join('');
          select.disabled = false;
          status.textContent = releases.length + ' release' + (releases.length === 1 ? '' : 's') + ' available';
        } catch (e) {
          status.textContent = 'Network error fetching releases';
          select.disabled = true;
        }
      }, 500);
    }

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
        form.reset();
        document.getElementById('releaseSelect').innerHTML = '<option value="">— enter a repo first —</option>';
        document.getElementById('releaseSelect').disabled = true;
        document.getElementById('releaseStatus').textContent = '';
        loadDeployments();
      } else {
        const err = await res.json();
        alert(err.error || 'Deployment failed');
      }
    });

    loadUser().then(() => loadDeployments());
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
