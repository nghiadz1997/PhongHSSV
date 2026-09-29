import { Injectable, UnauthorizedException, ForbiddenException, Logger } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model, Types } from 'mongoose';
import { AuthSession, AuthSessionDocument } from '../schemas/auth-session.schema';
import { ImpersonationSession, ImpersonationSessionDocument } from '../schemas/impersonation-session.schema';
import { LoginLog, LoginLogDocument } from '../schemas/login-log.schema';

@Injectable()
export class SessionService {
  private readonly logger = new Logger(SessionService.name);
  constructor(
    @InjectModel(AuthSession.name) private sessions: Model<AuthSessionDocument>,
    @InjectModel(ImpersonationSession.name) private leases: Model<ImpersonationSessionDocument>,
    @InjectModel(LoginLog.name) private logs: Model<LoginLogDocument>,
  ) {}

  async create(userId: Types.ObjectId, token: string, expiresAt: Date, remember: boolean,
    options: { id?: Types.ObjectId; parentId?: Types.ObjectId; leaseId?: Types.ObjectId; deviceLabel?: string } = {}) {
    return this.sessions.create({
      _id: options.id || new Types.ObjectId(), user_id: userId, current_token: token,
      expires_at: expiresAt, remember, parent_session_id: options.parentId || null,
      impersonation_session_id: options.leaseId || null,
      device_label: options.deviceLabel || 'Trình duyệt',
    });
  }

  async validate(id: string, userId?: string): Promise<AuthSessionDocument> {
    if (!Types.ObjectId.isValid(id)) throw new UnauthorizedException('Phiên làm việc đã kết thúc');
    const session = await this.sessions.findOne({ _id: id, revoked_at: null, expires_at: { $gt: new Date() },
      ...(userId ? { user_id: userId } : {}) });
    if (!session) throw new UnauthorizedException('Phiên làm việc đã kết thúc');
    if (session.parent_session_id) {
      // Parents must be ordinary sessions; never recurse through unbounded chains.
      const parent = await this.sessions.findOne({ _id: session.parent_session_id,
        revoked_at: null, parent_session_id: null, expires_at: { $gt: new Date() } });
      if (!parent) throw new UnauthorizedException('Phiên quản trị đã kết thúc');
    }
    return session;
  }

  async rotate(id: string, presentedToken: string, replacement: string) {
    const session = await this.validate(id);
    const now = new Date();
    if (session.retry_until && session.retry_until > now &&
      [session.current_token, session.previous_token].includes(presentedToken)) return session;
    if (session.current_token !== presentedToken) {
      await this.revoke(id, 'refresh_replay');
      throw new UnauthorizedException('Phiên làm việc đã kết thúc do token được sử dụng lại');
    }
    const expiresAt = session.remember && !session.parent_session_id
      ? new Date(Date.now() + 30 * 86400000) : session.expires_at;
    const rotated = await this.sessions.findOneAndUpdate({ _id: id, revoked_at: null,
      current_token: presentedToken, expires_at: { $gt: now } }, { $set: {
      current_token: replacement, previous_token: presentedToken,
      retry_until: new Date(Date.now() + 60000), expires_at: expiresAt, last_active_at: now,
    } }, { new: true });
    // A losing CAS reads the authoritative result, not an unfinished replacement record.
    if (!rotated) {
      const latest = await this.validate(id);
      if (latest.previous_token === presentedToken && latest.retry_until && latest.retry_until > new Date()) return latest;
      throw new UnauthorizedException('Phiên làm việc đã kết thúc');
    }
    return rotated;
  }

  async revoke(id: string, reason = 'session_revoked', actorId?: string) {
    if (!Types.ObjectId.isValid(id)) throw new UnauthorizedException('Phiên không hợp lệ');
    const now = new Date();
    const session = await this.sessions.findOne({ _id: id });
    if (!session || session.revoked_at) return;
    await this.sessions.updateMany({ $or: [{ _id: id }, { parent_session_id: id }], revoked_at: null },
      { $set: { revoked_at: now } });
    await this.leases.updateMany({ parent_session_id: id, status: 'active' },
      { $set: { status: 'ended', ended_at: now, ended_reason: 'parent_revoked' } });
    await this.logs.create({ user_id: session.user_id, action: 'session_revoked', login_time: now,
      ip_address: '0.0.0.0', details: JSON.stringify({ actorUserId: actorId || session.user_id.toString(),
        subjectUserId: session.user_id.toString(), sessionId: id, reason, childrenRevoked: true }) })
      .catch(() => this.logger.warn('Session revoked; audit persistence temporarily unavailable'));
  }

  async revokeUser(userId: string, exceptSessionId?: string) {
    const query: any = { user_id: userId, revoked_at: null };
    if (exceptSessionId && Types.ObjectId.isValid(exceptSessionId)) {
      query._id = { $ne: new Types.ObjectId(exceptSessionId) };
    }
    const families = await this.sessions.find(query).select('_id');
    for (const family of families) await this.revoke(family._id.toString(), 'account_security_event', userId);
  }

  async list(userId: string, currentId: string) {
    const rows = await this.sessions.find({ user_id: userId, parent_session_id: null,
      revoked_at: null, expires_at: { $gt: new Date() } })
      .select('_id device_label createdAt last_active_at').lean();
    return rows.map((row: any) => ({ id: row._id.toString(), device_label: row.device_label,
      created_at: row.createdAt, last_active_at: row.last_active_at, current: row._id.toString() === currentId }));
  }

  async revokeOwned(userId: string, id: string) {
    if (!Types.ObjectId.isValid(id)) throw new ForbiddenException('Phiên không thuộc tài khoản của bạn');
    const owned = await this.sessions.findOne({ _id: id, user_id: userId, parent_session_id: null });
    if (!owned) throw new ForbiddenException('Phiên không thuộc tài khoản của bạn');
    await this.revoke(id, 'owner_revoked', userId);
    return { revoked: true };
  }

  async revokeOthers(userId: string, currentId: string) {
    const rows = await this.list(userId, currentId);
    for (const row of rows) if (!row.current) await this.revoke(row.id, 'owner_revoked_others', userId);
    return { revoked: true };
  }
}
