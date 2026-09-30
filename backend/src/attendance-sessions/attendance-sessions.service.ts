import {
  Injectable,
  NotFoundException,
  BadRequestException,
  ForbiddenException,
  Optional,
  Logger,
} from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model, Types } from 'mongoose';
import { v4 as uuidv4 } from 'uuid';
import {
  AttendanceSession,
  AttendanceSessionDocument,
} from './schemas/attendance-session.schema';
import {
  AttendanceCheckin,
  AttendanceCheckinDocument,
} from './schemas/attendance-checkin.schema';
import { OpenSessionDto } from './dto/open-session.dto';
import { CheckinQrDto } from './dto/checkin-qr.dto';
import { CheckinProximityDto } from './dto/checkin-proximity.dto';
import {
  ActivityAttendance,
  ActivityAttendanceDocument,
} from '../activity-attendance/schemas/activity-attendance.schema';
import {
  ActivityMember,
  ActivityMemberDocument,
} from '../activities/schemas/activity-member.schema';
import {
  ActivitySchedule,
  ActivityScheduleDocument,
} from '../activity-schedules/schemas/activity-schedule.schema';
import { Student, StudentDocument } from '../students/schemas/student.schema';
import { Activity, ActivityDocument } from '../activities/schemas/activity.schema';
import { ActivityAttendanceSyncService } from '../activity-attendance/activity-attendance-sync.service';
import {
  AttendanceRealtimeEvent,
  attendanceEventEmitter,
} from '../system/attendance-event-emitter';
import { ActivityAttendanceGrantsService } from '../activities/activity-attendance-grants.service';

@Injectable()
export class AttendanceSessionsService {
  private readonly logger = new Logger(AttendanceSessionsService.name);

  constructor(
    @InjectModel(AttendanceSession.name)
    private sessionModel: Model<AttendanceSessionDocument>,
    @InjectModel(AttendanceCheckin.name)
    private checkinModel: Model<AttendanceCheckinDocument>,
    @InjectModel(ActivityAttendance.name)
    private clubAttendanceModel: Model<ActivityAttendanceDocument>,
    @InjectModel(ActivityMember.name)
    private clubMemberModel: Model<ActivityMemberDocument>,
    @InjectModel(ActivitySchedule.name)
    private scheduleModel: Model<ActivityScheduleDocument>,
    @InjectModel(Student.name)
    private studentModel: Model<StudentDocument>,
    private activityAttendanceSyncService: ActivityAttendanceSyncService,
    private attendanceGrantsService: ActivityAttendanceGrantsService,
    @Optional()
    @InjectModel(Activity.name)
    private activityModel?: Model<ActivityDocument>,
  ) {}

  // ── Open Session ──

  async openSession(
    dto: OpenSessionDto,
    userId: string,
    roleCode?: string,
  ): Promise<AttendanceSessionDocument> {
    if (dto.method === 'manual_class') {
      if (!dto.class_id) throw new BadRequestException('Manual attendance requires class_id.');
      await this.attendanceGrantsService.assertMethod(dto.context_id, userId, roleCode, dto.method);
      await this.attendanceGrantsService.assertOwnClass(dto.class_id, userId, roleCode);
    } else {
      await this.ensureAttendanceOperator(dto.context_type, dto.context_id, userId, roleCode, dto.method);
    }
    await this.ensureTodaySchedule(dto.context_type, dto.context_id, dto.schedule_id);
    // Manual sessions are isolated by opener, schedule, and class; self-check-in remains shared.
    const existing = await this.sessionModel.findOne({
      context_type: dto.context_type,
      context_id: new Types.ObjectId(dto.context_id),
      schedule_id: new Types.ObjectId(dto.schedule_id),
      status: 'active',
      ...(dto.method === 'manual_class'
        ? {
            method: 'manual_class',
            class_id: new Types.ObjectId(dto.class_id!),
            opened_by: new Types.ObjectId(userId),
          }
        : { method: { $in: ['qr', 'proximity'] }, opened_by: new Types.ObjectId(userId) }),
    });
    if (existing) {
      throw new BadRequestException(
        'Đã có phiên điểm danh đang mở cho ngữ cảnh này. Vui lòng đóng phiên cũ trước.',
      );
    }

    // Validate proximity-specific fields
    if (dto.method === 'proximity') {
      if (dto.latitude == null || dto.longitude == null) {
        throw new BadRequestException(
          'Phương thức proximity yêu cầu tọa độ GPS (latitude, longitude).',
        );
      }
    }

    const sessionData: any = {
      context_type: dto.context_type,
      context_id: new Types.ObjectId(dto.context_id),
      semester_id: new Types.ObjectId(dto.semester_id),
      method: dto.method,
      status: 'active',
      opened_by: new Types.ObjectId(userId),
      opened_at: new Date(),
      allow_late_checkin: dto.allow_late_checkin ?? false,
      auto_approve: dto.auto_approve ?? true,
      title: dto.title,
      description: dto.description,
      max_checkins: dto.max_checkins,
      class_id: dto.class_id ? new Types.ObjectId(dto.class_id) : undefined,
    };

    if (dto.schedule_id) {
      sessionData.schedule_id = new Types.ObjectId(dto.schedule_id);
    }

    if (dto.auto_close_at) {
      sessionData.auto_close_at = new Date(dto.auto_close_at);
    }

    // QR-specific setup
    if (dto.method === 'qr') {
      sessionData.qr_refresh_interval = dto.qr_refresh_interval ?? 30;
      sessionData.qr_token = uuidv4();
      sessionData.qr_token_expires_at = new Date(
        Date.now() + (sessionData.qr_refresh_interval * 1000),
      );
    }

    // Proximity-specific setup
    if (dto.method === 'proximity') {
      sessionData.latitude = dto.latitude;
      sessionData.longitude = dto.longitude;
      sessionData.radius_meters = dto.radius_meters ?? 100;
    }

    const session = new this.sessionModel(sessionData);
    let saved: AttendanceSessionDocument;
    try {
      saved = await session.save();
    } catch (error: any) {
      if (error?.code === 11000) throw new BadRequestException('An active attendance session already exists for this schedule and class.');
      throw error;
    }

    this.logger.log(
      `Session opened: ${saved._id} (${dto.method}) for ${dto.context_type}:${dto.context_id}`,
    );
    this.emitLifecycleEvent('attendance.session_opened', saved);

    return saved;
  }

  // ── Close Session ──

  async closeSession(
    sessionId: string,
    userId: string,
    roleCode?: string,
  ): Promise<AttendanceSessionDocument> {
    const session = await this.sessionModel.findById(sessionId);
    if (!session) {
      throw new NotFoundException('Không tìm thấy phiên điểm danh');
    }
    if (session.status !== 'active') {
      throw new BadRequestException('Phiên điểm danh đã đóng');
    }
    if (session.method === 'manual_class') {
      this.assertManualSessionOwner(session, userId);
      await this.attendanceGrantsService.assertMethod(session.context_id.toString(), userId, roleCode, session.method);
      await this.attendanceGrantsService.assertOwnClass(session.class_id!.toString(), userId, roleCode);
    } else {
      await this.ensureAttendanceOperator(session.context_type, session.context_id.toString(), userId, roleCode, session.method);
    }

    session.status = 'closed';
    session.closed_at = new Date();
    const saved = await session.save();
    this.emitLifecycleEvent('attendance.session_closed', saved);
    return saved;
  }

  // ── QR Token Management ──

  async getQrData(
    sessionId: string,
    userId: string,
    roleCode?: string,
  ): Promise<{ token: string; expires_at: Date; refresh_interval: number; checkin_count: number }> {
    const session = await this.sessionModel.findById(sessionId);
    if (!session) {
      throw new NotFoundException('Không tìm thấy phiên điểm danh');
    }
    if (session.status !== 'active') {
      throw new BadRequestException('Phiên điểm danh đã đóng');
    }
    if (session.method !== 'qr') {
      throw new BadRequestException('Phiên này không dùng phương thức QR');
    }
    await this.ensureAttendanceOperator(session.context_type, session.context_id.toString(), userId, roleCode, session.method);

    // Auto-rotate if token expired
    const now = new Date();
    if (!session.qr_token_expires_at || session.qr_token_expires_at <= now) {
      session.qr_token = uuidv4();
      session.qr_token_expires_at = new Date(
        now.getTime() + (session.qr_refresh_interval * 1000),
      );
      await session.save();
      this.emitEvent({ type: 'attendance.qr_rotated', contextType: session.context_type, contextId: session.context_id.toString(), sessionId: session._id.toString(), checkinCount: session.checkin_count });
    }

    return {
      token: session.qr_token,
      expires_at: session.qr_token_expires_at,
      refresh_interval: session.qr_refresh_interval,
      checkin_count: session.checkin_count,
    };
  }

  // ── QR Check-in ──

  async checkinQr(
    dto: CheckinQrDto,
    userId: string,
    roleCode: string,
    userAgent?: string,
  ): Promise<AttendanceCheckinDocument> {
    // Find session by token
    const session = await this.sessionModel.findOne({
      qr_token: dto.token,
      status: 'active',
    });
    if (!session) {
      throw new BadRequestException(
        'Mã QR không hợp lệ hoặc đã hết hạn. Vui lòng quét mã mới.',
      );
    }

    // Check token expiry
    if (session.qr_token_expires_at && session.qr_token_expires_at < new Date()) {
      throw new BadRequestException(
        'Mã QR đã hết hạn. Vui lòng quét mã mới.',
      );
    }

    const studentId = await this.validateMembership(session, userId, roleCode);

    // Check duplicate
    await this.checkDuplicate(session._id.toString(), studentId);

    // Check max checkins
    this.checkMaxCheckins(session);

    // Create check-in
    const checkin = new this.checkinModel({
      session_id: session._id,
      student_id: new Types.ObjectId(studentId),
      method: 'qr',
      status: 'present',
      checked_in_at: new Date(),
      qr_token_used: dto.token,
      user_agent: userAgent,
    });

    const saved = await checkin.save();

    // Update checkin count
    await this.sessionModel.findByIdAndUpdate(session._id, {
      $inc: { checkin_count: 1 },
    });
    this.emitEvent({ type: 'attendance.checkin_created', contextType: session.context_type, contextId: session.context_id.toString(), sessionId: session._id.toString(), checkinCount: session.checkin_count + 1, checkin: this.toRealtimeCheckin(saved) });

    // Sync to activity attendance if applicable.
    if (['club', 'activity'].includes(session.context_type) && session.schedule_id) {
      await this.syncToActivityAttendance(saved, session);
    }

    this.logger.log(
      `QR check-in: student ${studentId} → session ${session._id}`,
    );

    return saved;
  }

  // ── Proximity Check-in ──

  async checkinProximity(
    dto: CheckinProximityDto,
    userId: string,
    roleCode: string,
    userAgent?: string,
  ): Promise<AttendanceCheckinDocument> {
    const session = await this.sessionModel.findById(dto.session_id);
    if (!session) {
      throw new NotFoundException('Không tìm thấy phiên điểm danh');
    }
    if (session.status !== 'active') {
      throw new BadRequestException('Phiên điểm danh đã đóng');
    }
    if (session.method !== 'proximity') {
      throw new BadRequestException('Phiên này không dùng phương thức proximity');
    }

    const studentId = await this.validateMembership(session, userId, roleCode);

    // Check duplicate
    await this.checkDuplicate(session._id.toString(), studentId);

    // Calculate distance using Haversine formula
    const distance = this.haversineDistance(
      session.latitude,
      session.longitude,
      dto.latitude,
      dto.longitude,
    );

    if (distance > session.radius_meters) {
      throw new BadRequestException(
        `Bạn đang ở ngoài phạm vi điểm danh. Khoảng cách: ${Math.round(distance)}m, cho phép: ${session.radius_meters}m.`,
      );
    }

    // Check max checkins
    this.checkMaxCheckins(session);

    // Create check-in
    const checkin = new this.checkinModel({
      session_id: session._id,
      student_id: new Types.ObjectId(studentId),
      method: 'proximity',
      status: 'present',
      checked_in_at: new Date(),
      latitude: dto.latitude,
      longitude: dto.longitude,
      distance_meters: Math.round(distance),
      user_agent: userAgent,
    });

    const saved = await checkin.save();

    // Update checkin count
    await this.sessionModel.findByIdAndUpdate(session._id, {
      $inc: { checkin_count: 1 },
    });
    this.emitEvent({ type: 'attendance.checkin_created', contextType: session.context_type, contextId: session.context_id.toString(), sessionId: session._id.toString(), checkinCount: session.checkin_count + 1, checkin: this.toRealtimeCheckin(saved) });

    // Sync to activity attendance if applicable.
    if (['club', 'activity'].includes(session.context_type) && session.schedule_id) {
      await this.syncToActivityAttendance(saved, session);
    }

    this.logger.log(
      `Proximity check-in: student ${studentId} → session ${session._id} (${Math.round(distance)}m)`,
    );

    return saved;
  }

  // ── Query Methods ──

  async getActiveSession(
    contextType: string,
    contextId: string,
    userId: string,
    roleCode: string,
    filters: { method?: string; classId?: string; scheduleId?: string } = {},
  ): Promise<AttendanceSessionDocument | null> {
    this.assertValidRequester(userId);
    this.assertObjectId(contextId, 'context_id');
    if (filters.classId) this.assertObjectId(filters.classId, 'class_id');
    if (filters.scheduleId) this.assertObjectId(filters.scheduleId, 'schedule_id');
    // Auto-expire sessions past auto_close_at
    await this.sessionModel.updateMany(
      {
        status: 'active',
        auto_close_at: { $lte: new Date() },
      },
      { $set: { status: 'expired', closed_at: new Date() } },
    );

    const query: any = {
        context_type: contextType,
        context_id: new Types.ObjectId(contextId),
        status: 'active',
        ...(filters.method ? { method: filters.method } : { method: { $in: ['qr', 'proximity'] } }),
        ...(filters.classId ? { class_id: new Types.ObjectId(filters.classId) } : {}),
        ...(filters.scheduleId ? { schedule_id: new Types.ObjectId(filters.scheduleId) } : {}),
      };
    if (filters.method && !['qr', 'proximity', 'manual_class'].includes(filters.method)) {
      throw new BadRequestException('Invalid attendance method.');
    }
    if (filters.method === 'manual_class' && !filters.classId) {
      throw new BadRequestException('class_id is required when querying a manual session.');
    }
    if (filters.method === 'manual_class' || !filters.method || filters.method === 'qr' || filters.method === 'proximity') {
      query.opened_by = new Types.ObjectId(userId);
    }
    const session = await this.sessionModel
      .findOne(query)
      .populate('opened_by', 'user_name')
      .lean()
      .exec();
    if (session?.method === 'manual_class') {
      await this.attendanceGrantsService.assertMethod(contextId, userId, roleCode, 'manual_class');
      await this.attendanceGrantsService.assertOwnClass(session.class_id!.toString(), userId, roleCode);
    } else if (session) {
      await this.validateMembership(session, userId, roleCode);
    }
    return session;
  }

  async getSessionById(
    sessionId: string,
    userId: string,
    roleCode: string,
  ): Promise<AttendanceSessionDocument> {
    this.assertValidRequester(userId);
    this.assertObjectId(sessionId, 'session_id');
    const session = await this.sessionModel
      .findById(sessionId)
      .populate('opened_by', 'user_name')
      .exec();
    if (!session) {
      throw new NotFoundException('Không tìm thấy phiên điểm danh');
    }
    if (session.method === 'manual_class') {
      this.assertManualSessionOwner(session, userId);
    }
    await this.authorizeSessionRead(session, userId, roleCode);
    return session;
  }

  async getCheckins(
    sessionId: string,
    userId: string,
    roleCode: string,
  ): Promise<AttendanceCheckinDocument[]> {
    this.assertValidRequester(userId);
    this.assertObjectId(sessionId, 'session_id');
    const session = await this.sessionModel.findById(sessionId).lean().exec();
    if (!session) {
      throw new NotFoundException('Không tìm thấy phiên điểm danh');
    }
    if (session.method === 'manual_class') {
      this.assertManualSessionOwner(session, userId);
      await this.authorizeSessionRead(session, userId, roleCode);
      return [];
    }
    const studentId = await this.validateMembership(session, userId, roleCode);
    const isManager = await this.isManager(session, userId, roleCode);
    return this.checkinModel
      .find({
        session_id: new Types.ObjectId(sessionId),
        ...(isManager ? {} : { student_id: new Types.ObjectId(studentId) }),
      })
      .populate('student_id', 'full_name student_code email')
      .sort({ checked_in_at: -1 })
      .lean()
      .exec();
  }

  async getSessionHistory(
    contextType: string,
    contextId: string,
    page = 1,
    limit = 10,
    userId: string,
    roleCode: string,
  ): Promise<{
    items: AttendanceSessionDocument[];
    total: number;
  }> {
    this.assertValidRequester(userId);
    this.assertObjectId(contextId, 'context_id');
    const filter = {
      context_type: contextType,
      context_id: new Types.ObjectId(contextId),
    };
    const skip = (page - 1) * limit;

    const candidateItems = await this.sessionModel
        .find(filter)
        .populate('opened_by', 'user_name')
        .sort({ opened_at: -1 })
        .skip(skip)
        .limit(limit)
        .lean()
        .exec();
    const authorized: AttendanceSessionDocument[] = [];
    for (const item of candidateItems) {
      try {
        await this.authorizeSessionRead(item as any, userId, roleCode);
        authorized.push(item as any);
      } catch (error) {
        if (!(error instanceof ForbiddenException)) throw error;
      }
    }
    return { items: authorized, total: authorized.length };
  }

  // ── Private Helpers ──

  /**
   * Haversine formula to calculate distance between two lat/lng points in meters.
   */
  private haversineDistance(
    lat1: number,
    lon1: number,
    lat2: number,
    lon2: number,
  ): number {
    const R = 6371000; // Earth radius in meters
    const dLat = this.toRad(lat2 - lat1);
    const dLon = this.toRad(lon2 - lon1);
    const a =
      Math.sin(dLat / 2) * Math.sin(dLat / 2) +
      Math.cos(this.toRad(lat1)) *
        Math.cos(this.toRad(lat2)) *
        Math.sin(dLon / 2) *
        Math.sin(dLon / 2);
    const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
    return R * c;
  }

  private toRad(deg: number): number {
    return (deg * Math.PI) / 180;
  }

  /**
   * Resolve an active member before student attendance data is accessed.
   */
  private async validateMembership(
    session: AttendanceSessionDocument,
    userId: string,
    roleCode: string,
  ): Promise<string> {
    if (roleCode === 'ADMIN') {
      return '';
    }

    if (!['club', 'activity'].includes(session.context_type)) {
      throw new ForbiddenException('Attendance access is not available for this context.');
    }

    const requesterId = new Types.ObjectId(userId);
    const studentId = await this.resolveRequesterStudentId(requesterId);
    const activity = this.activityModel && ['activity', 'club'].includes(session.context_type)
      ? await this.activityModel.findById(session.context_id).select('settings.require_registration_for_attendance').lean().exec()
      : null;
    if (roleCode === 'STUDENT' && activity?.settings?.require_registration_for_attendance === false) {
      if (!studentId) throw new ForbiddenException('A linked student profile is required.');
      return studentId;
    }
    const membershipOwners: Array<{ user_id?: Types.ObjectId; student_id?: Types.ObjectId }> = [{ user_id: requesterId }];
    if (studentId) membershipOwners.push({ student_id: new Types.ObjectId(studentId) });
    const member = await this.clubMemberModel.findOne({
      activity_id: session.context_id,
      status: 'active',
      $or: membershipOwners,
    });
    if (!member) {
      throw new ForbiddenException('An active activity membership is required.');
    }
    if (member.student_id) return member.student_id.toString();

    if (!studentId) {
      throw new ForbiddenException('An active activity membership is required.');
    }
    return studentId;
  }

  private async isManager(session: AttendanceSessionDocument | any, userId: string, roleCode?: string): Promise<boolean> {
    if (roleCode === 'ADMIN') return true;
    if (!['club', 'activity'].includes(session.context_type) || !Types.ObjectId.isValid(userId)) return false;
    const activity = this.activityModel
      ? await this.activityModel.findById(session.context_id).select('advisor_id').lean().exec()
      : null;
    if (activity?.advisor_id?.toString() === userId.toString()) return true;
    const requesterId = new Types.ObjectId(userId);
    const studentId = await this.resolveRequesterStudentId(requesterId);
    const membershipOwners: Array<{ user_id?: Types.ObjectId; student_id?: Types.ObjectId }> = [{ user_id: requesterId }];
    if (studentId) membershipOwners.push({ student_id: new Types.ObjectId(studentId) });
    const member = await this.clubMemberModel.findOne({
      activity_id: session.context_id,
      status: 'active',
      role: 'president',
      $or: membershipOwners,
    });
    return Boolean(member);
  }

  private async resolveRequesterStudentId(requesterId: Types.ObjectId): Promise<string | null> {
    const student = await this.studentModel
      .findOne({ user_id: requesterId })
      .select('_id')
      .lean()
      .exec();
    return student?._id?.toString() || null;
  }

  private async ensureManager(contextType: string, contextId: string, userId: string, roleCode?: string): Promise<void> {
    if (roleCode === 'ADMIN') return;
    if (!['club', 'activity'].includes(contextType) || !Types.ObjectId.isValid(contextId)) {
      throw new ForbiddenException('Attendance management is not available for this context.');
    }
    const manager = await this.isManager({ context_type: contextType, context_id: new Types.ObjectId(contextId) }, userId, roleCode);
    if (!manager) throw new ForbiddenException('Only an administrator, assigned teacher, or active president can manage attendance.');
  }

  private async ensureTodaySchedule(
    contextType: string,
    contextId: string,
    scheduleId: string,
  ): Promise<void> {
    if (!['club', 'activity'].includes(contextType) || !Types.ObjectId.isValid(scheduleId)) {
      throw new BadRequestException('Attendance requires a valid activity schedule for today.');
    }

    const schedule = await this.scheduleModel.findOne({
      _id: new Types.ObjectId(scheduleId),
      activity_id: new Types.ObjectId(contextId),
      status: { $ne: 'cancelled' },
    }).lean().exec();
    const now = new Date();
    const startTime = schedule ? new Date(schedule.start_time) : null;
    const endTime = schedule ? new Date(schedule.end_time) : null;
    if (
      !schedule ||
      !startTime ||
      !endTime ||
      Number.isNaN(startTime.getTime()) ||
      Number.isNaN(endTime.getTime()) ||
      startTime > endTime ||
      this.toHoChiMinhDate(startTime) !== this.toHoChiMinhDate(now) ||
      now < startTime ||
      now > endTime
    ) {
      throw new BadRequestException('Attendance can only be opened during the activity schedule window.');
    }
  }

  private toHoChiMinhDate(value: Date): string {
    return new Intl.DateTimeFormat('en-CA', {
      timeZone: 'Asia/Ho_Chi_Minh',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    }).format(value);
  }

  private emitEvent(event: AttendanceRealtimeEvent): void {
    attendanceEventEmitter.emit('attendance_event', event);
  }

  private emitLifecycleEvent(
    type: 'attendance.session_opened' | 'attendance.session_closed',
    session: AttendanceSessionDocument,
  ): void {
    this.emitEvent({
      type,
      contextType: session.context_type,
      contextId: session.context_id.toString(),
      sessionId: session._id.toString(),
      checkinCount: session.checkin_count,
      session: this.toPublicSession(session),
      method: session.method,
      scheduleId: session.schedule_id?.toString(),
      classId: session.class_id?.toString(),
      openedBy: session.opened_by?.toString(),
    });
  }

  private toPublicSession(session: AttendanceSessionDocument | any): Record<string, unknown> {
    return {
      _id: session._id.toString(), context_type: session.context_type,
      context_id: session.context_id.toString(), method: session.method,
      schedule_id: session.schedule_id?.toString(),
      class_id: session.class_id?.toString(),
      status: session.status, opened_at: session.opened_at, closed_at: session.closed_at,
      latitude: session.latitude, longitude: session.longitude,
      radius_meters: session.radius_meters, title: session.title,
      checkin_count: session.checkin_count,
      opened_by: session.opened_by?._id?.toString?.()
        ?? session.opened_by?.toString?.(),
    };
  }

  private async ensureAttendanceOperator(
    contextType: string,
    contextId: string,
    userId: string,
    roleCode: string | undefined,
    method: string,
  ): Promise<void> {
    try {
      await this.ensureManager(contextType, contextId, userId, roleCode);
    } catch (error) {
      if (!(error instanceof ForbiddenException)) throw error;
      await this.attendanceGrantsService.assertMethod(contextId, userId, roleCode, method);
    }
  }

  private assertValidRequester(userId: string): void {
    if (!userId || !Types.ObjectId.isValid(userId)) {
      throw new BadRequestException('A valid authenticated requester is required.');
    }
  }

  private assertObjectId(value: string, field: string): void {
    if (!value || !Types.ObjectId.isValid(value)) {
      throw new BadRequestException(`${field} must be a valid ObjectId.`);
    }
  }

  private assertManualSessionOwner(
    session: AttendanceSessionDocument | any,
    userId: string,
  ): void {
    const ownerId = session.opened_by?._id?.toString?.()
      ?? session.opened_by?.toString?.();
    if (!ownerId || ownerId !== userId) {
      throw new ForbiddenException('Only the opener can control this manual attendance session.');
    }
  }

  private async authorizeSessionRead(
    session: AttendanceSessionDocument | any,
    userId: string,
    roleCode?: string,
  ): Promise<void> {
    if (session.method === 'manual_class') {
      await this.attendanceGrantsService.assertMethod(
        session.context_id.toString(), userId, roleCode, 'manual_class',
      );
      await this.attendanceGrantsService.assertOwnClass(
        session.class_id?.toString(), userId, roleCode,
      );
      return;
    }
    try {
      await this.validateMembership(session, userId, roleCode || '');
    } catch (error) {
      if (!(error instanceof ForbiddenException)) throw error;
      await this.ensureAttendanceOperator(
        session.context_type, session.context_id.toString(), userId, roleCode, session.method,
      );
    }
  }

  async getManualRoster(sessionId: string, userId: string, roleCode?: string) {
    this.assertValidRequester(userId);
    this.assertObjectId(sessionId, 'session_id');
    const session = await this.sessionModel.findById(sessionId).lean().exec();
    if (!session || session.method !== 'manual_class' || session.status !== 'active') {
      throw new NotFoundException('Active manual attendance session not found.');
    }
    this.assertManualSessionOwner(session, userId);
    await this.attendanceGrantsService.assertMethod(session.context_id.toString(), userId, roleCode, 'manual_class');
    await this.attendanceGrantsService.assertOwnClass(session.class_id!.toString(), userId, roleCode);
    await this.assertManualWindowOpen(session);
    const [students, attendances, total] = await Promise.all([
      this.studentModel.find({ class_id: session.class_id })
        .select('full_name student_code status class_id').sort({ student_code: 1 }).limit(500).lean().exec(),
      this.clubAttendanceModel.find({
        schedule_id: session.schedule_id,
        class_id: session.class_id,
        approval_status: { $in: ['pending', 'approved'] },
        status: { $in: ['present', 'late'] },
      }).lean().exec(),
      this.studentModel.countDocuments({ class_id: session.class_id }),
    ]);
    const byStudent = new Map(attendances.map((item: any) => [item.student_id.toString(), item]));
    return {
      class_id: session.class_id,
      total,
      window: { offset: 0, limit: 500, returned: students.length, has_more: total > students.length },
      students: students.map((student: any) => ({
        ...student,
        attendance: byStudent.get(student._id.toString()) || null,
      })),
    };
  }

  async manualCheckin(sessionId: string, studentId: string, userId: string, roleCode?: string) {
    this.assertValidRequester(userId);
    this.assertObjectId(sessionId, 'session_id');
    this.assertObjectId(studentId, 'student_id');
    const session = await this.sessionModel.findById(sessionId).exec();
    if (!session || session.method !== 'manual_class' || session.status !== 'active') {
      throw new NotFoundException('Active manual attendance session not found.');
    }
    this.assertManualSessionOwner(session, userId);
    await this.attendanceGrantsService.assertMethod(session.context_id.toString(), userId, roleCode, 'manual_class');
    await this.attendanceGrantsService.assertOwnClass(session.class_id!.toString(), userId, roleCode);
    await this.assertManualWindowOpen(session);
    const student = await this.studentModel.findOne({ _id: new Types.ObjectId(studentId), class_id: session.class_id })
      .select('_id class_id').lean().exec();
    if (!student) throw new ForbiddenException('Student does not belong to the selected class.');
    const now = new Date();
    const attendanceFilter = { schedule_id: session.schedule_id, student_id: student._id };
    const attendanceInsert = {
          activity_id: session.context_id, schedule_id: session.schedule_id,
          student_id: student._id, semester_id: session.semester_id,
          attendance_method: 'manual_class', class_id: session.class_id,
          note: 'Manual homeroom attendance',
    };
    let attendance: any;
    const reactivation = {
        status: 'present',
        check_in_time: now,
        recorded_by: new Types.ObjectId(userId),
        recorded_by_role: 'teacher',
        recorded_at: now,
        approval_status: 'pending',
        approved_by: undefined,
        approved_at: undefined,
    };
    try {
      attendance = await this.clubAttendanceModel.findOneAndUpdate(
        { ...attendanceFilter, activity_id: session.context_id, class_id: session.class_id, attendance_method: 'manual_class' },
        { $set: reactivation, $setOnInsert: attendanceInsert },
        { returnDocument: 'after', upsert: true, setDefaultsOnInsert: true },
      ).lean().exec();
    } catch (error: any) {
      if (error?.code !== 11000) throw error;
      attendance = await this.clubAttendanceModel.findOne(attendanceFilter).lean().exec();
      if (!attendance) throw error;
    }
    const count = await this.clubAttendanceModel.countDocuments({
      schedule_id: session.schedule_id,
      class_id: session.class_id,
      approval_status: { $in: ['pending', 'approved'] },
      status: { $in: ['present', 'late'] },
    });
    await this.sessionModel.updateOne({ _id: session._id }, { $set: { checkin_count: count } }).exec();
    const canonical = {
      ...attendance,
      _id: (attendance as any)._id.toString(),
      student_id: student._id.toString(),
      schedule_id: session.schedule_id.toString(),
      class_id: session.class_id!.toString(),
    };
    this.emitEvent({
      type: 'attendance.checkin_created', contextType: session.context_type,
      contextId: session.context_id.toString(), activityId: session.context_id.toString(),
      scheduleId: session.schedule_id.toString(), sessionId: session._id.toString(),
      classId: session.class_id!.toString(), studentId: student._id.toString(),
      method: 'manual_class', openedBy: session.opened_by.toString(),
      checkinCount: count, attendance: canonical,
    });
    return canonical;
  }

  async cancelManualCheckin(sessionId: string, studentId: string, userId: string, roleCode?: string) {
    this.assertValidRequester(userId);
    this.assertObjectId(sessionId, 'session_id');
    this.assertObjectId(studentId, 'student_id');
    const session = await this.sessionModel.findById(sessionId).exec();
    if (!session || session.method !== 'manual_class' || session.status !== 'active') {
      throw new NotFoundException('Active manual attendance session not found.');
    }
    this.assertManualSessionOwner(session, userId);
    await this.attendanceGrantsService.assertMethod(session.context_id.toString(), userId, roleCode, 'manual_class');
    await this.attendanceGrantsService.assertOwnClass(session.class_id!.toString(), userId, roleCode);
    await this.assertManualWindowOpen(session);
    const student = await this.studentModel.findOne({ _id: new Types.ObjectId(studentId), class_id: session.class_id })
      .select('_id class_id').lean().exec();
    if (!student) throw new ForbiddenException('Student does not belong to the selected class.');
    const attendance: any = await this.clubAttendanceModel.findOne({
      schedule_id: session.schedule_id,
      student_id: student._id,
      activity_id: session.context_id,
      class_id: session.class_id,
      attendance_method: 'manual_class',
    }).exec();
    if (!attendance) throw new NotFoundException('Manual attendance record not found.');
    attendance.approval_status = 'rejected';
    attendance.status = 'absent';
    await attendance.save();
    await this.activityAttendanceSyncService.revokeAcademicRecord(attendance._id.toString());
    const count = await this.clubAttendanceModel.countDocuments({
      schedule_id: session.schedule_id,
      class_id: session.class_id,
      approval_status: { $in: ['pending', 'approved'] },
      status: { $in: ['present', 'late'] },
    });
    await this.sessionModel.updateOne({ _id: session._id }, { $set: { checkin_count: count } }).exec();
    const canonical = {
      ...attendance.toObject(),
      _id: attendance._id.toString(),
      student_id: student._id.toString(),
      schedule_id: session.schedule_id.toString(),
      class_id: session.class_id!.toString(),
    };
    this.emitEvent({
      type: 'attendance.checkin_created', contextType: session.context_type,
      contextId: session.context_id.toString(), activityId: session.context_id.toString(),
      scheduleId: session.schedule_id.toString(), sessionId: session._id.toString(),
      classId: session.class_id!.toString(), studentId: student._id.toString(),
      method: 'manual_class', openedBy: session.opened_by.toString(),
      checkinCount: count, attendance: canonical,
    });
    return canonical;
  }

  private async assertManualWindowOpen(session: AttendanceSessionDocument | any): Promise<void> {
    if (typeof (this.scheduleModel as any).findById !== 'function') return;
    const schedule = await this.scheduleModel.findById(session.schedule_id).select('end_time status').lean().exec();
    if (!schedule || schedule.status === 'cancelled' || new Date(schedule.end_time).getTime() < Date.now()) {
      throw new BadRequestException('The class attendance window has ended.');
    }
  }

  private toRealtimeCheckin(checkin: AttendanceCheckinDocument | any) {
    return {
      _id: checkin._id?.toString() || '', student_id: checkin.student_id.toString(),
      method: checkin.method, status: checkin.status,
      checked_in_at: checkin.checked_in_at, distance_meters: checkin.distance_meters,
    };
  }

  /**
   * Check for duplicate check-in in the same session.
   */
  private async checkDuplicate(
    sessionId: string,
    studentId: string,
  ): Promise<void> {
    const existing = await this.checkinModel.findOne({
      session_id: new Types.ObjectId(sessionId),
      student_id: new Types.ObjectId(studentId),
    });
    if (existing) {
      throw new BadRequestException('Bạn đã điểm danh cho phiên này rồi.');
    }
  }

  /**
   * Check if session has reached max check-ins.
   */
  private checkMaxCheckins(session: AttendanceSessionDocument): void {
    if (
      session.max_checkins &&
      session.checkin_count >= session.max_checkins
    ) {
      throw new BadRequestException(
        'Phiên điểm danh đã đạt số lượng tối đa.',
      );
    }
  }

  /**
   * Sync a check-in to the existing activity-attendance system.
   * Creates a ActivityAttendance record with auto-approved status.
   */
  private async syncToActivityAttendance(
    checkin: AttendanceCheckinDocument,
    session: AttendanceSessionDocument,
  ): Promise<void> {
    try {
      // Check for existing club attendance record
      const existing = await this.clubAttendanceModel.findOne({
        schedule_id: session.schedule_id,
        student_id: checkin.student_id,
      });

      if (existing) {
        // Update existing record
        existing.status = checkin.status;
        existing.check_in_time = checkin.checked_in_at;
        if (session.auto_approve) {
          existing.approval_status = 'approved';
          existing.approved_at = new Date();
          existing.approved_by = session.opened_by;
        }
        await existing.save();

        checkin.synced = true;
        checkin.synced_record_id = existing._id;
        await checkin.save();
        await this.syncApprovedActivityAttendance(existing);
        return;
      }

      // Create new club attendance record
      const clubAttendance = new this.clubAttendanceModel({
        activity_id: session.context_id,
        schedule_id: session.schedule_id,
        student_id: checkin.student_id,
        semester_id: session.semester_id,
        status: checkin.status,
        check_in_time: checkin.checked_in_at,
        recorded_by: session.opened_by,
        recorded_by_role: 'teacher',
        recorded_at: new Date(),
        approval_status: session.auto_approve ? 'approved' : 'pending',
        approved_by: session.auto_approve ? session.opened_by : undefined,
        approved_at: session.auto_approve ? new Date() : undefined,
        note: `Điểm danh tự động qua ${checkin.method === 'qr' ? 'QR Code' : 'Proximity'}`,
      });

      const saved = await clubAttendance.save();

      // Update checkin sync reference
      checkin.synced = true;
      checkin.synced_record_id = saved._id;
      await checkin.save();
      await this.syncApprovedActivityAttendance(saved);

      this.logger.log(
        `Synced checkin ${checkin._id} → ActivityAttendance ${saved._id}`,
      );
    } catch (error: any) {
      // Don't fail the check-in if sync fails (can be retried)
      if (error.code === 11000) {
        this.logger.warn(
          `Duplicate club attendance for schedule ${session.schedule_id}, student ${checkin.student_id}`,
        );
      } else {
        this.logger.error(
          `Failed to sync checkin ${checkin._id} to club attendance: ${error.message}`,
        );
      }
    }
  }

  private async syncApprovedActivityAttendance(
    attendance: ActivityAttendanceDocument,
  ): Promise<void> {
    if (attendance.approval_status !== 'approved') return;

    try {
      const result = await this.activityAttendanceSyncService
        .syncAttendanceToAcademicRecord(attendance._id.toString());
      this.logger.log(
        `Activity attendance ${attendance._id} evaluation: ${result.synced ? 'OK' : result.reason}`,
      );
    } catch (error: any) {
      this.logger.error(
        `Failed to evaluate activity attendance ${attendance._id}: ${error.message}`,
      );
    }
  }
}
