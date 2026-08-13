import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import crypto from 'crypto';
import type { RuntimeConfig } from '../config.js';
import type { Permission } from './permissions.js';
import { resolveUserPermissions } from './permissions.js';
import { UserStore, type UserRecord } from './UserStore.js';
import type { RoleStore } from './RoleStore.js';

export interface AuthUser {
  id: number;
  username: string;
  role: string;
  permissionGrants: string[];
  permissionDenies: string[];
}

export interface TokenPair {
  accessToken: string;
  refreshToken: string;
  expiresIn: number;
}

export interface AuthPayload {
  sub: number;
  username: string;
  role: string;
  type: 'access' | 'refresh';
}

export class AuthService {
  constructor(
    private readonly config: RuntimeConfig,
    private readonly userStore: UserStore,
    private readonly roleStore: RoleStore
  ) {}

  hasUsers(): boolean {
    return this.userStore.countUsers() > 0;
  }

  async createOwner(username: string, password: string): Promise<AuthUser> {
    if (this.hasUsers()) {
      throw new Error('Setup already completed');
    }
    const hash = await bcrypt.hash(password, 12);
    const user = this.userStore.createUser(username, hash, 'owner');
    return this.toAuthUser(user);
  }

  async login(username: string, password: string): Promise<{ user: AuthUser; permissions: Permission[]; tokens: TokenPair }> {
    const user = this.userStore.findByUsername(username);
    if (!user) throw new Error('Invalid credentials');
    const ok = await bcrypt.compare(password, user.passwordHash);
    if (!ok) throw new Error('Invalid credentials');

    const authUser = this.toAuthUser(user);
    const permissions = [...this.getPermissions(authUser)];
    const tokens = this.issueTokens(authUser);
    this.userStore.storeRefreshToken(user.id, tokens.refreshToken, this.config.refreshTokenDays);
    return { user: authUser, permissions, tokens };
  }

  refresh(refreshToken: string): { accessToken: string; expiresIn: number; user: AuthUser; permissions: Permission[] } {
    let payload: AuthPayload;
    try {
      payload = jwt.verify(refreshToken, this.config.jwtSecret) as unknown as AuthPayload;
    } catch {
      throw new Error('Invalid refresh token');
    }
    if (payload.type !== 'refresh') throw new Error('Invalid refresh token');

    const tokenHash = this.hashToken(refreshToken);
    const stored = this.userStore.findRefreshToken(tokenHash);
    if (!stored || stored.userId !== payload.sub) throw new Error('Refresh token revoked');

    const user = this.userStore.findById(payload.sub);
    if (!user) throw new Error('User not found');

    const authUser = this.toAuthUser(user);
    const accessToken = this.signAccess(authUser);
    return {
      accessToken,
      expiresIn: this.config.accessTokenMinutes * 60,
      user: authUser,
      permissions: [...this.getPermissions(authUser)],
    };
  }

  logout(refreshToken: string): void {
    this.userStore.revokeRefreshToken(this.hashToken(refreshToken));
  }

  verifyAccessToken(token: string): AuthUser {
    let payload: AuthPayload;
    try {
      payload = jwt.verify(token, this.config.jwtSecret) as unknown as AuthPayload;
    } catch {
      throw new Error('Invalid or expired token');
    }
    if (payload.type !== 'access') throw new Error('Invalid token type');

    const user = this.userStore.findById(payload.sub);
    if (!user) throw new Error('User not found');
    return this.toAuthUser(user);
  }

  getPermissions(user: AuthUser): Set<Permission> {
    const rolePerms = this.roleStore.getPermissionsForSlug(user.role);
    return resolveUserPermissions(rolePerms, user.permissionGrants, user.permissionDenies);
  }

  issueTokens(user: AuthUser): TokenPair {
    const accessToken = this.signAccess(user);
    const refreshToken = jwt.sign(
      { sub: user.id, username: user.username, role: user.role, type: 'refresh' } satisfies AuthPayload,
      this.config.jwtSecret,
      { expiresIn: `${this.config.refreshTokenDays}d` }
    );
    return {
      accessToken,
      refreshToken,
      expiresIn: this.config.accessTokenMinutes * 60,
    };
  }

  private signAccess(user: AuthUser): string {
    return jwt.sign(
      { sub: user.id, username: user.username, role: user.role, type: 'access' } satisfies AuthPayload,
      this.config.jwtSecret,
      { expiresIn: `${this.config.accessTokenMinutes}m` }
    );
  }

  private hashToken(token: string): string {
    return crypto.createHash('sha256').update(token).digest('hex');
  }

  private toAuthUser(user: UserRecord): AuthUser {
    return {
      id: user.id,
      username: user.username,
      role: user.role,
      permissionGrants: user.permissionGrants,
      permissionDenies: user.permissionDenies,
    };
  }
}
