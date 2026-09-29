import { Injectable, UnauthorizedException, ServiceUnavailableException } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model, Types } from 'mongoose';
import { JwtService } from '@nestjs/jwt';
import { v4 as uuidv4 } from 'uuid';
import { RefreshToken, RefreshTokenDocument } from '../schemas/refresh-token.schema';
import { User, UserDocument } from '../schemas/user.schema';
import { ImpersonationService } from './impersonation.service';
import { SessionService } from './session.service';

@Injectable()
export class TokenService {
  constructor(
    @InjectModel(RefreshToken.name) private refreshTokenModel: Model<RefreshTokenDocument>,
    @InjectModel(User.name) private userModel: Model<UserDocument>,
    private jwtService: JwtService,
    private impersonationService: ImpersonationService,
    private sessionService: SessionService,
  ) {}

  async createRefreshToken(userId: Types.ObjectId, expirationDays: number, remember = false,
    impersonation?: { sessionId: Types.ObjectId; actorUserId: Types.ObjectId; expiresAt: Date; parentSessionId?: Types.ObjectId },
    sessionId = new Types.ObjectId(), deviceLabel?: string) {
    const token = uuidv4();
    const expiresAt = impersonation?.expiresAt || new Date(Date.now() + expirationDays * 86400000);
    await this.sessionService.create(userId, token, expiresAt, remember, {
      id: sessionId, parentId: impersonation?.parentSessionId, leaseId: impersonation?.sessionId, deviceLabel,
    });
    try {
      await this.refreshTokenModel.create({ user_id: userId, token, expires_at: expiresAt, remember,
        session_id: sessionId, impersonation_session_id: impersonation?.sessionId || null,
        actor_user_id: impersonation?.actorUserId || null });
    } catch (error) {
      await this.sessionService.revoke(sessionId.toString());
      throw error;
    }
    return token;
  }

  async refreshToken(token: string) {
    const stored = await this.refreshTokenModel.findOne({ token });
    if (!stored) throw new UnauthorizedException('Phiên làm việc không tồn tại');
    const user = await this.userModel.findById(stored.user_id).exec();
    if (!user || user.status !== 'active') throw new UnauthorizedException('Tài khoản đã bị khóa hoặc chưa kích hoạt');
    let sessionId = stored.session_id;
    if (!sessionId) {
      // Existing refresh credentials can upgrade; bare legacy JWTs cannot create sessions.
      if (stored.is_revoked || new Date(stored.expires_at) <= new Date() || stored.impersonation_session_id) {
        throw new UnauthorizedException('Vui lòng đăng nhập lại');
      }
      sessionId = new Types.ObjectId(stored._id.toString());
      try {
        await this.sessionService.create(stored.user_id, token, stored.expires_at, stored.remember, { id: sessionId });
      } catch (error: any) {
        if (error?.code !== 11000) throw error;
      }
      const linked = await this.refreshTokenModel.findOneAndUpdate({ _id: stored._id, is_revoked: false },
        { $set: { session_id: sessionId } }, { new: true });
      if (!linked) {
        await this.sessionService.revoke(sessionId.toString());
        throw new UnauthorizedException('Phiên làm việc đã kết thúc');
      }
    }
    const family = await this.sessionService.validate(sessionId.toString(), user._id.toString());
    if (stored.impersonation_session_id) {
      await this.impersonationService.validateSession(stored.impersonation_session_id.toString(),
        stored.user_id.toString(), stored.actor_user_id?.toString());
    }
    // Persist the candidate locator first. Only the atomic family CAS can authorize it.
    // Failed/unclaimed candidates cannot be used to authenticate or revive a family.
    const replacement = uuidv4();
    {
      try {
        await this.refreshTokenModel.create({ user_id: stored.user_id, token: replacement,
          expires_at: family.expires_at, remember: family.remember, session_id: sessionId,
          impersonation_session_id: stored.impersonation_session_id || null, actor_user_id: stored.actor_user_id || null });
      } catch {
        throw new ServiceUnavailableException('Tạm thời chưa thể gia hạn phiên, vui lòng thử lại');
      }
    }
    const rotated = await this.sessionService.rotate(sessionId.toString(), token, replacement);
    await this.sessionService.validate(sessionId.toString(), user._id.toString());
    const payload: any = { user_id: stored.user_id.toString(), session_id: sessionId.toString() };
    if (stored.impersonation_session_id) {
      payload.actor_user_id = stored.actor_user_id?.toString();
      payload.impersonation_session_id = stored.impersonation_session_id.toString();
    }
    return { access_token: this.jwtService.sign(payload), refresh_token: rotated.current_token,
      expires_at: rotated.expires_at, remember: rotated.remember };
  }

  async revokeAllUserTokens(userId: string, exceptSessionId?: string) {
    // Revoke legacy credentials before upgrading callers can use them.
    const query: any = { user_id: new Types.ObjectId(userId) };
    if (exceptSessionId && Types.ObjectId.isValid(exceptSessionId)) {
      query.session_id = { $ne: new Types.ObjectId(exceptSessionId) };
    }
    await this.refreshTokenModel.updateMany(query, { $set: { is_revoked: true } });
    await this.sessionService.revokeUser(userId, exceptSessionId);
  }

  async revokeToken(token: string) {
    const stored = await this.refreshTokenModel.findOne({ token });
    await this.refreshTokenModel.updateOne({ token }, { $set: { is_revoked: true } });
    if (stored) await this.sessionService.revoke((stored.session_id || stored._id).toString());
  }

  async revokeAllImpersonationTokens(sessionId: string) {
    if (!Types.ObjectId.isValid(sessionId)) return;
    const tokens = await this.refreshTokenModel.find({ impersonation_session_id: new Types.ObjectId(sessionId) }).select('session_id');
    for (const id of new Set(tokens.map(t => t.session_id?.toString()).filter(Boolean))) {
      await this.sessionService.revoke(id!);
    }
    await this.refreshTokenModel.updateMany({ impersonation_session_id: new Types.ObjectId(sessionId) }, { $set: { is_revoked: true } });
  }

  async findToken(token: string) { return this.refreshTokenModel.findOne({ token }); }
  generateAccessToken(payload: any) { return this.jwtService.sign(payload); }
}
