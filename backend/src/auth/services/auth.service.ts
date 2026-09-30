import {
  Injectable,
  UnauthorizedException,
  ConflictException,
  ForbiddenException,
  OnModuleInit,
  BadRequestException,
  Logger,
  Optional,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectModel } from '@nestjs/mongoose';
import { Model, Types } from 'mongoose';
import { performance } from 'node:perf_hooks';
import { User, UserDocument, UserStatus } from '../schemas/user.schema';
import { Student } from '../../students/schemas/student.schema';
import { Class } from '../../classes/schemas/class.schema';
import { LoginLog, LoginLogDocument } from '../schemas/login-log.schema';
import { Role, RoleDocument } from '../schemas/role.schema';
import { Permission, PermissionDocument } from '../schemas/permission.schema';
import {
  PermissionGroup,
  PermissionGroupDocument,
} from '../schemas/permission-group.schema';
import {
  RoutePermission,
  RoutePermissionDocument,
} from '../schemas/route-permission.schema';
import {
  RegisterDto,
  LoginDto,
  ForgotPasswordDto,
  ResetPasswordDto,
  ChangePasswordDto,
  AssignRoleDto,
  UpdateUserDto,
  UpdateMeDto,
  PasswordResetRequestDto,
  PasswordResetResendDto,
  PasswordResetVerifyDto,
  PasswordResetCompleteDto,
} from '../dto/auth.dto';
import { TokenService } from './token.service';
import { PasswordService } from './password.service';
import { RbacService } from './rbac.service';
import {
  DECLARED_PERMISSION_SEEDS,
  UNGROUPED_PERMISSION_GROUP,
  ADMIN_RBAC_GROUP,
  STUDENT_MANAGER_GROUP,
  STUDENT_RECORD_GROUP,
  GRADING_MANAGER_GROUP,
  TASK_MANAGER_GROUP,
  SYSTEM_OPERATIONS_GROUP,
  REPORT_MANAGER_GROUP,
  ACTIVITY_MANAGER_GROUP,
  DORMITORY_MANAGER_GROUP,
  PROPOSED_PERMISSION_GROUP,
  TIMETABLE_MANAGER_GROUP,
} from '../permissions.registry';
import { maskLoginKey } from '../utils/mask.util';
import { ImpersonationService } from './impersonation.service';
import { getAssignedRoles, getEffectivePermissions } from '../utils/role.util';

const MAX_LOGIN_ATTEMPTS = 5;
const LOCK_DURATION_MINUTES = 15;
const INVALID_LOGIN_MESSAGE = 'Tài khoản hoặc mật khẩu không chính xác.';

@Injectable()
export class AuthService implements OnModuleInit {
  private readonly logger = new Logger(AuthService.name);

  constructor(
    @InjectModel(User.name) private userModel: Model<UserDocument>,
    @InjectModel(LoginLog.name) private loginLogModel: Model<LoginLogDocument>,
    @InjectModel(Role.name) private roleModel: Model<RoleDocument>,
    @InjectModel(Permission.name)
    private permissionModel: Model<PermissionDocument>,
    @InjectModel(PermissionGroup.name)
    private permissionGroupModel: Model<PermissionGroupDocument>,
    @InjectModel(RoutePermission.name)
    private routePermissionModel: Model<RoutePermissionDocument>,
    @InjectModel(Student.name) private studentModel: Model<any>,
    @InjectModel(Class.name) private classModel: Model<any>,
    private tokenService: TokenService,
    private passwordService: PasswordService,
    private rbacService: RbacService,
    private impersonationService: ImpersonationService,
    @Optional() private configService?: ConfigService,
  ) {}

  async onModuleInit() {
    const startupStartedAt = performance.now();
    const runStartupStep = async (
      name: string,
      step: () => Promise<void>,
    ): Promise<void> => {
      const stepStartedAt = performance.now();
      await step();
      this.logger.log(
        `[startup] ${name} completed in ${Math.round(performance.now() - stepStartedAt)}ms`,
      );
    };

    await runStartupStep('migrateLegacyRoleCodes', () =>
      this.migrateLegacyRoleCodes(),
    );
    await runStartupStep('seedDeclaredPermissions', () =>
      this.seedDeclaredPermissions(),
    );
    await runStartupStep('seedRbac', () => this.seedRbac());
    await runStartupStep('seedSystemAdmin', () => this.seedSystemAdmin());
    await Promise.all([
      runStartupStep('migrateLegacyRoles', () => this.migrateLegacyRoles()),
      runStartupStep('migrateLegacyUserFields', () =>
        this.migrateLegacyUserFields(),
      ),
    ]);
    await runStartupStep('deduplicateRbacReferences', () =>
      this.deduplicateRbacReferences(),
    );
    this.logger.log(
      `[startup] auth initialization completed in ${Math.round(performance.now() - startupStartedAt)}ms`,
    );
  }

  private async safeSave(doc: any) {
    try {
      await doc.save();
    } catch (e: any) {
      if (e.name === 'DocumentNotFoundError' || e.name === 'VersionError') {
        const updateData: any = {};
        if (doc.modifiedPaths && typeof doc.modifiedPaths === 'function') {
          for (const path of doc.modifiedPaths()) {
            updateData[path] = doc.get(path);
          }
          if (Object.keys(updateData).length > 0) {
            await doc.constructor.updateOne(
              { _id: doc._id },
              { $set: updateData },
            );
          }
        }
      } else {
        throw e;
      }
    }
  }

  // ─── AUTHENTICATION ─────────────────────────────────────────

  async register(dto: RegisterDto) {
    const existingUsername = await this.userModel.findOne({
      user_name: dto.user_name,
    });
    if (existingUsername) throw new ConflictException('Username đã tồn tại');

    const existingEmail = await this.userModel.findOne({
      email: dto.email.toLowerCase(),
    });
    if (existingEmail) throw new ConflictException('Email đã được sử dụng');

    const pw_hash = await this.passwordService.hashPassword(dto.password);
    const defaultRole =
      (await this.roleModel.findOne({ name: 'User' })) ||
      (await this.roleModel.findOne({ name: 'Student' }));

    await this.userModel.create({
      user_name: dto.user_name,
      email: dto.email.toLowerCase(),
      pw_hash,
      status: UserStatus.ACTIVE,
      role: defaultRole?._id,
    });

    return { message: 'Account created successfully' };
  }

  async login(dto: LoginDto, ip: string, deviceLabel?: string) {
    const loginKey = dto.email.trim();
    const isStudentCode = /^\d+$/.test(loginKey);
    const studentEmail = isStudentCode ? `${loginKey}@school.edu.vn` : loginKey;

    const user = await this.userModel
      .findOne({
        $or: [{ email: studentEmail.toLowerCase() }, { user_name: loginKey }],
      })
      .populate({
        path: 'role',
        populate: { path: 'permissions' },
      })
      .populate({
        path: 'roles',
        populate: { path: 'permissions' },
      })
      .exec();

    if (!user) {
      await this.logAction(
        null,
        ip,
        'login_failure',
        `User not found: ${maskLoginKey(dto.email)}`,
      );
      throw new UnauthorizedException(INVALID_LOGIN_MESSAGE);
    }

    if (user.status === UserStatus.INACTIVE) {
      await this.logAction(
        user._id,
        ip,
        'login_failure',
        `Inactive user login attempt: ${maskLoginKey(dto.email)}`,
      );
      throw new ForbiddenException(
        'Tài khoản chưa được kích hoạt bởi quản trị viên.',
      );
    }

    // Check account lock
    if (user.status === UserStatus.LOCKED) {
      if (user.locked_until) {
        if (new Date() < new Date(user.locked_until)) {
          const minutesLeft = Math.ceil(
            (new Date(user.locked_until).getTime() - Date.now()) / 60000,
          );
          throw new ForbiddenException(
            `Tài khoản bị khóa. Vui lòng thử lại sau ${minutesLeft} phút.`,
          );
        }
        user.status = UserStatus.ACTIVE;
        user.failed_login_attempts = 0;
        user.locked_until = null;
        await this.safeSave(user);
      } else {
        throw new ForbiddenException('Tài khoản đã bị khóa bởi quản trị viên.');
      }
    }

    const passwordHash = user.pw_hash || (user as any).password_hash;
    const isPasswordValid = await this.passwordService.comparePassword(
      dto.password,
      passwordHash || '',
    );
    if (!isPasswordValid) {
      user.failed_login_attempts += 1;
      if (user.failed_login_attempts >= MAX_LOGIN_ATTEMPTS) {
        user.status = UserStatus.LOCKED;
        user.locked_until = new Date(
          Date.now() + LOCK_DURATION_MINUTES * 60 * 1000,
        );
        await this.safeSave(user);
        await this.logAction(user._id, ip, 'login_failure', 'Account locked');
        throw new ForbiddenException(
          `Tài khoản đã bị khóa. Thử lại sau ${LOCK_DURATION_MINUTES} phút.`,
        );
      }
      await this.safeSave(user);
      await this.logAction(user._id, ip, 'login_failure', 'Wrong password');
      throw new UnauthorizedException(INVALID_LOGIN_MESSAGE);
    }

    // Success
    user.failed_login_attempts = 0;
    user.locked_until = null;
    await this.safeSave(user);

    const role = user.role as any;
    // Remembered sessions use the same rolling policy for every role. The
    // short-lived access token remains independent from this refresh lifetime.
    const rtExpirationDays = dto.remember ? 30 : 1;

    const sessionId = new Types.ObjectId();
    const payload = { user_id: user._id.toString(), session_id: sessionId.toString() };
    const access_token = this.tokenService.generateAccessToken(payload);
    const refresh_token = await this.tokenService.createRefreshToken(
      user._id,
      rtExpirationDays,
      !!dto.remember,
      undefined,
      sessionId,
      deviceLabel,
    );

    await this.logAction(
      user._id,
      ip,
      'login_success',
      `Remember: ${!!dto.remember}`,
    );

    const student = await this.studentModel
      .findOne({ user_id: user._id })
      .exec();
    const displayName = student ? student.full_name : user.user_name;
    const roles = getAssignedRoles(user);
    const roleCodes = roles.map((r: any) => r.role_code);
    const permissions = getEffectivePermissions(user);

    return {
      access_token,
      refresh_token,
      expires_at: new Date(Date.now() + rtExpirationDays * 24 * 60 * 60 * 1000),
      remember: !!dto.remember,
      user: {
        id: user._id.toString(),
        username: user.user_name,
        display_name: displayName,
        role: role?.name || 'User',
        roleCode: role?.role_code || 'USER',
        roles,
        roleCodes,
        permissions,
      },
    };
  }

  // ─── PASSWORD WRAPPERS ──────────────────────────────────────

  async forgotPassword(dto: ForgotPasswordDto, ip: string) {
    const result = await this.passwordService.forgotPassword(dto, ip);
    if (result.userId) {
      await this.logAction(
        result.userId,
        ip,
        'password_reset',
        'Reset token generated',
      );
    }
    return { message: result.message };
  }

  async requestPasswordReset(dto: PasswordResetRequestDto, ip: string) {
    return this.passwordService.requestPasswordReset(dto, ip);
  }

  async resendPasswordResetOtp(dto: PasswordResetResendDto) {
    return this.passwordService.resendPasswordResetOtp(dto);
  }

  async verifyPasswordResetOtp(dto: PasswordResetVerifyDto) {
    return this.passwordService.verifyPasswordResetOtp(dto);
  }

  async completePasswordReset(dto: PasswordResetCompleteDto) {
    return this.passwordService.completePasswordReset(dto);
  }

  async resetPassword(dto: ResetPasswordDto, ip: string) {
    const result = await this.passwordService.resetPassword(dto);
    await this.logAction(result.userId, ip, 'password_reset', 'Completed');
    return { message: 'Đặt lại mật khẩu thành công' };
  }

  async changePassword(userId: string, dto: ChangePasswordDto, ip: string) {
    const result = await this.passwordService.changePassword(userId, dto);
    await this.logAction(
      result.userId,
      ip,
      'password_change',
      'Updated by user',
    );
    return { message: 'Đổi mật khẩu thành công' };
  }

  // ─── TOKEN WRAPPERS ─────────────────────────────────────────

  async refreshToken(token: string) {
    return this.tokenService.refreshToken(token);
  }

  async forkSession(userId: string, remember: boolean) {
    const days = remember ? 30 : 1;
    const objectId = new Types.ObjectId(userId);
    const sessionId = new Types.ObjectId();
    const access_token = this.tokenService.generateAccessToken({
      user_id: userId,
      session_id: sessionId.toString(),
    });
    const refresh_token = await this.tokenService.createRefreshToken(
      objectId,
      days,
      remember,
      undefined,
      sessionId,
    );
    return {
      access_token,
      refresh_token,
      expires_at: new Date(Date.now() + days * 24 * 60 * 60 * 1000),
      remember,
    };
  }

  async createImpersonation(
    actorUserId: string,
    subjectUserId: string,
    browserSessionId: string,
    ip: string,
    parentSessionId: string,
  ) {
    let session: any;
    let refreshToken: string | undefined;
    try {
      const acquired = await this.impersonationService.acquire(
        actorUserId,
        subjectUserId,
        browserSessionId,
        ip,
        parentSessionId,
      );
      session = acquired.session;

      const childSessionId = new Types.ObjectId();
      const payload = {
        user_id: acquired.subject._id.toString(),
        session_id: childSessionId.toString(),
        actor_user_id: actorUserId,
        impersonation_session_id: session._id.toString(),
      };
      const accessToken = this.tokenService.generateAccessToken(payload);
      refreshToken = await this.tokenService.createRefreshToken(
        acquired.subject._id,
        1 / 6,
        false,
        {
          sessionId: session._id,
          actorUserId: new Types.ObjectId(actorUserId),
          expiresAt: session.expires_at,
          parentSessionId: new Types.ObjectId(parentSessionId),
        },
        childSessionId,
      );
      await this.impersonationService.recordStarted(session);

      const student = await this.studentModel
        .findOne({ user_id: acquired.subject._id })
        .exec();
      const role = acquired.subject.role as any;
      return {
        access_token: accessToken,
        refresh_token: refreshToken,
        user: {
          id: acquired.subject._id.toString(),
          username: acquired.subject.user_name,
          display_name: student?.full_name || acquired.subject.user_name,
          role: role?.name || 'User',
        },
        impersonation: {
          id: session._id.toString(),
          expires_at: session.expires_at,
        },
      };
    } catch (error) {
      if (refreshToken) {
        await this.tokenService
          .revokeToken(refreshToken)
          .catch(() => undefined);
      }
      if (session) {
        await this.impersonationService
          .release(session._id.toString(), 'startup_failure', ip)
          .catch(() => undefined);
      }
      throw error;
    }
  }

  async cancelImpersonation(
    actorUserId: string,
    browserSessionId: string,
    ip: string,
  ): Promise<{ cancelled: boolean }> {
    const session =
      await this.impersonationService.releaseActiveForActorBrowserSession(
        actorUserId,
        browserSessionId,
        ip,
      );
    if (!session) return { cancelled: false };

    await this.tokenService.revokeAllImpersonationTokens(
      session._id.toString(),
    );
    return { cancelled: true };
  }

  async terminateImpersonation(
    subjectUserId: string,
    ip: string,
  ): Promise<{ terminated: boolean }> {
    const session = await this.impersonationService.releaseActiveForSubject(
      subjectUserId,
      ip,
    );
    if (!session) return { terminated: false };

    await this.tokenService.revokeAllImpersonationTokens(
      session._id.toString(),
    );
    return { terminated: true };
  }

  async revokeToken(token: string, ip?: string) {
    const storedToken = await this.tokenService.findToken(token);
    if (storedToken?.impersonation_session_id) {
      const sessionId = storedToken.impersonation_session_id.toString();
      try {
        await this.impersonationService.release(
          sessionId,
          'logout',
          ip || '0.0.0.0',
        );
      } finally {
        await this.tokenService.revokeAllImpersonationTokens(sessionId);
      }
      return;
    }
    if (ip && storedToken) {
      await this.logAction(
        storedToken.user_id,
        ip,
        'logout',
        'Logged out by user',
      );
    }
    return this.tokenService.revokeToken(token);
  }

  // ─── RBAC WRAPPERS ──────────────────────────────────────────

  async getRoles() {
    return this.rbacService.getRoles();
  }
  async getPermissions() {
    return this.rbacService.getPermissions();
  }
  async createPermission(dto: any) {
    return this.rbacService.createPermission(dto);
  }
  async updatePermission(id: string, dto: any) {
    return this.rbacService.updatePermission(id, dto);
  }
  async deletePermission(id: string) {
    return this.rbacService.deletePermission(id);
  }
  async getPermissionGroups() {
    return this.rbacService.getPermissionGroups();
  }
  async createPermissionGroup(dto: any) {
    return this.rbacService.createPermissionGroup(dto);
  }
  async updatePermissionGroup(id: string, dto: any) {
    return this.rbacService.updatePermissionGroup(id, dto);
  }
  async deletePermissionGroup(id: string) {
    return this.rbacService.deletePermissionGroup(id);
  }
  async createRole(dto: any) {
    return this.rbacService.createRole(dto);
  }
  async updateRole(id: string, dto: any) {
    return this.rbacService.updateRole(id, dto);
  }
  async deleteRole(id: string) {
    return this.rbacService.deleteRole(id);
  }
  async assignRole(userId: string, dto: AssignRoleDto) {
    const result = await this.rbacService.assignRole(userId, dto);
    await this.tokenService.revokeAllUserTokens(userId);
    return result;
  }

  // ─── ROUTE PERMISSION WRAPPERS ──────────────────
  async getRoutePermissions() {
    return this.rbacService.getRoutePermissions();
  }
  async getRoutePermissionByRoute(routePath: string) {
    return this.rbacService.getRoutePermissionByRoute(routePath);
  }
  async getPagePermissionScopes() {
    return [
      {
        route_path: '/system',
        access_permissions: [
          'SYSTEM_ADMIN',
          'SYSTEM_PERFORMANCE_READ',
          'LOGIN_LOG_READ',
          'SYSTEM_REQUEST_READ',
          'SYSTEM_REQUEST_MANAGE',
          'DATABASE_BACKUP_READ',
          'DATABASE_BACKUP_CREATE',
          'DATABASE_BACKUP_DOWNLOAD',
          'DATABASE_BACKUP_DELETE',
          'DATABASE_BACKUP_RESTORE',
          'SYSTEM_MAIL_CONFIG_MANAGE',
        ],
        action_permissions: [
          'SYSTEM_PERFORMANCE_READ',
          'LOGIN_LOG_READ',
          'SYSTEM_REQUEST_READ',
          'SYSTEM_REQUEST_MANAGE',
          'DATABASE_BACKUP_READ',
          'DATABASE_BACKUP_CREATE',
          'DATABASE_BACKUP_DOWNLOAD',
          'DATABASE_BACKUP_DELETE',
          'DATABASE_BACKUP_RESTORE',
          'SYSTEM_MAIL_CONFIG_MANAGE',
        ],
      },
      {
        route_path: '/permissions',
        access_permissions: ['admin'],
        action_permissions: [
          'view_users',
          'reset_pwd',
          'ADMIN_FULL',
          'USER_CREATE',
          'USER_UPDATE',
          'USER_DELETE',
          'ROLE_CREATE',
          'ROLE_UPDATE',
          'ROLE_DELETE',
          'PERMISSION_CREATE',
          'PERMISSION_UPDATE',
          'PERMISSION_DELETE',
          'PERMISSION_GROUP_CREATE',
          'PERMISSION_GROUP_UPDATE',
          'PERMISSION_GROUP_DELETE',
          'ROUTE_PERMISSION_CREATE',
          'ROUTE_PERMISSION_UPDATE',
          'ROUTE_PERMISSION_DELETE',
        ],
        notes: ['Chưa tách CRUD permission riêng'],
      },
      {
        route_path: '/students',
        access_permissions: ['STUDENT_PAGE'],
        action_permissions: [
          'STUDENT_READ',
          'STUDENT_CREATE',
          'STUDENT_UPDATE',
          'STUDENT_DELETE',
          'STUDENT_IMPORT',
          'STUDENT_EXPORT',
          'STUDENT_ACCOUNT_ACTIVATE',
          'STUDENT_ACCOUNT_RESET_PASSWORD',
          'STUDENT_TRANSFER',
          'DEPT_CREATE',
          'DEPT_UPDATE',
          'DEPT_DELETE',
          'CLASS_CREATE',
          'CLASS_UPDATE',
          'CLASS_DELETE',
        ],
      },
      {
        route_path: '/students/record',
        access_permissions: ['READ_STUDENT_RECORD'],
        action_permissions: [
          'CREATE_STUDENT_RECORD',
          'UPDATE_STUDENT_RECORD',
          'DELETE_STUDENT_RECORD',
          'READ_CLASS_RECORD',
          'READ_ALL_CLASS_RECORD',
          'CREATE_CLASS_RECORD',
          'UPDATE_CLASS_RECORD',
          'DELETE_CLASS_RECORD',
        ],
      },
      {
        route_path: '/students/tasks',
        access_permissions: ['READ_STUDENT_TASK'],
        action_permissions: [
          'CREATE_STUDENT_TASK',
          'UPDATE_STUDENT_TASK',
          'DELETE_STUDENT_TASK',
        ],
      },
      {
        route_path: '/grading',
        access_permissions: ['GRADING_PAGE'],
        action_permissions: [
          'GRADING_SCORE_GRADE',
          'GRADING_SCORE_APPROVE',
          'GRADING_SEMESTER_MANAGE',
          'CONFIG_RECORD',
        ],
      },
      {
        route_path: '/activities',
        access_permissions: ['ACTIVITY_PAGE', 'ACTIVITY_READ'],
        action_permissions: [
          'ACTIVITY_CREATE',
          'ACTIVITY_UPDATE',
          'ACTIVITY_DELETE',
          'ACTIVITY_MEMBER_MANAGE',
          'ACTIVITY_REPORT_READ',
          'ACTIVITY_EXPORT',
        ],
      },
      {
        route_path: '/activities/schedule',
        access_permissions: ['ACTIVITY_SCHEDULE_READ'],
        action_permissions: ['ACTIVITY_SCHEDULE_MANAGE', 'ACTIVITY_SCHEDULE_REGISTER'],
      },
      {
        route_path: '/activities/attendance',
        access_permissions: ['ACTIVITY_ATTENDANCE_READ'],
        action_permissions: [
          'ACTIVITY_ATTENDANCE_CREATE',
          'ACTIVITY_ATTENDANCE_UPDATE',
          'ACTIVITY_ATTENDANCE_APPROVE',
          'ACTIVITY_ATTENDANCE_DELETE',
          'ATTENDANCE_SESSION_CREATE',
          'ATTENDANCE_SESSION_READ',
          'ATTENDANCE_SESSION_CLOSE',
        ],
      },
      {
        route_path: '/activities/:activityId',
        access_permissions: ['ACTIVITY_READ'],
        action_permissions: [
          'ACTIVITY_UPDATE',
          'ACTIVITY_MEMBER_MANAGE',
          'ACTIVITY_SCHEDULE_READ',
          'ACTIVITY_ATTENDANCE_READ',
          'ACTIVITY_CONFIG_READ',
          'ACTIVITY_CONFIG_MANAGE',
        ],
      },
      {
        route_path: '/reports',
        access_permissions: ['REPORTS_PAGE'],
        action_permissions: ['REPORTS_READ'],
      },
    ];
  }
  async createRoutePermission(dto: any) {
    return this.rbacService.createRoutePermission(dto);
  }
  async updateRoutePermission(id: string, dto: any) {
    return this.rbacService.updateRoutePermission(id, dto);
  }
  async deleteRoutePermission(id: string) {
    return this.rbacService.deleteRoutePermission(id);
  }

  // ─── USER MANAGEMENT ──────────────────────────

  private async resolveRoleAssignments(dto: any) {
    if (dto.role_id && !dto.role_ids && !dto.primary_role_id) {
      try {
        const roleQuery: any = this.roleModel.findById(dto.role_id);
        const legacyRole = roleQuery?.populate
          ? await roleQuery.populate('permissions').exec()
          : await roleQuery;
        if (!legacyRole) throw new BadRequestException('Vai trò không tồn tại');
        return { ids: [String(dto.role_id)], roles: [legacyRole], primary: legacyRole, primaryId: String(dto.role_id) };
      } catch (error) {
        if (error instanceof BadRequestException) throw error;
        throw new BadRequestException('ID vai trò không hợp lệ');
      }
    }
    const rawIds = Array.isArray(dto.role_ids) && dto.role_ids.length
      ? dto.role_ids
      : dto.role_id
        ? [dto.role_id]
        : [];
    const ids: string[] = [...new Set<string>(rawIds.map((id: string) => String(id)))];
    if (ids.length === 0) throw new BadRequestException('Phải chọn ít nhất một vai trò');
    if (ids.some((id) => !Types.ObjectId.isValid(id))) {
      throw new BadRequestException('ID vai trò không hợp lệ');
    }
    const roles = await this.roleModel.find({ _id: { $in: ids } }).populate('permissions').exec();
    const roleMap = new Map(roles.map((role) => [role._id.toString(), role]));
    if (roles.length !== ids.length) throw new BadRequestException('Vai trò không tồn tại');
    const primaryId = String(dto.primary_role_id || ids[0]);
    if (!ids.includes(primaryId)) throw new BadRequestException('Vai trò chính phải thuộc danh sách vai trò');
    const primary = roleMap.get(primaryId)!;
    if (roles.some((role) => role.role_code === 'ADMIN') && primary.role_code !== 'ADMIN') {
      throw new BadRequestException('Vai trò ADMIN phải là vai trò chính');
    }
    return { ids, roles: ids.map((id) => roleMap.get(id)!), primary, primaryId };
  }

  async getMe(userId: string) {
    const user = await this.userModel
      .findById(userId)
      .populate({
        path: 'role',
        populate: { path: 'permissions' },
      })
      .populate({
        path: 'roles',
        populate: { path: 'permissions' },
      })
      .select('-pw_hash');

    if (!user) throw new BadRequestException('Người dùng không tồn tại');

    const role = user.role as any;
    const assignedRoles = getAssignedRoles(user);
    const permissions = getEffectivePermissions(user);

    const student = await this.studentModel
      .findOne({ user_id: user._id })
      .exec();
    const displayName = student ? student.full_name : user.user_name;

    return {
      id: user._id.toString(),
      user_name: user.user_name,
      display_name: displayName,
      email: user.email,
      phone_number: user.phone_number || '',
      department: user.department || '',
      date_birth: user.date_birth || null,
      status: user.status,
      roleName: role?.name || 'User',
      roleCode: role?.role_code || 'USER',
      role: role
        ? {
            _id: role._id.toString(),
            name: role.name,
            role_code: role.role_code,
            permissions: role.permissions || [],
          }
        : null,
      roles: assignedRoles,
      roleCodes: assignedRoles.map((assignedRole: any) => assignedRole.role_code),
      permissions,
      advisor_classes: (
        await this.classModel.find({ advisor_id: user._id }).exec()
      ).map((c) => ({
        _id: c._id,
        class_name: c.class_name,
        class_year: c.class_year,
      })),
    };
  }

  async updateMe(userId: string, dto: UpdateMeDto) {
    if (!Types.ObjectId.isValid(userId)) {
      throw new BadRequestException('ID người dùng không hợp lệ');
    }

    const user = await this.userModel.findById(userId);
    if (!user) {
      throw new BadRequestException('Người dùng không tồn tại');
    }

    // Check duplicate username if provided
    if (dto.user_name && dto.user_name !== user.user_name) {
      const existingUsername = await this.userModel.findOne({
        user_name: dto.user_name,
      });
      if (existingUsername) throw new ConflictException('Username đã tồn tại');
      user.user_name = dto.user_name;
    }

    if (dto.phone_number !== undefined) user.phone_number = dto.phone_number;
    if (dto.department !== undefined) user.department = dto.department;
    if (dto.date_birth !== undefined)
      user.date_birth = new Date(dto.date_birth);

    await user.save();
    return this.getMe(userId);
  }

  async getUsers() {
    const users = await this.userModel
      .find()
      .populate({ path: 'role', populate: { path: 'permissions' } })
      .populate({ path: 'roles', populate: { path: 'permissions' } })
      .select('-pw_hash')
      .exec();

    const userIds = users.map((u) => u._id);
    const students = await this.studentModel
      .find({ user_id: { $in: userIds } })
      .exec();
    const impersonatedSubjectIds =
      await this.impersonationService.getActiveSubjectUserIds();

    const studentMap = new Map();
    for (const student of students) {
      if (student.user_id) {
        studentMap.set(student.user_id.toString(), student);
      }
    }

    return users.map((user) => {
      const userObj = user.toObject() as any;
      userObj.roles = getAssignedRoles(userObj);
      userObj.roleCodes = userObj.roles.map((role: any) => role.role_code);
      userObj.permissions = getEffectivePermissions(userObj);
      userObj.is_under_impersonation = impersonatedSubjectIds.has(
        user._id.toString(),
      );
      const student = studentMap.get(user._id.toString());
      if (student) {
        userObj.display_name = student.full_name;
        userObj.student_profile = {
          id: student._id,
          student_code: student.student_code,
          full_name: student.full_name,
          class_id: student.class_id,
        };
      } else {
        userObj.display_name = user.user_name;
      }
      return userObj;
    });
  }

  async updateUser(userId: string, dto: UpdateUserDto, ip: string, currentSessionId?: string) {
    if (!Types.ObjectId.isValid(userId)) {
      throw new BadRequestException('ID người dùng không hợp lệ');
    }

    const user = await this.userModel.findById(userId);
    if (!user) {
      throw new BadRequestException('Người dùng không tồn tại');
    }

    // Check duplicate username if provided
    if (dto.user_name && dto.user_name !== user.user_name) {
      const existingUsername = await this.userModel.findOne({
        user_name: dto.user_name,
      });
      if (existingUsername) throw new ConflictException('Username đã tồn tại');
      user.user_name = dto.user_name;
    }

    // Check duplicate email if provided
    if (dto.email && dto.email.toLowerCase() !== user.email) {
      const existingEmail = await this.userModel.findOne({
        email: dto.email.toLowerCase(),
      });
      if (existingEmail) throw new ConflictException('Email đã được sử dụng');
      user.email = dto.email.toLowerCase();
    }

    let shouldRevokeTokens = false;

    if (dto.role_id || dto.role_ids || dto.primary_role_id) {
      const assignment = await this.resolveRoleAssignments(dto);
      const currentIds = getAssignedRoles(user).map((role: any) => role._id?.toString?.() || role.toString());
      const changed = assignment.ids.join(',') !== currentIds.join(',') || user.role?.toString() !== assignment.primaryId;
      user.roles = assignment.roles.map((role) => role._id) as any;
      user.role = assignment.primary._id;
      shouldRevokeTokens ||= changed;
    }

    // Update other fields
    if (dto.status) {
      if (dto.status === UserStatus.LOCKED) {
        user.locked_until = null;
        shouldRevokeTokens = true;
      }
      if (
        dto.status !== UserStatus.ACTIVE &&
        dto.status !== UserStatus.LOCKED &&
        dto.status !== UserStatus.INACTIVE
      ) {
        throw new BadRequestException('Trạng thái không hợp lệ');
      }
      if (user.status !== dto.status) {
        user.status = dto.status as UserStatus;
        if (
          dto.status === UserStatus.LOCKED ||
          dto.status === UserStatus.INACTIVE
        ) {
          shouldRevokeTokens = true;
        }
      }
      // If status changes to Active or Inactive, clear locking properties
      if (
        dto.status === UserStatus.ACTIVE ||
        dto.status === UserStatus.INACTIVE
      ) {
        user.failed_login_attempts = 0;
        user.locked_until = null;
      }
    }

    if (dto.phone_number !== undefined) user.phone_number = dto.phone_number;
    if (dto.department !== undefined) user.department = dto.department;
    if (dto.date_birth !== undefined)
      user.date_birth = new Date(dto.date_birth);

    if (dto.password) {
      user.pw_hash = await this.passwordService.hashPassword(dto.password);
      user.failed_login_attempts = 0;
      user.locked_until = null;
      user.status = UserStatus.ACTIVE;
      shouldRevokeTokens = true;
      await this.logAction(
        user._id,
        ip,
        'admin_reset_password',
        'Password reset by administrator',
      );
    }

    await user.save();

    if (dto.advisor_class_ids !== undefined) {
      const roleObj = user.role
        ? await this.roleModel.findById(user.role)
        : null;
      const isTeacher =
        roleObj &&
        (roleObj.role_code === 'TEACHER' ||
          !!roleObj.name.match(/Teacher|Giảng viên|GVCN/i));

      if (dto.advisor_class_ids.length > 0 && !isTeacher) {
        throw new BadRequestException(
          'Chỉ người dùng có vai trò Giảng viên/GVCN mới được gán làm GVCN',
        );
      }

      if (isTeacher && dto.advisor_class_ids.length > 0) {
        for (const classId of dto.advisor_class_ids) {
          const classObj = await this.classModel.findById(classId);
          if (!classObj) throw new BadRequestException('Lớp không tồn tại');
          if (
            classObj.advisor_id &&
            classObj.advisor_id.toString() !== user._id.toString()
          ) {
            throw new BadRequestException(`Lớp đã có GVCN khác`);
          }
        }
      }

      await this.classModel.updateMany(
        { advisor_id: user._id },
        { $unset: { advisor_id: '' } },
      );

      if (isTeacher && dto.advisor_class_ids.length > 0) {
        for (const classId of dto.advisor_class_ids) {
          await this.classModel.updateOne(
            { _id: classId },
            { advisor_id: user._id },
          );
        }
      }
    }

    if (shouldRevokeTokens) {
      if (currentSessionId !== undefined) {
        await this.tokenService.revokeAllUserTokens(user._id.toString(), currentSessionId);
      } else {
        await this.tokenService.revokeAllUserTokens(user._id.toString());
      }
    }

    // Populate role and return updated user (without pw_hash)
    const updatedUser = await this.userModel
      .findById(userId)
      .populate('role')
      .populate('roles')
      .select('-pw_hash');
    const updatedUserObj = updatedUser?.toObject?.() as any;
    if (updatedUserObj) {
      updatedUserObj.roles = getAssignedRoles(updatedUserObj);
      updatedUserObj.roleCodes = updatedUserObj.roles.map((role: any) => role.role_code);
      updatedUserObj.permissions = getEffectivePermissions(updatedUserObj);
    }
    return {
      message: 'Cập nhật người dùng thành công',
      user: updatedUserObj,
    };
  }

  /**
   * Tạo một người dùng mới từ giao diện Admin.
   * @param dto Thông tin người dùng cần tạo.
   * @param ip Địa chỉ IP của admin thực hiện thao tác để ghi log.
   * @returns Thông tin người dùng vừa được tạo.
   */
  async createUser(dto: any, ip?: string) {
    const existingUsername = await this.userModel.findOne({
      user_name: dto.user_name,
    });
    if (existingUsername) throw new ConflictException('Username đã tồn tại');

    const existingEmail = await this.userModel.findOne({
      email: dto.email.toLowerCase(),
    });
    if (existingEmail) throw new ConflictException('Email đã được sử dụng');

    const assignment = await this.resolveRoleAssignments(dto);

    const pw_hash = await this.passwordService.hashPassword(dto.password);

    const newUser = await this.userModel.create({
      user_name: dto.user_name,
      email: dto.email.toLowerCase(),
      pw_hash,
      status: dto.status || UserStatus.ACTIVE,
      role: assignment.primary._id,
      roles: assignment.roles.map((role) => role._id),
    });

    if (dto.advisor_class_ids && dto.advisor_class_ids.length > 0) {
      const isTeacher =
        assignment.primary.role_code === 'TEACHER' ||
        !!assignment.primary.name.match(/Teacher|Giảng viên|GVCN/i);
      if (!isTeacher) {
        await this.userModel.deleteOne({ _id: newUser._id });
        throw new BadRequestException(
          'Chỉ người dùng có vai trò Giảng viên/GVCN mới được gán làm GVCN',
        );
      }
      for (const classId of dto.advisor_class_ids) {
        const classObj = await this.classModel.findById(classId);
        if (!classObj) {
          await this.userModel.deleteOne({ _id: newUser._id });
          throw new BadRequestException('Lớp không tồn tại');
        }
        if (classObj.advisor_id) {
          await this.userModel.deleteOne({ _id: newUser._id });
          throw new BadRequestException('Lớp đã có GVCN');
        }
      }
      for (const classId of dto.advisor_class_ids) {
        await this.classModel.updateOne(
          { _id: classId },
          { advisor_id: newUser._id },
        );
      }
    }

    if (ip) {
      await this.logAction(
        newUser._id,
        ip,
        'admin_create_user',
        `User created by admin`,
      );
    }

    const result = newUser.toObject() as any;
    delete result.pw_hash;
    return { message: 'Người dùng đã được tạo thành công', user: result };
  }

  /**
   * Tạo nhiều người dùng cùng lúc (Bulk Create).
   * @param dto Thông tin chứa danh sách users và mật khẩu dùng chung (nếu có).
   * @param ip Địa chỉ IP của admin thực hiện thao tác để ghi log.
   * @returns Báo cáo số lượng thành công, thất bại, và danh sách lỗi.
   */
  async createUsersBulk(dto: any, ip?: string) {
    const { users, commonPassword } = dto;

    if (!users || users.length === 0) {
      throw new BadRequestException('Danh sách người dùng không được rỗng');
    }

    const successes: any[] = [];
    const errors: any[] = [];

    for (let i = 0; i < users.length; i++) {
      const u = users[i];
      try {
        if (!u.user_name || !u.email || (!u.role_id && !u.role_ids)) {
          throw new BadRequestException(
            'Thiếu trường bắt buộc (user_name, email, role_ids)',
          );
        }

        const password = commonPassword || u.password;
        if (!password) {
          throw new BadRequestException('Thiếu mật khẩu');
        }

        const existingUsername = await this.userModel.findOne({
          user_name: u.user_name,
        });
        if (existingUsername)
          throw new ConflictException('Username đã tồn tại');

        const existingEmail = await this.userModel.findOne({
          email: u.email.toLowerCase(),
        });
        if (existingEmail) throw new ConflictException('Email đã được sử dụng');

        const assignment = await this.resolveRoleAssignments(u);

        const pw_hash = await this.passwordService.hashPassword(password);

        const newUser = await this.userModel.create({
          user_name: u.user_name,
          email: u.email.toLowerCase(),
          pw_hash,
          status: u.status || UserStatus.ACTIVE,
          role: assignment.primary._id,
          roles: assignment.roles.map((role) => role._id),
        });

        const classIds =
          u.advisor_class_ids && u.advisor_class_ids.length > 0
            ? u.advisor_class_ids
            : u.advisor_class_id
              ? [u.advisor_class_id]
              : [];
        if (classIds.length > 0) {
          const roleObj = assignment.primary;
          const isTeacher =
            roleObj &&
            (roleObj.role_code === 'TEACHER' ||
              !!roleObj.name.match(/Teacher|Giảng viên|GVCN/i));
          if (isTeacher) {
            for (const classId of classIds) {
              const classObj = await this.classModel.findById(classId);
              if (!classObj) {
                await this.userModel.deleteOne({ _id: newUser._id });
                throw new BadRequestException('Lớp không tồn tại');
              }
              if (classObj.advisor_id) {
                await this.userModel.deleteOne({ _id: newUser._id });
                throw new BadRequestException('Lớp đã có GVCN');
              }
            }
            for (const classId of classIds) {
              await this.classModel.updateOne(
                { _id: classId },
                { advisor_id: newUser._id },
              );
            }
          } else {
            await this.userModel.deleteOne({ _id: newUser._id });
            throw new BadRequestException(
              'Chỉ người dùng có vai trò Giảng viên mới được gán làm GVCN',
            );
          }
        }

        if (ip) {
          await this.logAction(
            newUser._id,
            ip,
            'admin_create_user_bulk',
            `User created in bulk by admin`,
          );
        }

        successes.push({
          index: i,
          user_id: newUser._id.toString(),
          user_name: newUser.user_name,
          email: newUser.email,
        });
      } catch (err: any) {
        errors.push({
          index: i,
          user_name: u.user_name,
          email: u.email,
          reason: err.message || 'Lỗi không xác định',
        });
      }
    }

    if (ip && successes.length > 0) {
      await this.logAction(
        null,
        ip,
        'admin_bulk_create_users',
        `Bulk created ${successes.length} users successfully`,
      );
    }

    return {
      total: users.length,
      successCount: successes.length,
      failedCount: errors.length,
      successes,
      errors,
    };
  }

  async deleteUser(userId: string) {
    if (!Types.ObjectId.isValid(userId))
      throw new BadRequestException('ID người dùng không hợp lệ');
    const result = await this.userModel.deleteOne({ _id: userId });
    if (result.deletedCount === 0)
      throw new BadRequestException('Người dùng không tồn tại');
    return { message: 'Xóa người dùng thành công' };
  }

  async deleteUsersBulk(userIds: string[]) {
    const invalidIds = userIds.filter((id) => !Types.ObjectId.isValid(id));
    if (invalidIds.length > 0) {
      throw new BadRequestException(
        `Có ID người dùng không hợp lệ: ${invalidIds.join(', ')}`,
      );
    }

    const result = await this.userModel.deleteMany({ _id: { $in: userIds } });
    return {
      message: `Đã xóa thành công ${result.deletedCount}/${userIds.length} người dùng.`,
      deletedCount: result.deletedCount,
    };
  }

  // ─── INTERNAL LOGGING ───────────────────────────────────────

  private async logAction(
    userId: Types.ObjectId | null,
    ip: string,
    action: string,
    details: string | null,
  ) {
    const log = await this.loginLogModel.create({
      user_id: userId,
      ip_address: ip,
      action,
      login_time: new Date(),
      details: details || undefined,
    });

    try {
      const populatedLog = await log.populate({
        path: 'user_id',
        select: 'user_name email role',
        populate: { path: 'role', select: 'name role_code' },
      });
      // Dynamically load to prevent circular imports
      const {
        systemEventEmitter,
      } = require('../../system/system-event-emitter');
      systemEventEmitter.emit('login_log', populatedLog);
    } catch (err) {
      console.error('Failed to emit login_log event:', err);
    }
  }

  // ─── SEEDING & MIGRATION ────────────────────────────────────

  private async migrateLegacyRoleCodes() {
    // 1. Rename 'Giảng viên chính' / LECTURER to 'Teacher' / TEACHER
    await this.roleModel
      .updateOne(
        { $or: [{ name: 'Giảng viên chính' }, { role_code: 'LECTURER' }] },
        {
          $set: {
            name: 'Teacher',
            role_code: 'TEACHER',
            description: 'Giảng viên cố vấn học tập',
          },
        },
      )
      .exec();

    // 2. Assign default role_code for roles that don't have one
    const roles = await this.roleModel
      .find({ role_code: { $exists: false } })
      .exec();
    if (roles.length > 0) {
      for (const role of roles) {
        let code = '';
        if (role.name === 'Admin') code = 'ADMIN';
        else if (role.name === 'Teacher') code = 'TEACHER';
        else if (role.name === 'Supervisor') code = 'SUPERVISOR';
        else if (role.name === 'Student') code = 'STUDENT';
        else if (role.name === 'User') code = 'USER';
        else {
          code = role.name
            .normalize('NFD')
            .replace(/[\u0300-\u036f]/g, '')
            .toUpperCase()
            .replace(/\s+/g, '_');
        }

        let suffix = '';
        let count = 0;
        while (true) {
          const checkCode = `${code}${suffix}`;
          const existing = await this.roleModel
            .findOne({
              role_code: checkCode,
              _id: { $ne: role._id },
            })
            .exec();
          if (!existing) {
            code = checkCode;
            break;
          }
          count++;
          suffix = `_${count}`;
        }

        (role as any).role_code = code;
        await role.save();
      }
      console.log(
        `✅ Successfully migrated role_code for ${roles.length} roles.`,
      );
    }
  }

  private async seedRbac() {
    // Clean up G_ACADEMIC group and deleted permissions from DB
    await this.permissionModel
      .deleteMany({
        code: {
          $in: [
            'view_course',
            'create_course',
            'edit_content',
            'delete_course',
          ],
        },
      })
      .exec();
    await this.permissionGroupModel.deleteOne({ code: 'G_ACADEMIC' }).exec();

    // Load all existing permissions from database first (including declared permissions from registry)
    const allDbPerms = await this.permissionModel.find({}).exec();
    const createdPerms: Record<string, Types.ObjectId> = {};
    for (const p of allDbPerms) {
      createdPerms[p.code] = p._id;
    }

    const permissions = [
      {
        code: 'view_revenue',
        name: 'Xem báo cáo doanh thu',
        module: 'Tài chính & Kế toán (Finance)',
        description: 'Cho phép xem báo cáo thống kê doanh thu tài chính.',
      },
    ];

    for (const p of permissions) {
      const perm = await this.permissionModel
        .findOneAndUpdate(
          { code: p.code },
          { $set: p },
          { upsert: true, returnDocument: 'after' },
        )
        .exec();
      createdPerms[p.code] = perm._id;
    }

    const roles = [
      {
        name: 'Admin',
        role_code: 'ADMIN',
        description: 'Toàn quyền quản trị hệ thống',
        permissions: Object.values(createdPerms),
      },
      {
        name: 'Teacher',
        role_code: 'TEACHER',
        description: 'Giảng viên cố vấn học tập',
        permissions: [
          createdPerms['STUDENT_READ'],
          createdPerms['GRADING_PAGE'],
          createdPerms['GRADING_SCORE_GRADE'],
          createdPerms['STUDENT_PAGE'],
          createdPerms['TIMETABLE_PAGE'],
          createdPerms['TIMETABLE_READ'],
        ].filter(Boolean),
      },
      {
        name: 'Supervisor',
        role_code: 'SUPERVISOR',
        description: 'Quản sinh và giám sát rèn luyện',
        permissions: [
          createdPerms['GRADING_SCORE_GRADE'],
          createdPerms['GRADING_SCORE_APPROVE'],
          createdPerms['GRADING_SEMESTER_MANAGE'],
          createdPerms['GRADING_PAGE'],
          createdPerms['READ_STUDENT_TASK'],
          createdPerms['CREATE_STUDENT_TASK'],
          createdPerms['UPDATE_STUDENT_TASK'],
          createdPerms['DELETE_STUDENT_TASK'],
        ],
      },
      {
        name: 'Student',
        role_code: 'STUDENT',
        description: 'Sinh viên học sinh',
        permissions: [
          createdPerms['GRADING_PAGE'],
          createdPerms['READ_STUDENT_TASK'],
          createdPerms['TIMETABLE_PAGE'],
          createdPerms['TIMETABLE_READ'],
        ],
      },
      {
        name: 'Security Admin',
        role_code: 'SECURITY_ADMIN',
        description: 'Quản trị viên an ninh và phân quyền hệ thống',
        permissions: [
          createdPerms['admin'],
          createdPerms['view_users'],
          createdPerms['reset_pwd'],
          createdPerms['USER_CREATE'],
          createdPerms['USER_UPDATE'],
          createdPerms['USER_DELETE'],
          createdPerms['ROLE_CREATE'],
          createdPerms['ROLE_UPDATE'],
          createdPerms['ROLE_DELETE'],
          createdPerms['PERMISSION_CREATE'],
          createdPerms['PERMISSION_UPDATE'],
          createdPerms['PERMISSION_DELETE'],
          createdPerms['PERMISSION_GROUP_CREATE'],
          createdPerms['PERMISSION_GROUP_UPDATE'],
          createdPerms['PERMISSION_GROUP_DELETE'],
          createdPerms['ROUTE_PERMISSION_CREATE'],
          createdPerms['ROUTE_PERMISSION_UPDATE'],
          createdPerms['ROUTE_PERMISSION_DELETE'],
        ].filter(Boolean),
      },
      {
        name: 'System Operator',
        role_code: 'SYSTEM_OPERATOR',
        description: 'Vận hành hệ thống (không có quyền xóa/tải backup)',
        permissions: [
          createdPerms['SYSTEM_ADMIN'],
          createdPerms['SYSTEM_PERFORMANCE_READ'],
          createdPerms['LOGIN_LOG_READ'],
          createdPerms['SYSTEM_REQUEST_READ'],
          createdPerms['SYSTEM_REQUEST_MANAGE'],
          createdPerms['DATABASE_BACKUP_READ'],
        ].filter(Boolean),
      },
      {
        name: 'Audit Viewer',
        role_code: 'AUDIT_VIEWER',
        description: 'Chỉ xem nhật ký hệ thống',
        permissions: [
          createdPerms['SYSTEM_ADMIN'],
          createdPerms['LOGIN_LOG_READ'],
        ].filter(Boolean),
      },
      {
        name: 'Backup Operator',
        role_code: 'BACKUP_OPERATOR',
        description:
          'Vận hành sao lưu hệ thống (không có quyền xóa/tải backup)',
        permissions: [
          createdPerms['SYSTEM_ADMIN'],
          createdPerms['DATABASE_BACKUP_READ'],
          createdPerms['DATABASE_BACKUP_CREATE'],
        ].filter(Boolean),
      },
    ];

    await Promise.all(
      roles.map((r) =>
        this.roleModel
          .findOneAndUpdate(
            { role_code: r.role_code },
            {
              $set: {
                name: r.name,
                role_code: r.role_code,
                description: r.description,
              },
              $setOnInsert: {
                permissions: r.permissions,
              },
            },
            { upsert: true },
          )
          .exec(),
      ),
    );

    const groups = [
      {
        constant: ADMIN_RBAC_GROUP,
        permissions: [
          createdPerms['admin'],
          createdPerms['view_users'],
          createdPerms['reset_pwd'],
          createdPerms['ADMIN_FULL'],
          createdPerms['USER_CREATE'],
          createdPerms['USER_UPDATE'],
          createdPerms['USER_DELETE'],
          createdPerms['ROLE_CREATE'],
          createdPerms['ROLE_UPDATE'],
          createdPerms['ROLE_DELETE'],
          createdPerms['PERMISSION_CREATE'],
          createdPerms['PERMISSION_UPDATE'],
          createdPerms['PERMISSION_DELETE'],
          createdPerms['PERMISSION_GROUP_CREATE'],
          createdPerms['PERMISSION_GROUP_UPDATE'],
          createdPerms['PERMISSION_GROUP_DELETE'],
          createdPerms['ROUTE_PERMISSION_CREATE'],
          createdPerms['ROUTE_PERMISSION_UPDATE'],
          createdPerms['ROUTE_PERMISSION_DELETE'],
        ],
      },
      {
        constant: SYSTEM_OPERATIONS_GROUP,
        permissions: [
          createdPerms['SYSTEM_ADMIN'],
          createdPerms['SYSTEM_PERFORMANCE_READ'],
          createdPerms['LOGIN_LOG_READ'],
          createdPerms['SYSTEM_REQUEST_READ'],
          createdPerms['SYSTEM_REQUEST_MANAGE'],
          createdPerms['DATABASE_BACKUP_READ'],
          createdPerms['DATABASE_BACKUP_CREATE'],
          createdPerms['DATABASE_BACKUP_DOWNLOAD'],
          createdPerms['DATABASE_BACKUP_DELETE'],
          createdPerms['DATABASE_BACKUP_RESTORE'],
        ],
      },
      {
        constant: STUDENT_MANAGER_GROUP,
        permissions: [
          createdPerms['STUDENT_PAGE'],
          createdPerms['STUDENT_READ'],
          createdPerms['STUDENT_CREATE'],
          createdPerms['STUDENT_UPDATE'],
          createdPerms['STUDENT_DELETE'],
          createdPerms['STUDENT_IMPORT'],
          createdPerms['STUDENT_EXPORT'],
          createdPerms['STUDENT_ACCOUNT_ACTIVATE'],
          createdPerms['STUDENT_ACCOUNT_RESET_PASSWORD'],
          createdPerms['STUDENT_TRANSFER'],
          createdPerms['DEPT_CREATE'],
          createdPerms['DEPT_UPDATE'],
          createdPerms['DEPT_DELETE'],
          createdPerms['CLASS_CREATE'],
          createdPerms['CLASS_UPDATE'],
          createdPerms['CLASS_DELETE'],
        ],
      },
      {
        constant: GRADING_MANAGER_GROUP,
        permissions: [
          createdPerms['GRADING_PAGE'],
          createdPerms['GRADING_SEMESTER_MANAGE'],
          createdPerms['GRADING_SCORE_GRADE'],
          createdPerms['GRADING_SCORE_APPROVE'],
          createdPerms['CONFIG_RECORD'],
        ],
      },
      {
        constant: STUDENT_RECORD_GROUP,
        permissions: [
          createdPerms['READ_STUDENT_RECORD'],
          createdPerms['CREATE_STUDENT_RECORD'],
          createdPerms['UPDATE_STUDENT_RECORD'],
          createdPerms['DELETE_STUDENT_RECORD'],
          createdPerms['READ_CLASS_RECORD'],
          createdPerms['READ_ALL_CLASS_RECORD'],
          createdPerms['CREATE_CLASS_RECORD'],
          createdPerms['UPDATE_CLASS_RECORD'],
          createdPerms['DELETE_CLASS_RECORD'],
        ],
      },
      {
        constant: TASK_MANAGER_GROUP,
        permissions: [
          createdPerms['READ_STUDENT_TASK'],
          createdPerms['CREATE_STUDENT_TASK'],
          createdPerms['UPDATE_STUDENT_TASK'],
          createdPerms['DELETE_STUDENT_TASK'],
        ],
      },
      {
        constant: REPORT_MANAGER_GROUP,
        permissions: [
          createdPerms['REPORTS_PAGE'],
          createdPerms['REPORTS_READ'],
        ],
      },
      {
        constant: ACTIVITY_MANAGER_GROUP,
        permissions: [
          createdPerms['ACTIVITY_PAGE'],
          createdPerms['ACTIVITY_READ'],
          createdPerms['ACTIVITY_CREATE'],
          createdPerms['ACTIVITY_UPDATE'],
          createdPerms['ACTIVITY_DELETE'],
          createdPerms['ACTIVITY_MEMBER_MANAGE'],
          createdPerms['ACTIVITY_SCHEDULE_READ'],
          createdPerms['ACTIVITY_SCHEDULE_MANAGE'],
          createdPerms['ACTIVITY_SCHEDULE_REGISTER'],
          createdPerms['ACTIVITY_ATTENDANCE_READ'],
          createdPerms['ACTIVITY_ATTENDANCE_CREATE'],
          createdPerms['ACTIVITY_ATTENDANCE_UPDATE'],
          createdPerms['ACTIVITY_ATTENDANCE_APPROVE'],
          createdPerms['ACTIVITY_ATTENDANCE_DELETE'],
          createdPerms['ACTIVITY_CONFIG_READ'],
          createdPerms['ACTIVITY_CONFIG_MANAGE'],
          createdPerms['ACTIVITY_REPORT_READ'],
          createdPerms['ACTIVITY_EXPORT'],
          createdPerms['ATTENDANCE_SESSION_CREATE'],
          createdPerms['ATTENDANCE_SESSION_READ'],
          createdPerms['ATTENDANCE_SESSION_CLOSE'],
        ],
      },
      {
        constant: DORMITORY_MANAGER_GROUP,
        permissions: [
          createdPerms['DORM_PAGE'],
          createdPerms['DORM_BUILDING_READ'],
          createdPerms['DORM_BUILDING_CREATE'],
          createdPerms['DORM_BUILDING_UPDATE'],
          createdPerms['DORM_BUILDING_DELETE'],
          createdPerms['DORM_ROOM_READ'],
          createdPerms['DORM_ROOM_CREATE'],
          createdPerms['DORM_ROOM_UPDATE'],
          createdPerms['DORM_ROOM_DELETE'],
          createdPerms['DORM_BED_CREATE'],
          createdPerms['DORM_BED_UPDATE'],
          createdPerms['DORM_BED_DELETE'],
          createdPerms['DORM_REG_READ'],
          createdPerms['DORM_REG_CREATE'],
          createdPerms['DORM_REG_UPDATE'],
          createdPerms['DORM_REG_DELETE'],
          createdPerms['PDF_TEMPLATE_READ'],
          createdPerms['PDF_TEMPLATE_MANAGE'],
          createdPerms['PDF_TEMPLATE_DELETE'],
          createdPerms['DORM_CONTRACT_READ'],
          createdPerms['DORM_CONTRACT_CREATE'],
          createdPerms['DORM_CONTRACT_UPDATE'],
          createdPerms['DORM_INVOICE_READ'],
          createdPerms['DORM_INVOICE_CREATE'],
          createdPerms['DORM_INVOICE_CONFIRM'],
          createdPerms['DORM_INVOICE_DELETE'],
          createdPerms['DORM_VIOLATION_READ'],
          createdPerms['DORM_VIOLATION_CREATE'],
          createdPerms['DORM_VIOLATION_HANDLE'],
          createdPerms['DORM_MAINT_READ'],
          createdPerms['DORM_MAINT_CREATE'],
          createdPerms['DORM_MAINT_ASSIGN'],
          createdPerms['DORM_MAINT_COMPLETE'],
          createdPerms['DORM_REPORT_READ'],
          createdPerms['DORM_QR_CHECKIN'],
        ],
      },
      {
        constant: PROPOSED_PERMISSION_GROUP,
        permissions: [],
      },
      {
        constant: TIMETABLE_MANAGER_GROUP,
        permissions: [
          createdPerms['TIMETABLE_PAGE'],
          createdPerms['TIMETABLE_READ'],
          createdPerms['TIMETABLE_SYNC'],
          createdPerms['TIMETABLE_SETTINGS_READ'],
          createdPerms['TIMETABLE_SETTINGS_UPDATE'],
          createdPerms['TIMETABLE_SNAPSHOT_READ'],
        ],
      },
    ];

    await Promise.all(
      groups.map((g) => {
        const validPerms = g.permissions.filter((p) => !!p);
        return this.permissionGroupModel
          .findOneAndUpdate(
            { code: g.constant.code },
            {
              $set: {
                code: g.constant.code,
                name: g.constant.name,
                description: g.constant.description,
              },
              $addToSet: {
                permissions: { $each: validPerms },
              },
            },
            { upsert: true },
          )
          .exec();
      }),
    );

    // Reconcile only the canonical record permissions moved out of G_GRADING.
    // Roles and users are intentionally untouched: groups are metadata only.
    const studentRecordPermissionIds = [
      'READ_STUDENT_RECORD',
      'CREATE_STUDENT_RECORD',
      'UPDATE_STUDENT_RECORD',
      'DELETE_STUDENT_RECORD',
      'READ_CLASS_RECORD',
      'READ_ALL_CLASS_RECORD',
      'CREATE_CLASS_RECORD',
      'UPDATE_CLASS_RECORD',
      'DELETE_CLASS_RECORD',
    ]
      .map((code) => createdPerms[code])
      .filter(Boolean);
    if (studentRecordPermissionIds.length > 0) {
      await Promise.all([
        this.permissionGroupModel
          .updateOne(
            { code: GRADING_MANAGER_GROUP.code },
            { $pull: { permissions: { $in: studentRecordPermissionIds } } },
          )
          .exec(),
        this.permissionGroupModel
          .updateOne(
            { code: STUDENT_RECORD_GROUP.code },
            { $addToSet: { permissions: { $each: studentRecordPermissionIds } } },
          )
          .exec(),
      ]);
    }

    // Seed default route permissions
    const permMap = createdPerms;

    const routeMappings = [
      {
        route_path: '/system',
        route_name: 'Quản trị vận hành hệ thống',
        description: 'Lịch sử đăng nhập, request vận hành và backup database',
        permissions: [permMap['SYSTEM_ADMIN']],
        check_type: 'any',
        is_active: true,
        type: 'page',
      },
      {
        route_path: '/students/record',
        route_name: 'Ghi nhận rèn luyện HSSV',
        description: 'Ghi nhận cá nhân và lớp học theo permission scope hiện hành',
        permissions: [permMap['READ_STUDENT_RECORD']],
        check_type: 'any',
        is_active: true,
        type: 'page',
      },
      {
        route_path: '/students/tasks',
        route_name: 'Nhiệm vụ HSSV',
        description: 'Danh sách và tiến độ nhiệm vụ HSSV',
        permissions: [permMap['READ_STUDENT_TASK']],
        check_type: 'any',
        is_active: true,
        type: 'page',
      },
      {
        route_path: '/dormitory',
        route_name: 'Quản lý ký túc xá',
        description: 'Quản lý phòng, đăng ký lưu trú, hóa đơn và vận hành KTX',
        permissions: [permMap['DORM_PAGE']],
        check_type: 'any',
        is_active: true,
        type: 'page',
      },
      {
        route_path: '/permissions',
        route_name: 'Quản lý phân quyền (RBAC)',
        description: 'Quản lý vai trò, quyền, nhóm quyền và route mapping',
        permissions: [permMap['admin']],
        check_type: 'any',
        is_active: true,
        type: 'page',
      },
      {
        route_path: '/students',
        route_name: 'Quản lý sinh viên',
        description: 'Xem, thêm, sửa, xóa và quản lý hồ sơ sinh viên',
        permissions: [permMap['STUDENT_PAGE']],
        check_type: 'any',
        is_active: true,
        type: 'page',
      },
      {
        route_path: '/grading',
        route_name: 'Đánh giá điểm rèn luyện',
        description: 'Chấm điểm, duyệt điểm rèn luyện của sinh viên',
        permissions: [permMap['GRADING_PAGE']],
        check_type: 'any',
        is_active: true,
        type: 'page',
      },
      {
        route_path: '/activities',
        route_name: 'Quản lý hoạt động',
        description: 'Danh sách và chi tiết hoạt động ngoại khóa',
        permissions: [permMap['ACTIVITY_PAGE'], permMap['ACTIVITY_READ']],
        check_type: 'all',
        is_active: true,
        type: 'page',
      },
      {
        route_path: '/activities/schedule',
        route_name: 'Lịch hoạt động',
        description: 'Lịch sinh hoạt hoạt động',
        permissions: [permMap['ACTIVITY_SCHEDULE_READ']],
        check_type: 'any',
        is_active: true,
        type: 'page',
      },
      {
        route_path: '/activities/attendance',
        route_name: 'Điểm danh hoạt động',
        description: 'Điểm danh và các phiên điểm danh hoạt động',
        permissions: [permMap['ACTIVITY_ATTENDANCE_READ']],
        check_type: 'any',
        is_active: true,
        type: 'page',
      },
      {
        route_path: '/reports',
        route_name: 'Báo cáo thống kê',
        description: 'Xem các biểu đồ báo cáo và thống kê dữ liệu',
        permissions: [permMap['REPORTS_PAGE']],
        check_type: 'any',
        is_active: true,
        type: 'page',
      },
      {
        route_path: '/timetable',
        route_name: 'Thời khóa biểu',
        description: 'Tra cứu, đồng bộ và cấu hình thời khóa biểu',
        permissions: [permMap['TIMETABLE_PAGE']],
        check_type: 'all',
        is_active: true,
        type: 'page',
      },
    ];

    await Promise.all(
      routeMappings.map((mapping) => {
        const validPerms = mapping.permissions.filter((p) => p);
        if (validPerms.length === 0) return Promise.resolve();

        return this.routePermissionModel
          .findOneAndUpdate(
            { route_path: mapping.route_path },
            {
              $set: {
                route_path: mapping.route_path,
                route_name: mapping.route_name,
                description: mapping.description,
                check_type: mapping.check_type,
                is_active: mapping.is_active,
                type: mapping.type,
              },
              $setOnInsert: {
                permissions: validPerms,
              },
            },
            { upsert: true },
          )
          .exec();
      }),
    );

    // Dọn dẹp nhóm G_UNGROUPED: loại bỏ các quyền đã được phân vào nhóm nghiệp vụ khác
    try {
      const otherGroups = await this.permissionGroupModel
        .find({ code: { $ne: 'G_UNGROUPED' } })
        .exec();
      const groupedPermissionIds = otherGroups.reduce((acc, g) => {
        return acc.concat(g.permissions.map((p) => p.toString()));
      }, [] as string[]);

      if (groupedPermissionIds.length > 0) {
        await this.permissionGroupModel
          .updateOne(
            { code: 'G_UNGROUPED' },
            {
              $pull: {
                permissions: {
                  $in: groupedPermissionIds.map((id) => new Types.ObjectId(id)),
                },
              },
            },
          )
          .exec();
        console.log('🧹 Cleaned up G_UNGROUPED permissions successfully');
      }
    } catch (err) {
      console.error('Failed to cleanup G_UNGROUPED:', err);
    }

    // Clean up old /settings route mapping if any
    await this.routePermissionModel
      .deleteOne({ route_path: '/settings' })
      .exec();

    console.log('✅ RBAC Data Seeded Successfully');
  }

  private async seedDeclaredPermissions() {
    const group = await this.permissionGroupModel
      .findOneAndUpdate(
        {
          $or: [
            { code: UNGROUPED_PERMISSION_GROUP.code },
            { name: UNGROUPED_PERMISSION_GROUP.name },
          ],
        },
        {
          $set: UNGROUPED_PERMISSION_GROUP,
          $setOnInsert: { permissions: [] },
        },
        { upsert: true, returnDocument: 'after' },
      )
      .exec();

    const permissionIds: Types.ObjectId[] = [];

    const permissions = await Promise.all(
      DECLARED_PERMISSION_SEEDS.map((permissionSeed) =>
        this.permissionModel
          .findOneAndUpdate(
            { code: permissionSeed.code },
            { $set: permissionSeed },
            { upsert: true, returnDocument: 'after' },
          )
          .exec(),
      ),
    );
    permissionIds.push(...permissions.map((permission) => permission._id));

    if (permissionIds.length > 0) {
      await this.permissionGroupModel
        .updateOne(
          { _id: group._id },
          { $addToSet: { permissions: { $each: permissionIds } } },
        )
        .exec();
    }

    console.log(
      `✅ Declared permissions synced to "${UNGROUPED_PERMISSION_GROUP.name}" group`,
    );
  }

  private async seedSystemAdmin() {
    const adminEmail = (
      process.env.SYSTEM_ADMIN_EMAIL ||
      this.configService?.get<string>('SYSTEM_ADMIN_EMAIL') ||
      ''
    )
      .trim()
      .toLowerCase();
    const adminPassword =
      process.env.SYSTEM_ADMIN_PASSWORD ||
      this.configService?.get<string>('SYSTEM_ADMIN_PASSWORD');
    const adminUsername =
      (
        process.env.SYSTEM_ADMIN_USERNAME ||
        this.configService?.get<string>('SYSTEM_ADMIN_USERNAME') ||
        ''
      ).trim() ||
      adminEmail?.split('@')[0] ||
      'system_admin';

    if (!adminEmail && !adminPassword) {
      return;
    }

    if (!adminEmail || !adminPassword) {
      throw new Error(
        'SYSTEM_ADMIN_EMAIL and SYSTEM_ADMIN_PASSWORD must be configured together',
      );
    }

    if (adminPassword.length < 8) {
      throw new Error('SYSTEM_ADMIN_PASSWORD must be at least 8 characters');
    }

    const adminRole =
      (await this.roleModel.findOne({ role_code: 'ADMIN' }).exec()) ||
      (await this.roleModel.findOne({ name: 'Admin' }).exec());

    if (!adminRole) {
      throw new Error('Admin role was not seeded before system admin creation');
    }

    try {
      const allPermissions = await (this.permissionModel as any).find();
      const permsList = Array.isArray(allPermissions)
        ? allPermissions
        : typeof allPermissions?.exec === 'function'
          ? await allPermissions.exec()
          : [];
      if (permsList && permsList.length > 0) {
        await (this.roleModel as any).updateOne(
          { _id: adminRole._id },
          {
            $addToSet: {
              permissions: { $each: permsList.map((p: any) => p._id) },
            },
          },
        );
      }
    } catch {
      // Best-effort permission sync
    }

    const existingAdmin = await this.userModel
      .findOne({
        $or: [{ email: adminEmail }, { user_name: adminUsername }],
      })
      .exec();

    if (existingAdmin) {
      let changed = false;

      if (adminUsername && existingAdmin.user_name !== adminUsername) {
        existingAdmin.user_name = adminUsername;
        changed = true;
      }

      if (adminEmail && existingAdmin.email !== adminEmail) {
        existingAdmin.email = adminEmail;
        changed = true;
      }

      if (
        !existingAdmin.role ||
        existingAdmin.role.toString() !== adminRole._id.toString()
      ) {
        existingAdmin.role = adminRole._id;
        changed = true;
      }

      const existingRoles = Array.isArray(existingAdmin.roles)
        ? existingAdmin.roles.map((r: any) => r.toString())
        : [];
      if (!existingRoles.includes(adminRole._id.toString())) {
        existingAdmin.roles = [adminRole._id];
        changed = true;
      }

      if (existingAdmin.status !== UserStatus.ACTIVE) {
        existingAdmin.status = UserStatus.ACTIVE;
        existingAdmin.failed_login_attempts = 0;
        existingAdmin.locked_until = null;
        changed = true;
      }

      const passwordHash =
        existingAdmin.pw_hash || (existingAdmin as any).password_hash;
      const isPasswordValid = passwordHash
        ? await this.passwordService.comparePassword(adminPassword, passwordHash)
        : false;

      if (!isPasswordValid) {
        existingAdmin.pw_hash = await this.passwordService.hashPassword(
          adminPassword,
        );
        changed = true;
      }

      if (changed) {
        await existingAdmin.save();
      }

      console.log('✅ System admin account verified');
      return;
    }

    const pw_hash = await this.passwordService.hashPassword(adminPassword);

    await this.userModel.create({
      user_name: adminUsername,
      email: adminEmail,
      pw_hash,
      status: UserStatus.ACTIVE,
      role: adminRole._id,
      roles: [adminRole._id],
      failed_login_attempts: 0,
      locked_until: null,
    });

    console.log('✅ System admin account seeded');
  }

  private async migrateLegacyRoles() {
    const adminRole = await this.roleModel.findOne({ name: 'Admin' });
    const userRole = await this.roleModel.findOne({ name: 'User' });

    const usersToFix = await (this.userModel as any).find({
      role: { $not: { $type: 'objectId' } },
    });

    if (usersToFix.length > 0) {
      for (const user of usersToFix) {
        const roleStr = String(user.role).toLowerCase();
        if (roleStr === 'admin' && adminRole) {
          user.role = adminRole._id;
        } else if (roleStr === 'user' && userRole) {
          user.role = userRole._id;
        } else if (userRole) {
          user.role = userRole._id;
        }
        try {
          await user.save();
        } catch (error: any) {
          if (error.name === 'DocumentNotFoundError') {
            await this.userModel.updateOne(
              { _id: user._id },
              { $set: { role: user.role } },
            );
          } else {
            throw error;
          }
        }
      }
      console.log(`✅ Successfully migrated ${usersToFix.length} users.`);
    }
  }

  private async migrateLegacyUserFields() {
    const usersToFix = await this.userModel
      .find({
        $or: [
          { pw_hash: { $exists: false } },
          { user_name: { $exists: false } },
        ],
      } as any)
      .lean();

    if (usersToFix.length > 0) {
      let migratedCount = 0;
      for (const rawUser of usersToFix) {
        const updateDoc: any = {};
        const legacyUser = rawUser as any;

        if (!legacyUser.pw_hash && legacyUser.password_hash) {
          updateDoc.pw_hash = legacyUser.password_hash;
        }
        if (!legacyUser.user_name && legacyUser.username) {
          updateDoc.user_name = legacyUser.username;
        }

        if (Object.keys(updateDoc).length > 0) {
          await this.userModel.updateOne(
            { _id: rawUser._id },
            {
              $set: updateDoc,
              $unset: { username: '', password_hash: '' },
            },
          );
          migratedCount++;
        }
      }
      if (migratedCount > 0) {
        console.log(
          `✅ Successfully migrated fields (pw_hash/user_name) for ${migratedCount} legacy users.`,
        );
      }
    }

    const cleanupResult = await this.userModel.updateMany(
      {
        $or: [
          { username: { $exists: true } },
          { password_hash: { $exists: true } },
        ],
      } as any,
      {
        $unset: { username: '', password_hash: '' },
      },
    );
    if (cleanupResult.modifiedCount > 0) {
      console.log(
        `🧹 Cleaned up legacy fields (username/password_hash) for ${cleanupResult.modifiedCount} users.`,
      );
    }
  }

  private async deduplicateRbacReferences() {
    try {
      const allPerms = await this.permissionModel.find({}, { _id: 1 }).exec();
      const validPermIds = new Set(allPerms.map((p) => p._id.toString()));

      const groups = await this.permissionGroupModel.find({}).exec();
      for (const group of groups) {
        if (group.permissions && Array.isArray(group.permissions)) {
          const uniqueIds = [];
          const seen = new Set();
          for (const p of group.permissions) {
            if (!p) continue;
            const idStr = p.toString();
            if (validPermIds.has(idStr) && !seen.has(idStr)) {
              seen.add(idStr);
              uniqueIds.push(p);
            }
          }
          if (uniqueIds.length !== group.permissions.length) {
            group.permissions = uniqueIds as any;
            await this.safeSave(group);
            console.log(
              `🧹 Deduplicated & cleaned permissions for group: ${group.name} (${group.code})`,
            );
          }
        }
      }

      const roles = await this.roleModel.find({}).exec();
      for (const role of roles) {
        if (role.permissions && Array.isArray(role.permissions)) {
          const uniqueIds = [];
          const seen = new Set();
          for (const p of role.permissions) {
            if (!p) continue;
            const idStr = p.toString();
            if (validPermIds.has(idStr) && !seen.has(idStr)) {
              seen.add(idStr);
              uniqueIds.push(p);
            }
          }
          if (uniqueIds.length !== role.permissions.length) {
            role.permissions = uniqueIds as any;
            await this.safeSave(role);
            console.log(
              `🧹 Deduplicated & cleaned permissions for role: ${role.name} (${role.role_code})`,
            );
          }
        }
      }
    } catch (err) {
      console.error('Failed to deduplicate RBAC references:', err);
    }
  }
}
