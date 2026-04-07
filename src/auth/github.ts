import { db, schema } from '../db';
import { eq } from 'drizzle-orm';
import type { User } from '../db/schema';

const GITHUB_CLIENT_ID = process.env.GITHUB_CLIENT_ID || '';
const GITHUB_CLIENT_SECRET = process.env.GITHUB_CLIENT_SECRET || '';
const GITHUB_CALLBACK_URL = process.env.GITHUB_CALLBACK_URL || 'http://localhost:3000/auth/callback';

export interface GitHubUser {
  id: number;
  login: string;
  email?: string | null;
  avatar_url?: string;
}

export interface GitHubEmail {
  email: string;
  primary: boolean;
}

export interface GitHubRelease {
  tag_name: string;
  name: string | null;
  published_at: string | null;
  draft: boolean;
  prerelease: boolean;
}

export interface GitHubRepo {
  id: number;
  name: string;
  full_name: string;
  private: boolean;
  owner: { login: string };
  description: string | null;
  default_branch: string;
}

interface GitHubTokenResponse {
  access_token?: string;
  error?: string;
  error_description?: string;
}

export function getGitHubAuthUrl(state: string): string {
  const params = new URLSearchParams({
    client_id: GITHUB_CLIENT_ID,
    redirect_uri: GITHUB_CALLBACK_URL,
    scope: 'read:user user:email repo',
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

  const data = await response.json() as GitHubTokenResponse;
  if (data.error || !data.access_token) {
    throw new Error(data.error_description || 'Missing GitHub access token');
  }
  return data.access_token;
}

export async function getGitHubUser(accessToken: string): Promise<GitHubUser> {
  const response = await fetch('https://api.github.com/user', {
    headers: {
      Authorization: `Bearer ${accessToken}`,
      Accept: 'application/json',
    },
  });

  if (!response.ok) {
    throw new Error('Failed to fetch GitHub user');
  }

  return await response.json() as GitHubUser;
}

export async function getGitHubUserEmails(accessToken: string): Promise<GitHubEmail[]> {
  const response = await fetch('https://api.github.com/user/emails', {
    headers: {
      Authorization: `Bearer ${accessToken}`,
      Accept: 'application/json',
    },
  });

  if (!response.ok) {
    return [];
  }

  return await response.json() as GitHubEmail[];
}

export async function findOrCreateUser(accessToken: string): Promise<User> {
  const githubUser = await getGitHubUser(accessToken);

  let email = githubUser.email ?? null;
  if (!email) {
    const emails = await getGitHubUserEmails(accessToken);
    const primaryEmail = emails.find((candidate) => candidate.primary);
    email = primaryEmail?.email || emails[0]?.email || null;
  }

  const existingUser = await db
    .select()
    .from(schema.users)
    .where(eq(schema.users.githubId, String(githubUser.id)))
    .then((res) => res[0]);

  if (existingUser) {
    await db
      .update(schema.users)
      .set({
        username: githubUser.login,
        email,
        avatarUrl: githubUser.avatar_url,
        githubAccessToken: accessToken,
        updatedAt: new Date(),
      })
      .where(eq(schema.users.id, existingUser.id));

    return {
      ...existingUser,
      username: githubUser.login,
      email: email ?? null,
      avatarUrl: githubUser.avatar_url ?? null,
      githubAccessToken: accessToken,
    };
  }

  const isFirstUser = await db.select().from(schema.users).then((res) => res.length) === 0;

  const [newUser] = await db
    .insert(schema.users)
    .values({
      githubId: String(githubUser.id),
      username: githubUser.login,
      email,
      avatarUrl: githubUser.avatar_url,
      githubAccessToken: accessToken,
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

export function isStableRelease(release: GitHubRelease): boolean {
  return !release.draft && !release.prerelease;
}

export function sortReleasesNewestFirst(releases: GitHubRelease[]): GitHubRelease[] {
  return [...releases].sort((left, right) => {
    const leftTime = left.published_at ? Date.parse(left.published_at) : 0;
    const rightTime = right.published_at ? Date.parse(right.published_at) : 0;
    return rightTime - leftTime;
  });
}

export function getLatestStableRelease(releases: GitHubRelease[]): GitHubRelease | null {
  return sortReleasesNewestFirst(releases).find(isStableRelease) || null;
}

export async function getGitHubReleases(accessToken: string, repo: string): Promise<GitHubRelease[]> {
  const response = await fetch(`https://api.github.com/repos/${repo}/releases`, {
    headers: {
      Authorization: `Bearer ${accessToken}`,
      Accept: 'application/vnd.github+json',
    },
  });

  if (!response.ok) {
    throw new Error(`Failed to fetch releases for ${repo}: ${response.status}`);
  }

  return await response.json() as GitHubRelease[];
}

export async function getGitHubRepo(accessToken: string, repo: string): Promise<GitHubRepo> {
  const response = await fetch(`https://api.github.com/repos/${repo}`, {
    headers: {
      Authorization: `Bearer ${accessToken}`,
      Accept: 'application/vnd.github+json',
    },
  });

  if (!response.ok) {
    throw new Error(`Failed to fetch repository ${repo}: ${response.status}`);
  }

  return await response.json() as GitHubRepo;
}

export async function getGitHubRepos(accessToken: string): Promise<GitHubRepo[]> {
  const response = await fetch('https://api.github.com/user/repos?sort=updated&per_page=100', {
    headers: {
      Authorization: `Bearer ${accessToken}`,
      Accept: 'application/vnd.github+json',
    },
  });

  if (!response.ok) {
    throw new Error(`Failed to fetch repositories: ${response.status}`);
  }

  return await response.json() as GitHubRepo[];
}

export async function getGitHubUserByUsername(accessToken: string, username: string): Promise<GitHubUser | null> {
  const response = await fetch(`https://api.github.com/users/${username}`, {
    headers: {
      Authorization: `Bearer ${accessToken}`,
      Accept: 'application/vnd.github+json',
    },
  });

  if (!response.ok) {
    return null;
  }

  return await response.json() as GitHubUser;
}
