import { db, schema } from './db';
import { RailwayClient, deployToRailway, redeployToRailway } from './api/railway';
import { 
  getGitHubAuthUrl, 
  exchangeCodeForToken, 
  findOrCreateUser, 
  generateState,
  isUserAuthorized 
} from './auth/github';
import { eq } from 'drizzle-orm';

const PORT = parseInt(process.env.PORT || '3000');
const SESSION_SECRET = process.env.SESSION_SECRET || 'dev-secret-change-in-production';

interface Session {
  userId: string;
  createdAt: Date;
}

const sessions = new Map<string, Session>();

function generateSessionId(): string {
  return Math.random().toString(36).substring(2, 15) + Math.random().toString(36).substring(2, 15);
}

function createSession(userId: string): string {
  const sessionId = generateSessionId();
  sessions.set(sessionId, { userId, createdAt: new Date() });
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
      const sessionId = createSession(user.id);
      
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
    const { name, projectId, serviceId, environmentId, branch, repo } = body;
    
    if (!name || !projectId || !serviceId) {
      return new Response(JSON.stringify({ error: 'Missing required fields' }), { 
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

    const [deployment] = await db
      .insert(schema.deployments)
      .values({
        userId: user.id,
        name,
        projectId,
        serviceId,
        environmentId: environmentId || 'production',
        branch: branch || 'main',
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
        branch,
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

  const html = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Railway Deployer</title>
  <style>
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; background: #f5f5f5; }
    .container { max-width: 1200px; margin: 0 auto; padding: 20px; }
    header { background: #fff; padding: 20px; border-radius: 8px; margin-bottom: 20px; box-shadow: 0 1px 3px rgba(0,0,0,0.1); }
    h1 { color: #1a1a1a; margin-bottom: 10px; }
    .nav { display: flex; gap: 15px; margin-top: 15px; }
    .nav a { color: #0066cc; text-decoration: none; }
    .card { background: #fff; padding: 20px; border-radius: 8px; margin-bottom: 20px; box-shadow: 0 1px 3px rgba(0,0,0,0.1); }
    .btn { display: inline-block; padding: 10px 20px; background: #0066cc; color: #fff; border: none; border-radius: 6px; cursor: pointer; text-decoration: none; }
    .btn:hover { background: #0052a3; }
    .btn-danger { background: #dc3545; }
    .btn-danger:hover { background: #c82333; }
    .btn-success { background: #28a745; }
    .btn-success:hover { background: #218838; }
    table { width: 100%; border-collapse: collapse; }
    th, td { padding: 12px; text-align: left; border-bottom: 1px solid #eee; }
    th { background: #f8f9fa; font-weight: 600; }
    .status { display: inline-block; padding: 4px 8px; border-radius: 4px; font-size: 12px; }
    .status-pending { background: #fff3cd; color: #856404; }
    .status-deploying { background: #cce5ff; color: #004085; }
    .status-deployed { background: #d4edda; color: #155724; }
    .status-failed { background: #f8d7da; color: #721c24; }
    form { margin-bottom: 20px; }
    .form-group { margin-bottom: 15px; }
    label { display: block; margin-bottom: 5px; font-weight: 600; }
    input { width: 100%; padding: 10px; border: 1px solid #ddd; border-radius: 6px; }
    .user-info { display: flex; align-items: center; gap: 10px; }
    .avatar { width: 32px; height: 32px; border-radius: 50%; }
    .badge { padding: 2px 8px; border-radius: 10px; font-size: 11px; }
    .badge-owner { background: #ffc107; color: #000; }
    .badge-authorized { background: #28a745; color: #fff; }
    .badge-pending { background: #6c757d; color: #fff; }
  </style>
</head>
<body>
  <div class="container">
    <header>
      <h1>Railway Deployer</h1>
      <p>Deploy and manage your Railway apps with git branch/commit support</p>
      <div class="nav">
        <a href="/">Deployments</a>
        <a href="/settings">Settings</a>
        <a href="/auth/logout">Logout</a>
      </div>
    </header>
    
    <div class="card">
      <h2>Add New Deployment</h2>
      <form id="deployForm">
        <div class="form-group">
          <label>Name</label>
          <input type="text" name="name" required placeholder="my-app">
        </div>
        <div class="form-group">
          <label>Project ID</label>
          <input type="text" name="projectId" required placeholder="proj_xxx">
        </div>
        <div class="form-group">
          <label>Service ID</label>
          <input type="text" name="serviceId" required placeholder="svc_xxx">
        </div>
        <div class="form-group">
          <label>Environment ID (optional)</label>
          <input type="text" name="environmentId" placeholder="env_xxx">
        </div>
        <div class="form-group">
          <label>Git Branch (optional)</label>
          <input type="text" name="branch" placeholder="main">
        </div>
        <div class="form-group">
          <label>Repository (optional)</label>
          <input type="text" name="repo" placeholder="username/repo">
        </div>
        <button type="submit" class="btn">Deploy</button>
      </form>
    </div>
    
    <div class="card">
      <h2>Active Deployments</h2>
      <table id="deploymentsTable">
        <thead>
          <tr>
            <th>Name</th>
            <th>Branch</th>
            <th>Status</th>
            <th>Last Deployed</th>
            <th>Actions</th>
          </tr>
        </thead>
        <tbody id="deploymentsBody">
          <tr><td colspan="5">Loading...</td></tr>
        </tbody>
      </table>
    </div>
  </div>
  
  <script>
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
      
      if (data.length === 0) {
        tbody.innerHTML = '<tr><td colspan="5">No deployments yet</td></tr>';
        return;
      }
      
      tbody.innerHTML = data.map(d => \`
        <tr>
          <td>\${d.name}</td>
          <td>\${d.branch || 'main'}</td>
          <td><span class="status status-\${d.status}">\${d.status}</span></td>
          <td>\${d.lastDeployedAt ? new Date(d.lastDeployedAt).toLocaleString() : 'Never'}</td>
          <td>
            <button onclick="redeploy('\${d.id}')" class="btn btn-success">Redeploy</button>
            <button onclick="deleteDeployment('\${d.id}')" class="btn btn-danger">Delete</button>
          </td>
        </tr>
      \`).join('');
    }
    
    async function redeploy(id) {
      await fetch(\`/api/deployments/\${id}/redeploy\`, { method: 'POST' });
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
    
    document.getElementById('deployForm').addEventListener('submit', async (e) => {
      e.preventDefault();
      const form = e.target;
      const data = {
        name: form.name.value,
        projectId: form.projectId.value,
        serviceId: form.serviceId.value,
        environmentId: form.environmentId.value,
        branch: form.branch.value,
        repo: form.repo.value
      };
      
      const res = await fetch('/api/deployments', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(data)
      });
      
      if (res.ok) {
        form.reset();
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

const server = Bun.serve({
  port: PORT,
  fetch: handleRequest,
});

console.log(`Railway Deployer running at http://localhost:${PORT}`);
