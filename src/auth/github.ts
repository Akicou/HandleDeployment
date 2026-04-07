import { db, schema } from '../db';
import { eq } from 'drizzle-orm';
import type { User } from '../db/schema';

const GITHUB_CLIENT_ID = process.env.GITHUB_CLIENT_ID || '';
const GITHUB_CLIENT_SECRET = process.env.GITHUB_CLIENT_SECRET || '';
const GITHUB_CALLBACK_URL = process.env.GITHUB_CALLBACK_URL || 'http://localhost:3000/auth/callback';

export function getGitHubAuthUrl(state: string): string {
  const params = new URLSearchParams({
    client_id: GITHUB_CLIENT_ID,
    redirect_uri: GITHUB_CALLBACK_URL,
    scope: 'read:user user:email',
    state,
  });
  return `https://github.com/login/oauth/authorize?${params.toString()}`;
}

export async function exchangeCodeForToken(code: string): Promise<string> {
  const response = await fetch('https://github.com/login/oauth/access_token', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Accept: 'application/json',
    },
    body: JSON.stringify({
      client_id: GITHUB_CLIENT_ID,
      client_secret: GITHUB_CLIENT_SECRET,
      code,
    }),
  });

  const data = await response.json();
  if (data.error) {
    throw new Error(data.error_description);
  }
  return data.access_token;
}

export async function getGitHubUser(accessToken: string): Promise<{
  id: number;
  login: string;
  email?: string;
  avatar_url?: string;
}> {
  const response = await fetch('https://api.github.com/user', {
    headers: {
      Authorization: `Bearer ${accessToken}`,
      Accept: 'application/json',
    },
  });

  if (!response.ok) {
    throw new Error('Failed to fetch GitHub user');
  }

  return response.json();
}

export async function getGitHubUserEmails(accessToken: string): Promise<Array<{ email: string; primary: boolean }>> {
  const response = await fetch('https://api.github.com/user/emails', {
    headers: {
      Authorization: `Bearer ${accessToken}`,
      Accept: 'application/json',
    },
  });

  if (!response.ok) {
    return [];
  }

  return response.json();
}

export async function findOrCreateUser(accessToken: string): Promise<User> {
  const githubUser = await getGitHubUser(accessToken);
  
  let email = githubUser.email;
  if (!email) {
    const emails = await getGitHubUserEmails(accessToken);
    const primaryEmail = emails.find(e => e.primary);
    email = primaryEmail?.email || emails[0]?.email;
  }

  const existingUser = await db
    .select()
    .from(schema.users)
    .where(eq(schema.users.githubId, String(githubUser.id)))
    .then(res => res[0]);

  if (existingUser) {
    await db
      .update(schema.users)
      .set({
        username: githubUser.login,
        email,
        avatarUrl: githubUser.avatar_url,
        updatedAt: new Date(),
      })
      .where(eq(schema.users.id, existingUser.id));
    
    return { ...existingUser, username: githubUser.login, email, avatarUrl: githubUser.avatar_url };
  }

  const isFirstUser = await db.select().from(schema.users).then(res => res.length) === 0;
  
  const [newUser] = await db
    .insert(schema.users)
    .values({
      githubId: String(githubUser.id),
      username: githubUser.login,
      email,
      avatarUrl: githubUser.avatar_url,
      isOwner: isFirstUser,
      isAuthorized: isFirstUser,
    })
    .returning();

  return newUser;
}

export function generateState(): string {
  return Math.random().toString(36).substring(2, 15);
}

export function isUserAuthorized(user: User): boolean {
  return user.isAuthorized || user.isOwner || false;
}

export async function getGitHubReleases(
  accessToken: string,
  repo: string
): Promise<Array<{ tag_name: string; name: string; published_at: string }>> {
  const response = await fetch(`https://api.github.com/repos/${repo}/releases`, {
    headers: {
      Authorization: `Bearer ${accessToken}`,
      Accept: 'application/vnd.github+json',
    },
  });

  if (!response.ok) {
    throw new Error(`Failed to fetch releases for ${repo}: ${response.status}`);
  }

  return response.json();
}
