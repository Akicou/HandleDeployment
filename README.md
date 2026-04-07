# Railway Deployer

A Bun-powered deployment tool for managing multiple Railway apps with git branch and commit version support.

## Features

- Deploy multiple apps to Railway via CLI or Web UI
- Specify git branch for deployment
- Redeploy/refresh existing deployments
- Change deployment branch without leaving the CLI
- GitHub OAuth authentication for web interface
- PostgreSQL database for tracking deployments
- Multi-user support with owner/authorization system

## Prerequisites

- [Bun](https://bun.sh/) runtime
- [PostgreSQL](https://postgresql.org/) database
- [GitHub OAuth App](https://docs.github.com/en/apps/oauth-apps/creating-an-oauth-app) credentials
- [Railway](https://railway.com/) account with API token

## Quick Start

### 1. Clone and Install

```bash
git clone https://github.com/yourusername/railway-deployer.git
cd railway-deployer
bun install
```

### 2. Configure Environment

Create a `.env` file:

```bash
# Database
DATABASE_URL=postgres://postgres:password@localhost:5432/railway_deployer

# GitHub OAuth (create at https://github.com/settings/developers)
GITHUB_CLIENT_ID=your_github_client_id
GITHUB_CLIENT_SECRET=your_github_client_secret
GITHUB_CALLBACK_URL=http://localhost:3000/auth/callback

# App Settings
APP_BASE_URL=http://localhost:3000
PORT=3000
SESSION_SECRET=your-secure-secret
```

### 3. Set Up Database

```bash
# Create the database
createdb railway_deployer

# Run migrations (schema is auto-created on startup)
bun run src/db/migrate.ts
```

### 4. Start the Server

```bash
bun run start
```

Visit `http://localhost:3000` and log in with GitHub. The first user becomes the **owner** and is automatically authorized. Other users need authorization from the owner.

## CLI Usage

### Deploy a Service

```bash
# Deploy with default settings
railway-deploy deploy --project proj_xxx --service svc_xxx

# Deploy specific branch
railway-deploy deploy --project proj_xxx --service svc_xxx --branch develop

# Deploy with Railway token
railway-deploy deploy --project proj_xxx --service svc_xxx --token rly_xxx
```

### Redeploy

```bash
railway-deploy redeploy --service svc_xxx
```

### Change Branch

```bash
railway-deploy set-branch --service svc_xxx --repo username/repo --branch main
```

### Environment Variables

You can also use environment variables:

```bash
export RAILWAY_TOKEN=your_railway_token
railway-deploy deploy --project proj_xxx --service svc_xxx
```

## API Reference

### Authentication

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/auth/login` | GET | Redirect to GitHub OAuth |
| `/auth/callback` | GET | OAuth callback handler |
| `/auth/logout` | GET | Logout and clear session |

### User

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/api/user` | GET | Get current user info |

### Deployments

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/api/deployments` | GET | List all deployments |
| `/api/deployments` | POST | Create new deployment |
| `/api/deployments` | DELETE | Delete deployment |
| `/api/deployments/:id/redeploy` | POST | Redeploy a service |

### Tokens

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/api/tokens` | GET | List Railway tokens |
| `/api/tokens` | POST | Add Railway token |

### Authorization (Owner only)

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/api/authorize` | POST | Authorize a user |

## Database Schema

### Users Table

| Column | Type | Description |
|--------|------|-------------|
| id | UUID | Primary key |
| github_id | VARCHAR | GitHub user ID |
| username | VARCHAR | GitHub username |
| email | VARCHAR | User email |
| avatar_url | TEXT | Profile image |
| is_owner | BOOLEAN | First user is owner |
| is_authorized | BOOLEAN | Can access deployment features |
| created_at | TIMESTAMP | Creation time |

### Deployments Table

| Column | Type | Description |
|--------|------|-------------|
| id | UUID | Primary key |
| user_id | UUID | Owner user |
| name | VARCHAR | Deployment name |
| project_id | VARCHAR | Railway project ID |
| service_id | VARCHAR | Railway service ID |
| environment_id | VARCHAR | Railway environment |
| branch | VARCHAR | Git branch |
| repo | VARCHAR | GitHub repository |
| status | VARCHAR | pending/deploying/deployed/failed |
| deployment_id | VARCHAR | Railway deployment ID |
| last_deployed_at | TIMESTAMP | Last deploy time |

## Railway API Integration

This tool uses Railway's GraphQL API:

- **Endpoint**: `https://backboard.railway.com/graphql/v2`
- **Authentication**: Bearer token
- **Key Mutations**:
  - `serviceConnect` - Connect/change branch
  - `serviceInstanceDeployV2` - Trigger deployment
  - `serviceInstanceRedeploy` - Redeploy latest

For full API documentation, see [Railway API Docs](https://docs.railway.com/integrations/api).

## Security Notes

- Keep `SESSION_SECRET` secure in production
- Use strong PostgreSQL passwords
- GitHub OAuth secrets should be environment variables
- First user automatically becomes owner - be careful who logs in first!

## License

MIT
