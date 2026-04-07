import { pgTable, text, timestamp, boolean, uuid, varchar } from 'drizzle-orm/pg-core';

export const users = pgTable('users', {
  id: uuid('id').defaultRandom().primaryKey(),
  githubId: varchar('github_id', { length: 255 }).notNull().unique(),
  username: varchar('username', { length: 255 }).notNull(),
  email: varchar('email', { length: 255 }),
  avatarUrl: text('avatar_url'),
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
  branch: varchar('branch', { length: 255 }).default('main'),
  repo: varchar('repo', { length: 255 }),
  railwayToken: text('railway_token'),
  status: varchar('status', { length: 50 }).default('pending'),
  deploymentId: varchar('deployment_id', { length: 255 }),
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
