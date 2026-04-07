import { pgTable, text, timestamp, boolean, uuid, varchar } from 'drizzle-orm/pg-core';

export const users = pgTable('users', {
  id: uuid('id').defaultRandom().primaryKey(),
  githubId: varchar('github_id', { length: 255 }).notNull().unique(),
  username: varchar('username', { length: 255 }).notNull(),
  email: varchar('email', { length: 255 }),
  avatarUrl: text('avatar_url'),
  githubAccessToken: text('github_access_token'),
  isOwner: boolean('is_owner').default(false),
  isAuthorized: boolean('is_authorized').default(false),
  createdAt: timestamp('created_at').defaultNow().notNull(),
  updatedAt: timestamp('updated_at').defaultNow().notNull(),
});

export const deployments = pgTable('deployments', {
  id: uuid('id').defaultRandom().primaryKey(),
  userId: uuid('user_id').notNull().references(() => users.id),
  name: varchar('name', { length: 255 }).notNull(),
  projectId: varchar('project_id', { length: 255 }).notNull(),
  serviceId: varchar('service_id', { length: 255 }).notNull(),
  environmentId: varchar('environment_id', { length: 255 }),
  releaseTag: varchar('release_tag', { length: 255 }),
  repo: varchar('repo', { length: 255 }),
  railwayToken: text('railway_token'),
  status: varchar('status', { length: 50 }).default('pending'),
  autoDeploy: boolean('auto_deploy').default(false),
  deploymentId: varchar('deployment_id', { length: 255 }),
  customDomain: varchar('custom_domain', { length: 255 }),
  rootDirectory: varchar('root_directory', { length: 512 }).default('/'),
  trackedReleaseTag: varchar('tracked_release_tag', { length: 255 }),
  lastObservedReleaseTag: varchar('last_observed_release_tag', { length: 255 }),
  lastDeployedAt: timestamp('last_deployed_at'),
  createdAt: timestamp('created_at').defaultNow().notNull(),
  updatedAt: timestamp('updated_at').defaultNow().notNull(),
});

export const railwayTokens = pgTable('railway_tokens', {
  id: uuid('id').defaultRandom().primaryKey(),
  userId: uuid('user_id').notNull().references(() => users.id),
  projectId: varchar('project_id', { length: 255 }),
  token: text('token').notNull(),
  isDefault: boolean('is_default').default(false),
  createdAt: timestamp('created_at').defaultNow().notNull(),
});

export type User = typeof users.$inferSelect;
export type NewUser = typeof users.$inferInsert;
export type Deployment = typeof deployments.$inferSelect;
export type NewDeployment = typeof deployments.$inferInsert;
export type RailwayToken = typeof railwayTokens.$inferSelect;
export type NewRailwayToken = typeof railwayTokens.$inferInsert;
