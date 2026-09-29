import {
  Controller,
  Post,
  Get,
  Patch,
  Delete,
  Body,
  UseGuards,
  Req,
  HttpCode,
  HttpStatus,
  Param,
  Res,
  UnauthorizedException,
  ForbiddenException,
} from '@nestjs/common';
import type { CookieOptions, Response, Request } from 'express';
import {
  ApiTags,
  ApiOperation,
  ApiBearerAuth,
  ApiParam,
} from '@nestjs/swagger';
import { AuthService } from '../services/auth.service';
import { SessionService } from '../services/session.service';
import { ImpersonationService } from '../services/impersonation.service';
import { JwtAuthGuard } from '../guards/jwt-auth.guard';
import { PermissionsGuard } from '../guards/permissions.guard';
import { Permissions } from '../decorators/permissions.decorator';
import {
  RegisterDto,
  LoginDto,
  ForgotPasswordDto,
  ResetPasswordDto,
  ChangePasswordDto,
  CreateRoleDto,
  UpdateRoleDto,
  AssignRoleDto,
  CreatePermissionDto,
  UpdatePermissionDto,
  CreatePermissionGroupDto,
  UpdatePermissionGroupDto,
  CreateRoutePermissionDto,
  UpdateRoutePermissionDto,
  UpdateUserDto,
  UpdateMeDto,
  CreateUserDto,
  BulkCreateUsersDto,
  PasswordResetRequestDto,
  PasswordResetResendDto,
  PasswordResetVerifyDto,
  PasswordResetCompleteDto,
  CreateImpersonationDto,
  CancelImpersonationDto,
  TerminateImpersonationDto,
} from '../dto/auth.dto';

import { isAdminUser } from '../utils/role.util';
import { StrictAdminGuard } from '../guards/strict-admin.guard';
import { PERMISSION_POLICIES } from '../permissions.registry';

const REFRESH_COOKIE_NAME = 'refresh_token';
const SESSION_ID_HEADER = 'x-auth-session-id';
const REFRESH_COOKIE_PATH = '/api/auth';

function getSessionId(req: Request): string | undefined {
  const value = req.headers?.[SESSION_ID_HEADER];
  const id = Array.isArray(value) ? value[0] : value;
  return typeof id === 'string' && /^[A-Za-z0-9_-]{16,64}$/.test(id)
    ? id
    : undefined;
}

function getRefreshCookieName(sessionId?: string): string {
  return sessionId
    ? `${REFRESH_COOKIE_NAME}_${sessionId}`
    : REFRESH_COOKIE_NAME;
}

function getRefreshCookieOptions(maxAge?: number): CookieOptions {
  const secureEnv = process.env.AUTH_COOKIE_SECURE;
  const secure =
    secureEnv === 'true'
      ? true
      : secureEnv === 'false'
        ? false
        : process.env.NODE_ENV === 'production';

  return {
    httpOnly: true,
    secure,
    sameSite: secure ? 'none' : 'lax',
    path: REFRESH_COOKIE_PATH,
    ...(typeof maxAge === 'number' ? { maxAge } : {}),
  };
}

@ApiTags('Authentication & RBAC')
@Controller('auth')
export class AuthController {
  constructor(private readonly authService: AuthService,
    private readonly sessions: SessionService,
    private readonly impersonations: ImpersonationService) {}

  // ─── AUTHENTICATION ─────────────────────────────────────────

  @Post('register')
  @HttpCode(HttpStatus.CREATED)
  @ApiOperation({ summary: 'Register a new account' })
  async register(@Body() dto: RegisterDto) {
    return this.authService.register(dto);
  }

  @Post('login')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Login with email and password' })
  async login(
    @Body() dto: LoginDto,
    @Req() req: any,
    @Res({ passthrough: true }) res: Response,
  ) {
    const ip = req.ip || req.headers?.['x-forwarded-for'] || '0.0.0.0';
    const agent = String(req.headers?.['user-agent'] || '');
    const browser = /Edg\//.test(agent) ? 'Edge' : /Firefox\//.test(agent) ? 'Firefox' : /Chrome\//.test(agent) ? 'Chrome' : /Safari\//.test(agent) ? 'Safari' : 'Trình duyệt';
    const device = /Android|iPhone|iPad|Mobile/.test(agent) ? 'di động' : 'máy tính';
    const result = await this.authService.login(dto, ip, `${browser} - ${device}`);
    if (dto.previous_session_id) {
      const previousCookie = getRefreshCookieName(dto.previous_session_id);
      const previousToken = req.cookies?.[previousCookie];
      if (previousToken) await this.authService.revokeToken(previousToken, ip);
      res.clearCookie(previousCookie, getRefreshCookieOptions());
    }

    // The service owns the session policy; the cookie mirrors its result.
    const cookieMaxAge =
      result.remember && result.expires_at
        ? Math.max(0, new Date(result.expires_at).getTime() - Date.now())
        : undefined;

    res.cookie(
      getRefreshCookieName(getSessionId(req)),
      result.refresh_token,
      getRefreshCookieOptions(cookieMaxAge),
    );

    // Don't send RT back in body for security
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    const { refresh_token, ...response } = result;
    return response;
  }

  @Post('forgot-password')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Request a password reset link' })
  async forgotPassword(@Body() dto: ForgotPasswordDto, @Req() req: any) {
    const ip = req.ip || req.headers?.['x-forwarded-for'] || '0.0.0.0';
    return this.authService.forgotPassword(dto, ip);
  }

  @Post('reset-password')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Reset password using a token' })
  async resetPassword(@Body() dto: ResetPasswordDto, @Req() req: any) {
    const ip = req.ip || req.headers?.['x-forwarded-for'] || '0.0.0.0';
    return this.authService.resetPassword(dto, ip);
  }

  @Post('password-reset/request')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Yêu cầu đặt lại mật khẩu bằng OTP' })
  async requestPasswordReset(
    @Body() dto: PasswordResetRequestDto,
    @Req() req: any,
  ) {
    const ip = req.ip || req.headers?.['x-forwarded-for'] || '0.0.0.0';
    return this.authService.requestPasswordReset(dto, ip);
  }

  @Post('password-reset/resend')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Gửi lại OTP đặt lại mật khẩu' })
  async resendPasswordResetOtp(@Body() dto: PasswordResetResendDto) {
    return this.authService.resendPasswordResetOtp(dto);
  }

  @Post('password-reset/verify')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Xác minh OTP đặt lại mật khẩu' })
  async verifyPasswordResetOtp(@Body() dto: PasswordResetVerifyDto) {
    return this.authService.verifyPasswordResetOtp(dto);
  }

  @Post('password-reset/complete')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Hoàn thành đặt lại mật khẩu với reset token' })
  async completePasswordReset(@Body() dto: PasswordResetCompleteDto) {
    return this.authService.completePasswordReset(dto);
  }

  @Post('change-password')
  @HttpCode(HttpStatus.OK)
  @UseGuards(JwtAuthGuard)
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Change password' })
  async changePassword(@Body() dto: ChangePasswordDto, @Req() req: any) {
    const ip = req.ip || req.headers?.['x-forwarded-for'] || '0.0.0.0';
    const userId = req.user.userId;
    return this.authService.changePassword(userId, dto, ip);
  }

  @Post('refresh')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Refresh access token' })
  async refreshToken(
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ) {
    const cookieName = getRefreshCookieName(getSessionId(req));
    const token = req.cookies?.[cookieName];

    if (!token) {
      throw new UnauthorizedException('Phiên làm việc đã kết thúc');
    }

    try {
      const result = await this.authService.refreshToken(token);

      // Respect remember flag: session cookie if not remembered, persistent if remembered
      const maxAge = result.remember
        ? Math.max(0, new Date(result.expires_at).getTime() - Date.now())
        : undefined; // session cookie — cleared when browser closes

      // Rotate Cookie
      res.cookie(
        cookieName,
        result.refresh_token,
        getRefreshCookieOptions(maxAge),
      );

      return { access_token: result.access_token };
    } catch (error) {
      if (error instanceof UnauthorizedException) {
        res.clearCookie(cookieName, getRefreshCookieOptions());
      }
      throw error;
    }
  }

  @Post('session/fork')
  @HttpCode(HttpStatus.OK)
  @UseGuards(JwtAuthGuard)
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Fork the current browser session' })
  async forkSession(
    @Req() req: any,
    @Body() body: { session_id?: string; remember?: boolean },
    @Res({ passthrough: true }) res: Response,
  ) {
    if (req.user.impersonationSessionId) {
      throw new UnauthorizedException(
        'Không thể nhân bản một phiên truy cập quản trị',
      );
    }
    const sessionId = body?.session_id;
    if (!sessionId || !/^[A-Za-z0-9_-]{16,64}$/.test(sessionId)) {
      throw new UnauthorizedException('Invalid auth session id');
    }
    const result = await this.authService.forkSession(
      req.user.userId,
      body.remember !== false,
    );
    const maxAge = result.remember
      ? Math.max(0, new Date(result.expires_at).getTime() - Date.now())
      : undefined;
    res.cookie(
      getRefreshCookieName(sessionId),
      result.refresh_token,
      getRefreshCookieOptions(maxAge),
    );
    return { access_token: result.access_token, remember: result.remember };
  }

  @Post('impersonations')
  @HttpCode(HttpStatus.OK)
  @UseGuards(JwtAuthGuard, StrictAdminGuard)
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Access an active non-admin user as an admin' })
  async createImpersonation(
    @Req() req: any,
    @Body() dto: CreateImpersonationDto,
    @Res({ passthrough: true }) res: Response,
  ) {
    const rawIp = req.ip || req.headers?.['x-forwarded-for'] || '0.0.0.0';
    const ip = Array.isArray(rawIp) ? rawIp[0] : rawIp;
    const result = await this.authService.createImpersonation(
      req.user.userId,
      dto.target_user_id,
      dto.session_id,
      ip,
      req.user.sessionId,
    );
    const maxAge = Math.max(
      0,
      new Date(result.impersonation.expires_at).getTime() - Date.now(),
    );
    res.cookie(
      getRefreshCookieName(dto.session_id),
      result.refresh_token,
      getRefreshCookieOptions(maxAge),
    );
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    const { refresh_token, ...response } = result;
    return response;
  }

  @Post('impersonations/cancel')
  @HttpCode(HttpStatus.OK)
  @UseGuards(JwtAuthGuard, StrictAdminGuard)
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Cancel an impersonation handoff' })
  async cancelImpersonation(
    @Req() req: any,
    @Body() dto: CancelImpersonationDto,
    @Res({ passthrough: true }) res: Response,
  ) {
    const rawIp = req.ip || req.headers?.['x-forwarded-for'] || '0.0.0.0';
    const ip = Array.isArray(rawIp) ? rawIp[0] : rawIp;
    const result = await this.authService.cancelImpersonation(
      req.user.userId,
      dto.session_id,
      ip,
    );
    res.clearCookie(
      getRefreshCookieName(dto.session_id),
      getRefreshCookieOptions(),
    );
    return result;
  }

  @Post('impersonations/terminate')
  @HttpCode(HttpStatus.OK)
  @UseGuards(JwtAuthGuard, StrictAdminGuard)
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Terminate an active impersonation session' })
  async terminateImpersonation(
    @Req() req: any,
    @Body() dto: TerminateImpersonationDto,
  ) {
    const rawIp = req.ip || req.headers?.['x-forwarded-for'] || '0.0.0.0';
    const ip = Array.isArray(rawIp) ? rawIp[0] : rawIp;
    return this.authService.terminateImpersonation(
      dto.target_user_id,
      ip,
    );
  }

  @Post('logout')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Logout and clear session' })
  async logout(@Req() req: Request, @Res({ passthrough: true }) res: Response) {
    const cookieName = getRefreshCookieName(getSessionId(req));
    const token = req.cookies?.[cookieName];
    const rawIp = req.ip || req.headers?.['x-forwarded-for'] || '0.0.0.0';
    const ip = Array.isArray(rawIp) ? rawIp[0] : rawIp;
    if (token) {
      await this.authService.revokeToken(token, ip);
    }
    res.clearCookie(cookieName, getRefreshCookieOptions());
    return { message: 'Logged out successfully' };
  }

  // ─── CURRENT USER PROFILE ──────────────────────

  @Get('me')
  @UseGuards(JwtAuthGuard)
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Get current user profile with permissions' })
  async getMe(@Req() req: any) {
    const me = await this.authService.getMe(req.user.userId);
    if (!req.user.impersonationSessionId) return me;
    const lease = await this.impersonations.validateSession(req.user.impersonationSessionId, req.user.userId, req.user.actorUserId);
    return { ...me, impersonation: { id: lease._id.toString(), expires_at: lease.expires_at } };
  }

  private requireOrdinarySession(req: any) {
    if (req.user.impersonationSessionId) throw new ForbiddenException('Phiên truy cập không được quản lý thiết bị');
  }

  @Get('sessions')
  @UseGuards(JwtAuthGuard)
  async listSessions(@Req() req: any) {
    this.requireOrdinarySession(req);
    return this.sessions.list(req.user.userId, req.user.sessionId);
  }

  @Delete('sessions/:id')
  @UseGuards(JwtAuthGuard)
  async revokeSession(@Req() req: any, @Param('id') id: string) {
    this.requireOrdinarySession(req);
    return this.sessions.revokeOwned(req.user.userId, id);
  }

  @Post('sessions/revoke-others')
  @HttpCode(HttpStatus.OK)
  @UseGuards(JwtAuthGuard)
  async revokeOtherSessions(@Req() req: any) {
    this.requireOrdinarySession(req);
    return this.sessions.revokeOthers(req.user.userId, req.user.sessionId);
  }

  @Patch('me')
  @UseGuards(JwtAuthGuard)
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Update current user profile' })
  async updateMe(@Req() req: any, @Body() dto: UpdateMeDto) {
    return this.authService.updateMe(req.user.userId, dto);
  }

  @Get('permission-policies')
  @UseGuards(JwtAuthGuard, PermissionsGuard)
  @Permissions('admin')
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Get canonical permission dependencies and owners' })
  getPermissionPolicies() {
    return PERMISSION_POLICIES;
  }

  // ─── ROLE & PERMISSION MANAGEMENT (ADMIN ONLY) ──────────────

  @Get('roles')
  @UseGuards(JwtAuthGuard, PermissionsGuard)
  @Permissions('admin')
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Get all roles (Admin only)' })
  async getRoles() {
    return this.authService.getRoles();
  }

  @Get('permissions')
  @UseGuards(JwtAuthGuard, PermissionsGuard)
  @Permissions('admin')
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Get all permissions (Admin only)' })
  async getPermissions() {
    return this.authService.getPermissions();
  }

  @Post('permissions')
  @UseGuards(JwtAuthGuard, PermissionsGuard)
  @Permissions('admin', 'PERMISSION_CREATE')
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Create a new permission (Admin only)' })
  async createPermission(@Body() dto: CreatePermissionDto) {
    return this.authService.createPermission(dto);
  }

  @Patch('permissions/:id')
  @UseGuards(JwtAuthGuard, PermissionsGuard)
  @Permissions('admin', 'PERMISSION_UPDATE')
  @ApiBearerAuth()
  @ApiParam({ name: 'id', description: 'Permission ID' })
  @ApiOperation({ summary: 'Update a permission (Admin only)' })
  async updatePermission(
    @Param('id') id: string,
    @Body() dto: UpdatePermissionDto,
  ) {
    return this.authService.updatePermission(id, dto);
  }

  @Delete('permissions/:id')
  @UseGuards(JwtAuthGuard, PermissionsGuard)
  @Permissions('admin', 'PERMISSION_DELETE')
  @ApiBearerAuth()
  @ApiParam({ name: 'id', description: 'Permission ID' })
  @ApiOperation({ summary: 'Delete a permission (Admin only)' })
  async deletePermission(@Param('id') id: string) {
    return this.authService.deletePermission(id);
  }

  // ─── PERMISSION GROUP MANAGEMENT (ADMIN ONLY) ──────────────

  @Get('permission-groups')
  @UseGuards(JwtAuthGuard, PermissionsGuard)
  @Permissions('admin')
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Get all permission groups (Admin only)' })
  async getPermissionGroups() {
    return this.authService.getPermissionGroups();
  }

  @Post('permission-groups')
  @UseGuards(JwtAuthGuard, PermissionsGuard)
  @Permissions('admin', 'PERMISSION_GROUP_CREATE')
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Create a new permission group (Admin only)' })
  async createPermissionGroup(@Body() dto: CreatePermissionGroupDto) {
    return this.authService.createPermissionGroup(dto);
  }

  @Patch('permission-groups/:id')
  @UseGuards(JwtAuthGuard, PermissionsGuard)
  @Permissions('admin', 'PERMISSION_GROUP_UPDATE')
  @ApiBearerAuth()
  @ApiParam({ name: 'id', description: 'Group ID' })
  @ApiOperation({ summary: 'Update a permission group (Admin only)' })
  async updatePermissionGroup(
    @Param('id') id: string,
    @Body() dto: UpdatePermissionGroupDto,
  ) {
    return this.authService.updatePermissionGroup(id, dto);
  }

  @Delete('permission-groups/:id')
  @UseGuards(JwtAuthGuard, PermissionsGuard)
  @Permissions('admin', 'PERMISSION_GROUP_DELETE')
  @ApiBearerAuth()
  @ApiParam({ name: 'id', description: 'Group ID' })
  @ApiOperation({ summary: 'Delete a permission group (Admin only)' })
  async deletePermissionGroup(@Param('id') id: string) {
    return this.authService.deletePermissionGroup(id);
  }

  @Post('roles')
  @UseGuards(JwtAuthGuard, PermissionsGuard)
  @Permissions('admin', 'ROLE_CREATE')
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Create a new role (Admin only)' })
  async createRole(@Body() dto: CreateRoleDto) {
    return this.authService.createRole(dto);
  }

  @Patch('roles/:id')
  @UseGuards(JwtAuthGuard, PermissionsGuard)
  @Permissions('admin', 'ROLE_UPDATE')
  @ApiBearerAuth()
  @ApiParam({ name: 'id', description: 'Role ID' })
  @ApiOperation({ summary: 'Update a role (Admin only)' })
  async updateRole(@Param('id') id: string, @Body() dto: UpdateRoleDto) {
    return this.authService.updateRole(id, dto);
  }

  @Delete('roles/:id')
  @UseGuards(JwtAuthGuard, PermissionsGuard)
  @Permissions('admin', 'ROLE_DELETE')
  @ApiBearerAuth()
  @ApiParam({ name: 'id', description: 'Role ID' })
  @ApiOperation({ summary: 'Delete a role (Admin only)' })
  async deleteRole(@Param('id') id: string) {
    return this.authService.deleteRole(id);
  }

  @Patch('users/:id/role')
  @UseGuards(JwtAuthGuard, PermissionsGuard)
  @Permissions('admin', 'USER_UPDATE')
  @ApiBearerAuth()
  @ApiParam({ name: 'id', description: 'User ID' })
  @ApiOperation({ summary: 'Assign a role to a user (Admin only)' })
  async assignRole(@Param('id') id: string, @Body() dto: AssignRoleDto) {
    return this.authService.assignRole(id, dto);
  }

  @Get('users')
  @UseGuards(JwtAuthGuard, PermissionsGuard)
  @Permissions('admin', 'view_users')
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Get all users (Admin only)' })
  async getUsers() {
    return this.authService.getUsers();
  }

  @Post('users')
  @UseGuards(JwtAuthGuard, PermissionsGuard)
  @Permissions('admin', 'USER_CREATE')
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Create a single user (Admin only)' })
  async createUser(@Body() dto: CreateUserDto, @Req() req: any) {
    const ip = req.ip || req.headers?.['x-forwarded-for'] || '0.0.0.0';
    return this.authService.createUser(dto, ip);
  }

  @Post('users/bulk-create')
  @UseGuards(JwtAuthGuard, PermissionsGuard)
  @Permissions('admin', 'USER_CREATE')
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Create multiple users (Admin only)' })
  async createUsersBulk(@Body() dto: BulkCreateUsersDto, @Req() req: any) {
    const ip = req.ip || req.headers?.['x-forwarded-for'] || '0.0.0.0';
    return this.authService.createUsersBulk(dto, ip);
  }

  @Patch('users/:id')
  @UseGuards(JwtAuthGuard, PermissionsGuard)
  @Permissions('admin', 'USER_UPDATE')
  @ApiBearerAuth()
  @ApiParam({ name: 'id', description: 'User ID' })
  @ApiOperation({ summary: 'Update a user (Admin only)' })
  async updateUser(
    @Param('id') id: string,
    @Body() dto: UpdateUserDto,
    @Req() req: any,
  ) {
    const ip = req.ip || req.headers?.['x-forwarded-for'] || '0.0.0.0';
    const currentSessionId = req.user?.sessionId;
    return this.authService.updateUser(id, dto, ip, currentSessionId);
  }

  @Delete('users/:id')
  @UseGuards(JwtAuthGuard, PermissionsGuard)
  @Permissions('admin', 'USER_DELETE')
  @ApiBearerAuth()
  @ApiParam({ name: 'id', description: 'User ID' })
  @ApiOperation({ summary: 'Delete a user (Admin only)' })
  async deleteUser(@Param('id') id: string) {
    return this.authService.deleteUser(id);
  }

  @Post('users/bulk-delete')
  @UseGuards(JwtAuthGuard, PermissionsGuard)
  @Permissions('admin', 'USER_DELETE')
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Delete multiple users (Admin only)' })
  async deleteUsersBulk(@Body('userIds') userIds: string[]) {
    return this.authService.deleteUsersBulk(userIds);
  }

  // ─── ROUTE PERMISSION MANAGEMENT (ADMIN ONLY) ─────────

  @Get('page-permission-scopes')
  @UseGuards(JwtAuthGuard)
  @ApiBearerAuth()
  @ApiOperation({
    summary: 'Get all page-permission action scopes (requires login)',
  })
  async getPagePermissionScopes() {
    return this.authService.getPagePermissionScopes();
  }

  @Get('route-permissions/all')
  @UseGuards(JwtAuthGuard)
  @ApiBearerAuth()
  @ApiOperation({
    summary:
      'Get all route-permission mappings (requires login for RouteGuard)',
  })
  async getRoutePermissionsPublic() {
    const list = await this.authService.getRoutePermissions();
    return list.map((item: any) => ({
      route_path: item.route_path,
      permissions: item.permissions?.map((p: any) => p.code) || [],
      check_type: item.check_type,
      type: item.type,
      is_active: item.is_active,
    }));
  }

  @Get('route-permissions')
  @UseGuards(JwtAuthGuard, PermissionsGuard)
  @Permissions('admin')
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Get all route-permission mappings (Admin only)' })
  async getRoutePermissions() {
    return this.authService.getRoutePermissions();
  }

  @Get('route-permissions/check')
  @UseGuards(JwtAuthGuard)
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Check permission for a specific route' })
  async checkRoutePermission(@Req() req: any) {
    const routePath = req.query.route as string;
    if (!routePath) return { allowed: true };

    const mapping = await this.authService.getRoutePermissionByRoute(routePath);
    if (!mapping)
      return { allowed: true, message: 'Route không được cấu hình' };

    const user = req.user;
    if (isAdminUser(user)) return { allowed: true };

    const userPermissions: string[] = user.permissions || [];
    const requiredCodes = (mapping.permissions as any[]).map(
      (p: any) => p.code,
    );

    const allowed =
      mapping.check_type === 'any'
        ? requiredCodes.some((code) => userPermissions.includes(code))
        : requiredCodes.every((code) => userPermissions.includes(code));

    return {
      allowed,
      route: routePath,
      required: requiredCodes,
      check_type: mapping.check_type,
    };
  }

  @Post('route-permissions')
  @UseGuards(JwtAuthGuard, PermissionsGuard)
  @Permissions('admin', 'ROUTE_PERMISSION_CREATE')
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Create a route-permission mapping (Admin only)' })
  async createRoutePermission(@Body() dto: CreateRoutePermissionDto) {
    return this.authService.createRoutePermission(dto);
  }

  @Patch('route-permissions/:id')
  @UseGuards(JwtAuthGuard, PermissionsGuard)
  @Permissions('admin', 'ROUTE_PERMISSION_UPDATE')
  @ApiBearerAuth()
  @ApiParam({ name: 'id', description: 'Route Permission ID' })
  @ApiOperation({ summary: 'Update a route-permission mapping (Admin only)' })
  async updateRoutePermission(
    @Param('id') id: string,
    @Body() dto: UpdateRoutePermissionDto,
  ) {
    return this.authService.updateRoutePermission(id, dto);
  }

  @Delete('route-permissions/:id')
  @UseGuards(JwtAuthGuard, PermissionsGuard)
  @Permissions('admin', 'ROUTE_PERMISSION_DELETE')
  @ApiBearerAuth()
  @ApiParam({ name: 'id', description: 'Route Permission ID' })
  @ApiOperation({ summary: 'Delete a route-permission mapping (Admin only)' })
  async deleteRoutePermission(@Param('id') id: string) {
    return this.authService.deleteRoutePermission(id);
  }
}
