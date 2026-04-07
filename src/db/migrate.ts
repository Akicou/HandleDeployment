import { db } from './index';
import { sql } from 'drizzle-orm';

export async function runMigrations(): Promise<void> {
  console.log('Running migrations...');

  await db.execute(sql`
    CREATE TABLE IF NOT EXISTS users (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      github_id VARCHAR(255) NOT NULL UNIQUE,
      username VARCHAR(255) NOT NULL,
      email VARCHAR(255),
      avatar_url TEXT,
      github_access_token TEXT,
      is_owner BOOLEAN DEFAULT false,
      is_authorized BOOLEAN DEFAULT false,
      created_at TIMESTAMP DEFAULT NOW() NOT NULL,
      updated_at TIMESTAMP DEFAULT NOW() NOT NULL
    );
  `);

  await db.execute(sql`
    CREATE TABLE IF NOT EXISTS deployments (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      user_id UUID NOT NULL REFERENCES users(id),
      name VARCHAR(255) NOT NULL,
      project_id VARCHAR(255) NOT NULL,
      service_id VARCHAR(255) NOT NULL,
      environment_id VARCHAR(255),
      release_tag VARCHAR(255),
      repo VARCHAR(255),
      railway_token TEXT,
      status VARCHAR(50) DEFAULT 'pending',
      auto_deploy BOOLEAN DEFAULT false,
      deployment_id VARCHAR(255),
      custom_domain VARCHAR(255),
      root_directory VARCHAR(512) DEFAULT '/',
      tracked_release_tag VARCHAR(255),
      last_observed_release_tag VARCHAR(255),
      last_deployed_at TIMESTAMP,
      created_at TIMESTAMP DEFAULT NOW() NOT NULL,
      updated_at TIMESTAMP DEFAULT NOW() NOT NULL
    );
  `);

  await db.execute(sql`
    CREATE TABLE IF NOT EXISTS railway_tokens (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      user_id UUID NOT NULL REFERENCES users(id),
      project_id VARCHAR(255),
      token TEXT NOT NULL,
      is_default BOOLEAN DEFAULT false,
      created_at TIMESTAMP DEFAULT NOW() NOT NULL
    );
  `);

  // Add release_tag column to existing databases that have the old branch column
  await db.execute(sql`
    ALTER TABLE deployments ADD COLUMN IF NOT EXISTS release_tag VARCHAR(255);
  `);

  await db.execute(sql`
    ALTER TABLE users ADD COLUMN IF NOT EXISTS github_access_token TEXT;
  `);

  await db.execute(sql`
    ALTER TABLE deployments ADD COLUMN IF NOT EXISTS auto_deploy BOOLEAN DEFAULT false;
  `);

  await db.execute(sql`
    ALTER TABLE deployments ADD COLUMN IF NOT EXISTS custom_domain VARCHAR(255);
  `);

  await db.execute(sql`
    ALTER TABLE deployments ADD COLUMN IF NOT EXISTS root_directory VARCHAR(512) DEFAULT '/';
  `);

  await db.execute(sql`
    ALTER TABLE deployments ADD COLUMN IF NOT EXISTS tracked_release_tag VARCHAR(255);
  `);

  await db.execute(sql`
    ALTER TABLE deployments ADD COLUMN IF NOT EXISTS last_observed_release_tag VARCHAR(255);
  `);

  console.log('Migrations complete!');
}

async function migrate() {
  try {
    await runMigrations();
  } catch (error) {
    console.error('Migration failed:', error);
    process.exit(1);
  }
  process.exit(0);
}

// Only run when this file is the entry point, not when imported as a module
if (import.meta.main) {
  migrate();
}
