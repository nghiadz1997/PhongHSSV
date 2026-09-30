import {
  Injectable,
  NotFoundException,
  BadRequestException,
  ForbiddenException,
  ConflictException,
  Optional,
} from '@nestjs/common';
import { InjectModel, InjectConnection } from '@nestjs/mongoose';
import { Model, Types, Connection } from 'mongoose';
import { Activity, ActivityDocument } from './schemas/activity.schema';
import { ActivityMember, ActivityMemberDocument } from './schemas/activity-member.schema';
import {
  ActivityFavorite,
  ActivityFavoriteDocument,
} from './schemas/activity-favorite.schema';
import { Student, StudentDocument } from '../students/schemas/student.schema';
import { User, UserDocument } from '../auth/schemas/user.schema';
import { Role, RoleDocument } from '../auth/schemas/role.schema';
import { CreateActivityDto } from './dto/create-activity.dto';
import { UpdateActivityDto } from './dto/update-activity.dto';
import {
  AddActivityMemberDto,
  UpdateActivityMemberDto,
  ApproveMemberDto,
  JoinActivityDto,
  SwitchActivityDto,
  LeaveActivityDto,
  AdminTransferActivityDto,
} from './dto/activity-member.dto';
import { isAdminUser, isTeacher } from '../auth/utils/role.util';
import {
  ActivityMembershipTransfer,
  ActivityMembershipTransferDocument,
} from './schemas/activity-membership-transfer.schema';
import {
  ActivitySchedule,
  ActivityScheduleDocument,
} from '../activity-schedules/schemas/activity-schedule.schema';
import { ActivitiesRealtimeService } from './activities-realtime.service';
import { StorageService } from '../core/storage/storage.service';

@Injectable()
export class ActivitiesService {
  constructor(
    @InjectModel(Activity.name) private activityModel: Model<ActivityDocument>,
    @InjectModel(ActivityMember.name)
    private memberModel: Model<ActivityMemberDocument>,
    @InjectModel(ActivityFavorite.name)
    private favoriteModel: Model<ActivityFavoriteDocument>,
    @InjectModel(Student.name) private studentModel: Model<StudentDocument>,
    @InjectModel(User.name) private userModel: Model<UserDocument>,
    @InjectModel(Role.name) private roleModel: Model<RoleDocument>,
    @InjectModel(ActivityMembershipTransfer.name)
    private transferModel: Model<ActivityMembershipTransferDocument>,
    @InjectModel(ActivitySchedule.name)
    private scheduleModel: Model<ActivityScheduleDocument>,
    @InjectConnection() private readonly connection: Connection,
    private readonly realtime: ActivitiesRealtimeService,
    @Optional() private readonly storageService?: StorageService,
  ) {}

  private async resolveStudentId(userId: string): Promise<string> {
    if (!userId || !Types.ObjectId.isValid(userId)) {
      throw new BadRequestException('User ID không hợp lệ');
    }
    const student = await this.studentModel
      .findOne({ user_id: new Types.ObjectId(userId) })
      .exec();
    if (student) {
      return student._id.toString();
    }
    const user = await this.userModel.findById(userId).populate('role').exec();
    if (user && isAdminUser(user)) {
      const testStudent = await this.studentModel.findOne().exec();
      if (testStudent) {
        return testStudent._id.toString();
      }
      throw new BadRequestException('Không tìm thấy sinh viên nào trong hệ thống để test');
    }
    throw new BadRequestException('Người dùng không phải là sinh viên hoặc không có hồ sơ sinh viên');
  }

  private async findOccupiedMembership(
    studentId: string,
    semesterId: string,
  ): Promise<ActivityMemberDocument | null> {

    return this.memberModel
      .findOne({
        student_id: new Types.ObjectId(studentId),
        semester_id: new Types.ObjectId(semesterId),
        occupies_slot: true,
      })
      .exec();
  }

  private async findLatestLeftMembership(
    studentId: string,
    semesterId: string,
  ): Promise<ActivityMemberDocument | null> {
    return this.memberModel
      .findOne({
        student_id: new Types.ObjectId(studentId),
        semester_id: new Types.ObjectId(semesterId),
        status: 'left',
      })
      .sort({ updatedAt: -1 })
      .exec();
  }

  private async getFirstNonCancelledSchedule(
    activityId: string,
    semesterId: string,
  ): Promise<ActivityScheduleDocument | null> {
    return this.scheduleModel
      .findOne({
        activity_id: new Types.ObjectId(activityId),
        semester_id: new Types.ObjectId(semesterId),
        status: { $ne: 'cancelled' },
      })
      .sort({ start_time: 1, _id: 1 })
      .exec();
  }

  private async countCompletedSelfServiceTransfers(
    studentId: string,
    semesterId: string,
  ): Promise<number> {
    return this.transferModel.countDocuments({
      student_id: new Types.ObjectId(studentId),
      semester_id: new Types.ObjectId(semesterId),
      mode: 'self_service',
      status: 'completed',
    }).exec();
  }

  private async validateTargetActivity(
    activityId: string,
    semesterId: string,
    studentId: string,
  ): Promise<ActivityDocument> {
    const activity = await this.activityModel.findById(activityId);
    if (!activity) {
      throw new NotFoundException('Không tìm thấy Hoạt động');
    }
    if (activity.status !== 'active') {
      throw new BadRequestException('Hoạt động hiện không hoạt động');
    }
    if (activity.max_members) {
      const activeCount = await this.memberModel.countDocuments({
        activity_id: new Types.ObjectId(activityId),
        status: 'active',
        semester_id: new Types.ObjectId(semesterId),
      });
      if (activeCount >= activity.max_members) {
        throw new BadRequestException('Hoạt động đã đạt giới hạn thành viên');
      }
    }
    return activity;
  }

  private async validateAdvisor(advisorId: string): Promise<void> {
    const user = await this.userModel.findById(advisorId).populate('role').populate('roles').exec();
    if (!user) {
      throw new BadRequestException('Cố vấn được chọn không tồn tại trong hệ thống');
    }
    const userRole = user.role as any;
    const isTeacher = userRole?.role_code === 'TEACHER' || (user as any).roles?.some((r: any) => r.role_code === 'TEACHER');
    const isAdmin = isAdminUser(user);
    if (!isTeacher && !isAdmin) {
      throw new BadRequestException('Người dùng được chọn làm cố vấn phải có vai trò Giảng viên (TEACHER) hoặc Quản trị viên (ADMIN)');
    }
  }

  async create(dto: CreateActivityDto, userId: string, requester?: any): Promise<ActivityDocument> {
    const existing = await this.activityModel.findOne({
      code: dto.code.toUpperCase(),
    });
    if (existing) {
      throw new BadRequestException(`Hoạt động với mã "${dto.code}" đã tồn tại`);
    }
    if (!dto.classroom || dto.classroom.trim() === '') {
      throw new BadRequestException('Phòng học/phòng hoạt động mặc định không được để trống');
    }
    if (dto.activity_start_date && dto.activity_end_date) {
      if (new Date(dto.activity_end_date) < new Date(dto.activity_start_date)) {
        throw new BadRequestException(
          'Ngày kết thúc hoạt động không thể trước ngày bắt đầu',
        );
      }
    }

    const advisorId = (dto.advisor_id && Types.ObjectId.isValid(dto.advisor_id))
      ? dto.advisor_id
      : (requester && isAdminUser(requester) ? userId : undefined);
    if (!advisorId) throw new ForbiddenException('An administrator must be the default responsible account when no teacher is selected.');
    if (dto.advisor_id && Types.ObjectId.isValid(dto.advisor_id)) {
      await this.validateAdvisor(dto.advisor_id);
    }

    const activity = new this.activityModel({
      ...dto,
      advisor_id: advisorId,
      code: dto.code.toUpperCase(),
      activity_type: dto.activity_type || 'activity',
      participation_status: dto.participation_status || 'published',
    });
    const saved = await activity.save();
    this.realtime.publishCreated(saved._id.toString());
    return saved;
  }

  async findAll(
    user?: any,
    activityType?: string,
  ): Promise<any[]> {
    const query: any = {};
    if (activityType) {
      query.activity_type = activityType;
    }

    if (user && !isAdminUser(user)) {
      const requesterId = user.userId || user._id || user.id;
      const roleCode = user.roleCode || user.role?.role_code;
      const hasReadPermission = (user.permissions || []).includes('ACTIVITY_READ');
      const openActivity = {
        status: 'active',
        participation_status: 'published',
        'settings.require_registration_for_attendance': false,
      };
      if (isTeacher(user) || roleCode === 'TEACHER') {
        query.$or = [{ advisor_id: new Types.ObjectId(requesterId) }, openActivity];
      } else if (!hasReadPermission) {
        query.$or = [{ advisor_id: new Types.ObjectId(requesterId) }, openActivity];
      } else {
        // Non-admin, non-teacher users retain the active-or-advised policy.
        query.$or = [
          { status: 'active' },
          { advisor_id: new Types.ObjectId(requesterId) },
        ];
      }
    }

    const activities = await this.activityModel
      .find(query)
      .populate('advisor_id', 'user_name email')
      .populate('president_id', 'full_name student_code')
      .populate('semester_id', 'name')
      .sort({ createdAt: -1 })
      .lean()
      .exec();

    if (activities.length === 0) {
      return [];
    }

    const activityIds = activities.map((activity: any) => new Types.ObjectId(activity._id));
    const activitySemesterPairs = activities
      .filter((activity: any) => activity.semester_id)
      .map((activity: any) => ({
        activity_id: new Types.ObjectId(activity._id),
        semester_id: new Types.ObjectId(
          typeof activity.semester_id === 'object'
            ? activity.semester_id._id
            : activity.semester_id,
        ),
      }));
    const activitiesWithoutSemester = activities
      .filter((activity: any) => !activity.semester_id)
      .map((activity: any) => new Types.ObjectId(activity._id));

    const membershipMatch: any = {
      status: 'active',
      activity_id: { $in: activityIds },
    };
    const semesterFilters: any[] = activitySemesterPairs.map((pair: any) => ({
      activity_id: pair.activity_id,
      semester_id: pair.semester_id,
    }));
    if (activitiesWithoutSemester.length > 0) {
      semesterFilters.push({
        activity_id: { $in: activitiesWithoutSemester },
      });
    }
    if (semesterFilters.length > 0) {
      membershipMatch.$or = semesterFilters;
    }

    const memberCounts = await this.memberModel.aggregate([
      { $match: membershipMatch },
      {
        $group: {
          _id: '$activity_id',
          count: { $sum: 1 },
        },
      },
    ]);
    const countByActivityId = new Map(
      memberCounts.map((item: any) => [item._id.toString(), item.count]),
    );

    const membershipStatusByActivityId = new Map<string, string>();
    if (user) {
      const userId = user.userId || user._id || user.id;
      if (userId && Types.ObjectId.isValid(userId)) {
        const membershipOwnerIds: Types.ObjectId[] = [new Types.ObjectId(userId)];
        const student = await this.studentModel
          .findOne({ user_id: new Types.ObjectId(userId) })
          .select('_id')
          .lean()
          .exec();
        if (student?._id) {
          membershipOwnerIds.push(new Types.ObjectId(student._id));
        }

        const memberships = await this.memberModel
          .find({
            activity_id: { $in: activityIds },
            $or: [
              { user_id: { $in: membershipOwnerIds } },
              { student_id: { $in: membershipOwnerIds } },
            ],
          })
          .select('activity_id status')
          .lean()
          .exec();

        const statusPriority: Record<string, number> = {
          rejected: 4,
          active: 3,
          pending: 2,
          inactive: 1,
          left: 0,
        };
        memberships.forEach((membership: any) => {
          const activityId = membership.activity_id.toString();
          const currentStatus = membershipStatusByActivityId.get(activityId);
          if (
            !currentStatus
            || (statusPriority[membership.status] || 0) > (statusPriority[currentStatus] || 0)
          ) {
            membershipStatusByActivityId.set(activityId, membership.status);
          }
        });
      }
    }

    const favoriteRows = await this.favoriteModel.aggregate([
      { $match: { activity_id: { $in: activityIds } } },
      { $group: { _id: '$activity_id', count: { $sum: 1 } } },
    ]).exec();
    const favoriteCounts = new Map(favoriteRows.map((row: any) => [row._id.toString(), row.count]));
    const currentUserId = user?.userId || user?._id || user?.id;
    const userFavoriteIds = currentUserId && Types.ObjectId.isValid(currentUserId)
      ? new Set((await this.favoriteModel.find({ activity_id: { $in: activityIds }, user_id: new Types.ObjectId(currentUserId) }).select('activity_id').lean().exec()).map((row: any) => row.activity_id.toString()))
      : new Set<string>();
    return activities.map((activity: any) => ({
      ...activity,
      active_members_count: countByActivityId.get(activity._id.toString()) || 0,
      membership_status: membershipStatusByActivityId.get(activity._id.toString()) || 'none',
      favorite_count: favoriteCounts.get(activity._id.toString()) || 0,
      is_favorited: userFavoriteIds.has(activity._id.toString()),
    }));
  }

  private async countSelfServiceClubLeaves(studentId: string, semesterId: string): Promise<number> {
    const result = await this.memberModel.aggregate([
      { $match: { student_id: new Types.ObjectId(studentId), semester_id: new Types.ObjectId(semesterId) } },
      { $lookup: { from: 'activities', localField: 'activity_id', foreignField: '_id', as: 'activity' } },
      { $unwind: '$activity' },
      { $match: { 'activity.activity_type': 'club' } },
      { $group: { _id: null, total: { $sum: { $ifNull: ['$self_service_leave_count', 0] } } } },
    ]).exec();
    return result[0]?.total ?? 0;
  }

  async findOne(id: string, user?: any): Promise<ActivityDocument> {
    await this.ensureActivityDetailReadAccess(id, user);
    const activity = await this.activityModel
      .findById(id)
      .populate('advisor_id', 'user_name email phone_number')
      .populate('president_id', 'full_name student_code email')
      .populate('vice_president_ids', 'full_name student_code')
      .populate('semester_id', 'name')
      .exec();

    if (!activity) {
      throw new NotFoundException(`Không tìm thấy Hoạt động với ID: ${id}`);
    }
    return activity;
  }

  async update(id: string, dto: UpdateActivityDto, user?: any): Promise<ActivityDocument> {
    const currentActivity = await this.activityModel.findById(id);
    if (!currentActivity) {
      throw new NotFoundException(`Không tìm thấy Hoạt động với ID: ${id}`);
    }

    if (user && !isAdminUser(user)) {
      const userId = user.userId || user._id || user.id;
      const isAdvisor = currentActivity.advisor_id?.toString() === userId?.toString();
      
      let isPresident = false;
      if (userId && Types.ObjectId.isValid(userId)) {
        const student = await this.studentModel
          .findOne({ user_id: new Types.ObjectId(userId) })
          .exec();
        if (student && currentActivity.president_id?.toString() === student._id.toString()) {
          isPresident = true;
        }
      }

      if (!isAdvisor && !isPresident) {
        throw new ForbiddenException('Bạn không có quyền chỉnh sửa câu lạc bộ này');
      }
    }

    if (dto.classroom !== undefined && dto.classroom.trim() === '') {
      throw new BadRequestException('Phòng học/phòng hoạt động mặc định không được để trống');
    }

    const start =
      dto.activity_start_date !== undefined
        ? dto.activity_start_date
        : currentActivity.activity_start_date;
    const end =
      dto.activity_end_date !== undefined
        ? dto.activity_end_date
        : currentActivity.activity_end_date;

    if (start && end && new Date(end) < new Date(start)) {
      throw new BadRequestException(
        'Ngày kết thúc hoạt động không thể trước ngày bắt đầu',
      );
    }

    const hasAdvisorUpdate = Object.prototype.hasOwnProperty.call(dto, 'advisor_id');
    let advisorUpdate: any = undefined;
    if (hasAdvisorUpdate) {
      if (dto.advisor_id) {
        await this.validateAdvisor(dto.advisor_id);
        advisorUpdate = dto.advisor_id;
      } else {
        if (!user || !isAdminUser(user)) {
          throw new ForbiddenException('Only an administrator can select the default responsible account.');
        }
        advisorUpdate = user.userId || user._id || user.id;
      }
    }
    const updatePayload = { ...dto, ...(hasAdvisorUpdate ? { advisor_id: advisorUpdate } : {}) };

    const activity = await this.activityModel
      .findByIdAndUpdate(
        id,
        { $set: updatePayload },
        { returnDocument: 'after', runValidators: true },
      )
      .populate('advisor_id', 'user_name email')
      .populate('president_id', 'full_name student_code')
      .exec();

    if (!activity) {
      throw new NotFoundException(`Không tìm thấy Hoạt động với ID: ${id}`);
    }
    // Reference-safe cleanup of replaced/removed media
    if (this.storageService) {
      const oldMediaUrls: string[] = [
        currentActivity.logo_url,
        currentActivity.cover_url,
        currentActivity.background_config?.backgroundImageUrl,
        currentActivity.background_config?.backgroundFrameUrl,
        (currentActivity.settings as any)?.background?.backgroundImageUrl,
        (currentActivity.settings as any)?.background?.backgroundFrameUrl,
      ].filter(Boolean) as string[];

      const newMediaUrls: string[] = [
        activity.logo_url,
        activity.cover_url,
        activity.background_config?.backgroundImageUrl,
        activity.background_config?.backgroundFrameUrl,
        (activity.settings as any)?.background?.backgroundImageUrl,
        (activity.settings as any)?.background?.backgroundFrameUrl,
      ].filter(Boolean) as string[];

      const removedOrReplacedUrls = oldMediaUrls.filter((url) => !newMediaUrls.includes(url));

      for (const oldUrl of removedOrReplacedUrls) {
        if (!oldUrl || (/^https?:\/\//i.test(oldUrl) && !oldUrl.includes('/api/media/'))) {
          continue;
        }

        const storageKey = this.storageService.extractStorageKey(oldUrl, 'public/activities');
        if (!storageKey || !storageKey.startsWith('public/activities/')) continue;

        const remainingCount = await this.activityModel.countDocuments({
          $or: [
            { logo_url: oldUrl },
            { cover_url: oldUrl },
            { 'background_config.backgroundImageUrl': oldUrl },
            { 'background_config.backgroundFrameUrl': oldUrl },
            { 'settings.background.backgroundImageUrl': oldUrl },
            { 'settings.background.backgroundFrameUrl': oldUrl },
          ],
        });

        if (remainingCount === 0) {
          await this.storageService
            .quarantineFile(storageKey, 'activity_media_replaced', user?.email || user?.username || 'user')
            .catch(() => {});
        }
      }
    }

    return activity;
  }

  async remove(id: string, user?: any): Promise<{ message: string }> {
    const activity = await this.activityModel.findById(id);
    if (!activity) {
      throw new NotFoundException(`Không tìm thấy Hoạt động với ID: ${id}`);
    }

    if (user && !isAdminUser(user)) {
      const userId = user.userId || user._id || user.id;
      const isAdvisor = activity.advisor_id?.toString() === userId?.toString();
      if (!isAdvisor) {
        throw new ForbiddenException('Bạn không có quyền xóa câu lạc bộ này');
      }
    }

    // Soft delete: set status to inactive
    activity.status = 'inactive';
    await activity.save();

    return { message: `Đã vô hiệu hóa Hoạt động "${activity.name}"` };
  }

  // ── Member Management ──

  private getRequesterId(user?: any): string | undefined {
    return user?.userId || user?._id || user?.id;
  }

  private isAssignedAdvisor(activity: any, user?: any): boolean {
    const userId = this.getRequesterId(user);
    return Boolean(userId && activity?.advisor_id && activity.advisor_id.toString() === userId.toString());
  }

  private async ensureActivityMemberManagementAccess(
    activityId: string,
    user?: any,
  ): Promise<ActivityDocument> {
    const activity = await this.activityModel.findById(activityId).exec();
    if (!activity) throw new NotFoundException('Không tìm thấy Hoạt động');
    if (user && (isAdminUser(user) || this.isAssignedAdvisor(activity, user))) {
      return activity;
    }

    const userId = this.getRequesterId(user);
    if (userId && Types.ObjectId.isValid(userId)) {
      const student = await this.studentModel
        .findOne({ user_id: new Types.ObjectId(userId) })
        .exec();
      if (student && activity.president_id?.toString() === student._id.toString()) {
        return activity;
      }
    }

    throw new ForbiddenException('Bạn không có quyền quản lý thành viên của Hoạt động này');
  }

  private async ensureActivityReadAccess(activityId: string, user: any): Promise<ActivityDocument> {
    const activity = await this.activityModel.findById(activityId).exec();
    if (!activity) throw new NotFoundException('Không tìm thấy Hoạt động');
    if (!user || isAdminUser(user) || this.isAssignedAdvisor(activity, user) || (user?.permissions || []).includes('ACTIVITY_READ')) {
      return activity;
    }
    throw new ForbiddenException('Bạn không có quyền truy cập hoạt động này');
  }

  private async ensureActivityDetailReadAccess(activityId: string, user: any): Promise<ActivityDocument> {
    const activity = await this.activityModel.findById(activityId).exec();
    if (!activity) throw new NotFoundException('Activity not found');
    if (
      user
      && activity.status === 'active'
      && activity.participation_status === 'published'
      && activity.settings?.require_registration_for_attendance === false
    ) {
      return activity;
    }
    if (!user || isAdminUser(user) || this.isAssignedAdvisor(activity, user) || (user?.permissions || []).includes('ACTIVITY_READ')) {
      return activity;
    }
    throw new ForbiddenException('You do not have permission to access this activity');
  }

  async canAccessAsAssignedAdvisor(activityId: string, user?: any): Promise<boolean> {
    if (!user) return false;
    const activity = await this.activityModel.findById(activityId).select('advisor_id').lean().exec();
    return this.isAssignedAdvisor(activity, user);
  }

  async findMembers(
    activityId: string,
    query?: { status?: string; semester_id?: string },
    user?: any,
  ): Promise<any[]> {
    await this.ensureActivityReadAccess(activityId, user);
    const filter: any = { activity_id: new Types.ObjectId(activityId) };
    if (query?.status) filter.status = query.status;
    if (query?.semester_id)
      filter.semester_id = new Types.ObjectId(query.semester_id);

    const members = await this.memberModel
      .find({ ...filter, ...(query?.status ? {} : { status: { $ne: 'left' } }) })
      .populate('student_id', 'full_name student_code email sex status')
      .populate('user_id', 'user_name username email display_name')
      .populate('approved_by', 'user_name')
      .sort({ role: 1, createdAt: -1 })
      .lean()
      .exec();

    // Attach transfer info if exists
    const memberIds = members.map(m => m._id);
    const transfers = await this.transferModel.find({
      to_membership_id: { $in: memberIds },
    }).lean().exec();

    const studentIds = members.map((m: any) => m.student_id?._id || m.student_id).filter(Boolean);
    const leaveRows = studentIds.length ? await this.memberModel.aggregate([
      { $match: { student_id: { $in: studentIds.map((id: any) => new Types.ObjectId(id)) } } },
      { $lookup: { from: 'activities', localField: 'activity_id', foreignField: '_id', as: 'activity' } },
      { $unwind: '$activity' },
      { $match: { 'activity.activity_type': 'club' } },
      { $group: { _id: { student_id: '$student_id', semester_id: '$semester_id' }, total: { $sum: { $ifNull: ['$self_service_leave_count', 0] } } } },
    ]).exec() : [];
    const leaveByStudent = new Map(leaveRows.map((row: any) => [`${row._id.student_id.toString()}_${row._id.semester_id.toString()}`, row.total]));
    return members.map(m => {
      const t = transfers.find(tr => tr.to_membership_id.toString() === m._id.toString());
      return {
        ...m,
        transfer: t || null,
        self_service_leaves_remaining: Math.max(0, 3 - (leaveByStudent.get(`${(m.student_id?._id || m.student_id)?.toString()}_${m.semester_id?.toString()}`) || 0)),
      };
    });
  }

  async addMember(
    activityId: string,
    dto: AddActivityMemberDto,
    requester?: any,
  ): Promise<ActivityMemberDocument> {
    const activity = await this.ensureActivityMemberManagementAccess(activityId, requester);

    // Check max members
    if (activity.max_members) {
      const activeCount = await this.memberModel.countDocuments({
        activity_id: new Types.ObjectId(activityId),
        status: 'active',
        semester_id: new Types.ObjectId(dto.semester_id),
      });
      if (activeCount >= activity.max_members) {
        throw new BadRequestException(
          `Hoạt động đã đạt giới hạn ${activity.max_members} thành viên`,
        );
      }
    }

    // Check duplicate
    const existing = await this.memberModel.findOne({
      activity_id: new Types.ObjectId(activityId),
      student_id: new Types.ObjectId(dto.student_id),
      semester_id: new Types.ObjectId(dto.semester_id),
    });
    if (existing) {
      throw new BadRequestException(
        'Sinh viên đã là thành viên Hoạt động trong học kỳ này',
      );
    }

    const member = new this.memberModel({
      activity_id: new Types.ObjectId(activityId),
      student_id: new Types.ObjectId(dto.student_id),
      role: dto.role || 'member',
      status: 'active', // Admin/advisor adds directly as active
      joined_at: new Date(),
      semester_id: new Types.ObjectId(dto.semester_id),
    });

    return member.save();
  }

  async joinActivity(
    activityId: string,
    studentIdOrUserId: string,
    dto: JoinActivityDto,
  ): Promise<any> {
    const linkedStudent = Types.ObjectId.isValid(studentIdOrUserId)
      ? await this.studentModel.findOne({ $or: [{ user_id: new Types.ObjectId(studentIdOrUserId) }, { _id: new Types.ObjectId(studentIdOrUserId) }] }).exec()
      : null;
    const principalUser = !linkedStudent && Types.ObjectId.isValid(studentIdOrUserId)
      ? await this.userModel.findById(studentIdOrUserId).populate('role').exec()
      : null;
    if (principalUser && isAdminUser(principalUser) && !linkedStudent) {
      const activity = await this.validateTargetActivity(activityId, dto.semester_id, principalUser._id.toString());
      if (!activity.settings?.allow_self_registration) throw new ForbiddenException('Hoạt động không cho phép tự đăng ký');
      const existing = await this.memberModel.findOne({ activity_id: activity._id, user_id: principalUser._id, semester_id: new Types.ObjectId(dto.semester_id) }).exec();
      if (existing && existing.status !== 'left') throw new BadRequestException('Bạn đã đăng ký Hoạt động này trong học kỳ hiện tại');
      const member = existing || new this.memberModel({ activity_id: activity._id, user_id: principalUser._id, role: 'member', semester_id: new Types.ObjectId(dto.semester_id) });
      member.status = activity.settings?.require_approval ? 'pending' : 'active';
      member.joined_at = member.status === 'active' ? new Date() : undefined;
      member.left_at = undefined;
      member.occupies_slot = false;
      await member.save();
      return { membership: member, transfer: null, self_service_changes_used: 0, self_service_changes_remaining: 3, requires_teacher_approval: false, first_schedule_start_time: null };
    }
    const studentId = await this.resolveStudentId(studentIdOrUserId);
    const userId = studentIdOrUserId;

    // Validate target activity early
    const activity = await this.validateTargetActivity(activityId, dto.semester_id, studentId);
    if (['draft', 'completed', 'cancelled'].includes(activity.participation_status)) {
      throw new BadRequestException('Không thể đăng ký tham gia hoạt động ở trạng thái nháp, đã hoàn thành hoặc đã hủy');
    }

    if (!activity.settings?.allow_self_registration) {
      throw new ForbiddenException('Hoạt động không cho phép tự đăng ký');
    }

    const isClub = !activity.activity_type || activity.activity_type === 'club';
    let occupiesSlot = false;
    let requiresTeacherApproval = false;
    let firstSchedule: ActivityScheduleDocument | null = null;
    let previousMember: ActivityMemberDocument | null = null;

    if (isClub) {
      occupiesSlot = true;

      // Check occupied membership in other clubs
      const occupied = await this.findOccupiedMembership(studentId, dto.semester_id);
      if (occupied) {
        if (occupied.activity_id.toString() === activityId) {
          throw new BadRequestException('Bạn đã đăng ký Câu lạc bộ này trong học kỳ hiện tại');
        } else {
          throw new BadRequestException('Bạn đã có câu lạc bộ hoạt động trong học kỳ này. Vui lòng sử dụng chức năng chuyển câu lạc bộ.');
        }
      }

      // Find previous left membership in this semester
      previousMember = await this.findLatestLeftMembership(studentId, dto.semester_id);

      if (previousMember) {
        firstSchedule = await this.getFirstNonCancelledSchedule(
          previousMember.activity_id.toString(),
          dto.semester_id,
        );
        if (firstSchedule && new Date() >= new Date(firstSchedule.start_time)) {
          requiresTeacherApproval = true;
        }
      }
    }

    // Check duplicate/existing membership record for this target club
    let member = await this.memberModel.findOne({
      activity_id: new Types.ObjectId(activityId),
      student_id: new Types.ObjectId(studentId),
      semester_id: new Types.ObjectId(dto.semester_id),
    });

    let transferRecord: ActivityMembershipTransferDocument | null = null;

    if (member) {
      if (member.status === 'rejected') {
        throw new ForbiddenException('Bạn đã bị từ chối gia nhập Hoạt động này trong học kỳ hiện tại.');
      }
      if (member.status !== 'left') {
        throw new BadRequestException('Bạn đã đăng ký Hoạt động này trong học kỳ hiện tại');
      }
      
      // Rejoining a activity they left
      member.status = (requiresTeacherApproval || activity.settings?.require_approval)
        ? 'pending'
        : 'active';
      member.joined_at = (requiresTeacherApproval || activity.settings?.require_approval)
        ? undefined
        : new Date();
      member.left_at = undefined;
      member.occupies_slot = occupiesSlot;
      await member.save();
    } else {
      // First time registering for this target club
      member = new this.memberModel({
        activity_id: new Types.ObjectId(activityId),
        student_id: new Types.ObjectId(studentId),
        role: 'member',
        status: (requiresTeacherApproval || activity.settings?.require_approval) ? 'pending' : 'active',
        joined_at: (requiresTeacherApproval || activity.settings?.require_approval) ? undefined : new Date(),
        semester_id: new Types.ObjectId(dto.semester_id),
        occupies_slot: occupiesSlot,
      });
      await member.save();
    }

    // Create a transfer record if activity started for the previous activity (only for 'club' type)
    if (isClub && requiresTeacherApproval && previousMember) {
      await this.transferModel.deleteMany({
        to_membership_id: member._id,
      });
      transferRecord = new this.transferModel({
        student_id: new Types.ObjectId(studentId),
        semester_id: new Types.ObjectId(dto.semester_id),
        from_activity_id: previousMember.activity_id,
        to_activity_id: new Types.ObjectId(activityId),
        from_membership_id: previousMember._id,
        to_membership_id: member._id,
        mode: 'teacher_approval',
        status: 'pending',
        requested_by: new Types.ObjectId(userId),
        requested_at: new Date(),
      });
      await transferRecord.save();
    }

    const completedChanges = isClub
      ? await this.countCompletedSelfServiceTransfers(studentId, dto.semester_id)
      : 0;

    return {
      membership: member,
      transfer: transferRecord || null,
      self_service_changes_used: completedChanges,
      self_service_changes_remaining: isClub ? Math.max(0, 3 - completedChanges) : 0,
      requires_teacher_approval: requiresTeacherApproval,
      first_schedule_start_time: firstSchedule ? firstSchedule.start_time : null,
    };
  }

  async approveMember(
    activityId: string,
    memberId: string,
    dto: ApproveMemberDto,
    userId: string,
  ): Promise<ActivityMemberDocument> {
    const activity = await this.activityModel.findById(activityId);
    if (!activity) {
      throw new NotFoundException('Không tìm thấy Hoạt động');
    }

    const member = await this.memberModel.findOne({
      _id: new Types.ObjectId(memberId),
      activity_id: new Types.ObjectId(activityId),
    }).exec();

    if (!member) {
      throw new NotFoundException('Không tìm thấy thành viên');
    }
    if (member.status !== 'pending') {
      throw new BadRequestException('Chỉ có thể duyệt đăng ký đang chờ');
    }

    // Check if there is a pending teacher approval transfer request for this membership
    const transfer = await this.transferModel.findOne({
      to_membership_id: member._id,
      status: 'pending',
      mode: 'teacher_approval',
    }).exec();

    const requester = await this.userModel.findById(userId).populate('role').exec();
    const isAdminApprover = requester ? isAdminUser(requester) : false;
    const isAssignedAdvisor = activity.advisor_id?.toString() === userId.toString();

    if (!isAdminApprover && !isAssignedAdvisor) {
      throw new ForbiddenException('Chỉ giáo viên cố vấn được phân công hoặc quản trị viên mới có quyền phê duyệt hoặc từ chối thành viên.');
    }

    if (dto.status === 'active') {
      member.status = 'active';
      member.approved_by = new Types.ObjectId(userId);
      member.joined_at = new Date();
      await member.save();

      if (transfer) {
        transfer.status = 'completed';
        transfer.decided_by = new Types.ObjectId(userId);
        transfer.decided_at = new Date();
        await transfer.save();
      }
    } else if (dto.status === 'rejected') {
      member.status = 'rejected';
      member.approved_by = new Types.ObjectId(userId);
      member.occupies_slot = false;
      await member.save();

      if (transfer) {
        transfer.status = 'rejected';
        transfer.decided_by = new Types.ObjectId(userId);
        transfer.decided_at = new Date();
        await transfer.save();
      }
    }

    return member;
  }

  async leaveActivity(
    activityId: string,
    studentIdOrUserId: string,
    dto: LeaveActivityDto,
  ): Promise<any> {
    const studentId = await this.resolveStudentId(studentIdOrUserId);
    
    // Find the student's membership in this activity for the given semester
    const activity = await this.activityModel.findById(activityId);
    const member = await this.memberModel.findOne({
      activity_id: new Types.ObjectId(activityId),
      student_id: new Types.ObjectId(studentId),
      semester_id: new Types.ObjectId(dto.semester_id),
      status: { $in: ['active', 'pending'] },
    }).exec();

    if (!member) {
      throw new NotFoundException('Không tìm thấy tư cách thành viên đang hoạt động hoặc đang chờ duyệt');
    }

    const isClubActiveLeave = activity?.activity_type === 'club' && member.status === 'active';
    const leavesUsed = isClubActiveLeave ? await this.countSelfServiceClubLeaves(studentId, dto.semester_id) : 0;
    if (isClubActiveLeave && leavesUsed >= 3) throw new BadRequestException('Club leave limit reached');
    let updated: ActivityMemberDocument | null;
    if (isClubActiveLeave) {
      updated = await this.memberModel.findOneAndUpdate(
        {
          _id: member._id,
          status: 'active',
          $or: [
            { self_service_leave_count: { $lt: 3 } },
            { self_service_leave_count: { $exists: false } },
          ],
        },
        { $set: { status: 'left', left_at: new Date(), occupies_slot: false }, $inc: { self_service_leave_count: 1 } },
        { returnDocument: 'after' },
      ).exec();
    } else {
      member.status = 'left'; member.left_at = new Date(); member.occupies_slot = false;
      await member.save();
      updated = member;
    }
    if (!updated) throw new ConflictException('Membership changed; please retry');

    const completedChanges = await this.countCompletedSelfServiceTransfers(studentId, dto.semester_id);

    const updatedLeavesUsed = isClubActiveLeave ? leavesUsed + 1 : 0;
    return {
      membership: updated,
      transfer: null,
      self_service_changes_used: completedChanges,
      self_service_changes_remaining: Math.max(0, 3 - completedChanges),
      self_service_leaves_used: updatedLeavesUsed,
      self_service_leaves_remaining: Math.max(0, 3 - updatedLeavesUsed),
      requires_teacher_approval: false,
      first_schedule_start_time: null,
    };
  }

  async switchActivity(
    targetActivityId: string,
    studentIdOrUserId: string,
    dto: SwitchActivityDto,
  ): Promise<any> {
    const studentId = await this.resolveStudentId(studentIdOrUserId);
    const userId = studentIdOrUserId;

    // Find the current occupied membership
    const sourceMember = await this.findOccupiedMembership(studentId, dto.semester_id);
    if (!sourceMember) {
      throw new BadRequestException('Bạn chưa có câu lạc bộ hoạt động để thực hiện chuyển đổi.');
    }

    const sourceActivityId = sourceMember.activity_id.toString();
    if (sourceActivityId === targetActivityId) {
      throw new BadRequestException('Câu lạc bộ đích trùng với câu lạc bộ hiện tại.');
    }

    // Resolve source club's first non-cancelled schedule
    const firstSchedule = await this.getFirstNonCancelledSchedule(sourceActivityId, dto.semester_id);
    if (!firstSchedule) {
      throw new ConflictException('Không thể tự chuyển câu lạc bộ do câu lạc bộ hiện tại chưa cấu hình lịch hoạt động.');
    }

    // Check if activity has started
    if (new Date() >= new Date(firstSchedule.start_time)) {
      throw new ForbiddenException('Thời gian hoạt động của câu lạc bộ hiện tại đã bắt đầu. Vui lòng liên hệ Giảng viên cố vấn Hoạt động mới để duyệt yêu cầu.');
    }

    // Check self-service changes count
    const completedChanges = await this.countCompletedSelfServiceTransfers(studentId, dto.semester_id);
    if (completedChanges >= 3) {
      throw new ForbiddenException('Bạn đã dùng hết 3 lượt tự chuyển câu lạc bộ trong học kỳ này. Vui lòng liên hệ Admin để chuyển đổi trực tiếp.');
    }

    const targetActivity = await this.validateTargetActivity(targetActivityId, dto.semester_id, studentId);

    const existingTargetMember = await this.memberModel.findOne({
      activity_id: new Types.ObjectId(targetActivityId),
      student_id: new Types.ObjectId(studentId),
      semester_id: new Types.ObjectId(dto.semester_id),
    });
    if (existingTargetMember && existingTargetMember.status === 'rejected') {
      throw new ForbiddenException('Bạn đã bị từ chối gia nhập Hoạt động này trong học kỳ hiện tại.');
    }

    // Perform transaction
    const session = await this.connection.startSession();
    session.startTransaction();

    let targetMember: ActivityMemberDocument | null = null;
    let transferRecord: ActivityMembershipTransferDocument | null = null;

    try {
      // 1. Release source membership
      sourceMember.status = 'left';
      sourceMember.left_at = new Date();
      sourceMember.occupies_slot = false;
      await sourceMember.save({ session });

      // 2. Reactivate or create target membership
      targetMember = await this.memberModel.findOne({
        activity_id: new Types.ObjectId(targetActivityId),
        student_id: new Types.ObjectId(studentId),
        semester_id: new Types.ObjectId(dto.semester_id),
      }).session(session).exec();

      if (targetMember) {
        targetMember.status = 'active'; // switch is immediate pre-activity
        targetMember.joined_at = new Date();
        targetMember.left_at = undefined;
        targetMember.occupies_slot = true;
        await targetMember.save({ session });
      } else {
        targetMember = new this.memberModel({
          activity_id: new Types.ObjectId(targetActivityId),
          student_id: new Types.ObjectId(studentId),
          role: 'member',
          status: 'active',
          joined_at: new Date(),
          semester_id: new Types.ObjectId(dto.semester_id),
          occupies_slot: true,
        });
        await targetMember.save({ session });
      }

      // 3. Create transfer record
      await this.transferModel.deleteMany({
        to_membership_id: targetMember._id,
      }).session(session);
      transferRecord = new this.transferModel({
        student_id: new Types.ObjectId(studentId),
        semester_id: new Types.ObjectId(dto.semester_id),
        from_activity_id: sourceMember.activity_id,
        to_activity_id: new Types.ObjectId(targetActivityId),
        from_membership_id: sourceMember._id,
        to_membership_id: targetMember._id,
        mode: 'self_service',
        status: 'completed',
        requested_by: new Types.ObjectId(userId),
        decided_by: new Types.ObjectId(userId),
        requested_at: new Date(),
        decided_at: new Date(),
      });
      await transferRecord.save({ session });

      await session.commitTransaction();
    } catch (error) {
      await session.abortTransaction();
      if (error.code === 11000) {
        throw new ConflictException('Có lỗi xung đột vị trí câu lạc bộ (slot conflict) xảy ra.');
      }
      throw error;
    } finally {
      await session.endSession();
    }

    const updatedChanges = completedChanges + 1;

    return {
      membership: targetMember,
      transfer: transferRecord,
      self_service_changes_used: updatedChanges,
      self_service_changes_remaining: Math.max(0, 3 - updatedChanges),
      requires_teacher_approval: false,
      first_schedule_start_time: firstSchedule.start_time,
    };
  }

  async adminTransferActivity(
    targetActivityId: string,
    requesterUserId: string,
    dto: AdminTransferActivityDto,
  ): Promise<any> {
    // Repeated admin check
    const requester = await this.userModel.findById(requesterUserId).populate('role').exec();
    if (!requester || !isAdminUser(requester)) {
      throw new ForbiddenException('Chỉ quản trị viên mới được phép thực hiện thao tác này.');
    }

    const studentId = dto.student_id;
    const semesterId = dto.semester_id;

    // Check current occupied membership
    const sourceMember = await this.findOccupiedMembership(studentId, semesterId);
    if (!sourceMember) {
      throw new BadRequestException('Sinh viên chưa đăng ký câu lạc bộ nào hoạt động trong học kỳ này.');
    }

    const sourceActivityId = sourceMember.activity_id.toString();
    if (sourceActivityId === targetActivityId) {
      throw new BadRequestException('Câu lạc bộ đích trùng với câu lạc bộ hiện tại.');
    }

    const targetActivity = await this.validateTargetActivity(targetActivityId, semesterId, studentId);

    // Perform transaction
    const session = await this.connection.startSession();
    session.startTransaction();

    let targetMember: ActivityMemberDocument | null = null;
    let transferRecord: ActivityMembershipTransferDocument | null = null;

    try {
      // 1. Release source membership
      sourceMember.status = 'left';
      sourceMember.left_at = new Date();
      sourceMember.occupies_slot = false;
      await sourceMember.save({ session });

      // 2. Reactivate or create target membership
      targetMember = await this.memberModel.findOne({
        activity_id: new Types.ObjectId(targetActivityId),
        student_id: new Types.ObjectId(studentId),
        semester_id: new Types.ObjectId(semesterId),
      }).session(session).exec();

      if (targetMember) {
        targetMember.status = 'active';
        targetMember.joined_at = new Date();
        targetMember.left_at = undefined;
        targetMember.occupies_slot = true;
        await targetMember.save({ session });
      } else {
        targetMember = new this.memberModel({
          activity_id: new Types.ObjectId(targetActivityId),
          student_id: new Types.ObjectId(studentId),
          role: 'member',
          status: 'active',
          joined_at: new Date(),
          semester_id: new Types.ObjectId(semesterId),
          occupies_slot: true,
        });
        await targetMember.save({ session });
      }

      // 3. Create transfer record
      await this.transferModel.deleteMany({
        to_membership_id: targetMember._id,
      }).session(session);
      transferRecord = new this.transferModel({
        student_id: new Types.ObjectId(studentId),
        semester_id: new Types.ObjectId(semesterId),
        from_activity_id: sourceMember.activity_id,
        to_activity_id: new Types.ObjectId(targetActivityId),
        from_membership_id: sourceMember._id,
        to_membership_id: targetMember._id,
        mode: 'admin_direct',
        status: 'completed',
        requested_by: new Types.ObjectId(requesterUserId),
        decided_by: new Types.ObjectId(requesterUserId),
        requested_at: new Date(),
        decided_at: new Date(),
      });
      await transferRecord.save({ session });

      await session.commitTransaction();
    } catch (error) {
      await session.abortTransaction();
      if (error.code === 11000) {
        throw new ConflictException('Có lỗi xung đột vị trí câu lạc bộ (slot conflict) xảy ra.');
      }
      throw error;
    } finally {
      await session.endSession();
    }

    const completedChanges = await this.countCompletedSelfServiceTransfers(studentId, semesterId);

    return {
      membership: targetMember,
      transfer: transferRecord,
      self_service_changes_used: completedChanges,
      self_service_changes_remaining: Math.max(0, 3 - completedChanges),
      requires_teacher_approval: false,
      first_schedule_start_time: null,
    };
  }

  async updateMember(
    activityId: string,
    memberId: string,
    dto: UpdateActivityMemberDto,
    requester?: any,
  ): Promise<ActivityMemberDocument> {
    await this.ensureActivityMemberManagementAccess(activityId, requester);
    const member = await this.memberModel.findOneAndUpdate(
      {
        _id: new Types.ObjectId(memberId),
        activity_id: new Types.ObjectId(activityId),
      },
      { $set: dto },
      { returnDocument: 'after' },
    );

    if (!member) {
      throw new NotFoundException('Không tìm thấy thành viên');
    }
    return member;
  }

  async removeMember(
    activityId: string,
    memberId: string,
    requester?: any,
  ): Promise<{ message: string }> {
    await this.ensureActivityMemberManagementAccess(activityId, requester);
    const member = await this.memberModel.findOneAndUpdate(
      {
        _id: new Types.ObjectId(memberId),
        activity_id: new Types.ObjectId(activityId),
      },
      { $set: { status: 'left', left_at: new Date() } },
      { returnDocument: 'after' },
    );

    if (!member) {
      throw new NotFoundException('Không tìm thấy thành viên');
    }
    return { message: 'Đã xóa thành viên khỏi Hoạt động' };
  }

  async removeMembers(activityId: string, memberIds: string[], requester?: any): Promise<{ deletedIds: string[]; failedIds: string[] }> {
    await this.ensureActivityMemberManagementAccess(activityId, requester);
    const eligible = await this.memberModel.find({ _id: { $in: memberIds.map((id) => new Types.ObjectId(id)) }, activity_id: new Types.ObjectId(activityId), status: { $ne: 'left' } }).select('_id').lean().exec();
    const deletedIds = eligible.map((member) => member._id.toString());
    await this.memberModel.updateMany(
      { _id: { $in: eligible.map((member) => member._id) } },
      { $set: { status: 'left', left_at: new Date() } },
    ).exec();
    return { deletedIds, failedIds: memberIds.filter((id) => !deletedIds.includes(id)) };
  }

  async getMyTransferPolicy(userId: string, semesterId: string): Promise<any> {
    const studentId = await this.resolveStudentId(userId);
    const completedChanges = await this.countCompletedSelfServiceTransfers(studentId, semesterId);
    const occupied = await this.findOccupiedMembership(studentId, semesterId);
    const leavesUsed = await this.countSelfServiceClubLeaves(studentId, semesterId);
    
    let firstSchedule: ActivityScheduleDocument | null = null;
    if (occupied) {
      firstSchedule = await this.getFirstNonCancelledSchedule(occupied.activity_id.toString(), semesterId);
    }

    return {
      self_service_changes_used: completedChanges,
      self_service_changes_remaining: Math.max(0, 3 - completedChanges),
      occupied_activity_id: occupied ? occupied.activity_id.toString() : null,
      first_schedule_start_time: firstSchedule ? firstSchedule.start_time : null,
      self_service_leaves_used: leavesUsed,
      self_service_leaves_remaining: Math.max(0, 3 - leavesUsed),
    };
  }

  async getMyActivities(studentIdOrUserId: string): Promise<any[]> {
    let studentId = studentIdOrUserId;
    if (studentIdOrUserId && Types.ObjectId.isValid(studentIdOrUserId)) {
      const student = await this.studentModel
        .findOne({ user_id: new Types.ObjectId(studentIdOrUserId) })
        .exec();
      if (student) {
        studentId = student._id.toString();
      } else {
        const user = await this.userModel.findById(studentIdOrUserId).populate('role').exec();
        if (user && isAdminUser(user)) {
          return this.memberModel.find({ user_id: user._id, status: { $in: ['active', 'pending'] } })
            .populate({ path: 'activity_id', populate: [{ path: 'advisor_id', select: 'user_name email' }, { path: 'president_id', select: 'full_name student_code' }] })
            .populate('semester_id', 'name').lean().exec();
        }
      }
    }

    const memberships = await this.memberModel
      .find({
        student_id: new Types.ObjectId(studentId),
        status: { $in: ['active', 'pending'] },
      })
      .populate({
        path: 'activity_id',
        populate: [
          { path: 'advisor_id', select: 'user_name email' },
          { path: 'president_id', select: 'full_name student_code' },
        ],
      })
      .populate('semester_id', 'name')
      .lean()
      .exec();

    return memberships;
  }

  async getActivityStats(activityId: string): Promise<any> {
    const [activity, memberStats, favoriteCount] = await Promise.all([
      this.activityModel.findById(activityId).lean(),
      this.memberModel.aggregate([
        { $match: { activity_id: new Types.ObjectId(activityId) } },
        {
          $group: {
            _id: '$status',
            count: { $sum: 1 },
          },
        },
      ]),
      this.favoriteModel.countDocuments({
        activity_id: new Types.ObjectId(activityId),
      }),
    ]);

    if (!activity) {
      throw new NotFoundException('Không tìm thấy Hoạt động');
    }

    const stats: any = {
      club_name: activity.name,
      total_members: 0,
      active_members: 0,
      pending_members: 0,
      favorite_count: favoriteCount,
    };

    memberStats.forEach((s: any) => {
      stats[`${s._id}_members`] = s.count;
      stats.total_members += s.count;
    });

    return stats;
  }

  async favoriteActivity(
    activityId: string,
    userId: string,
  ): Promise<{
    activity_id: string;
    is_favorited: boolean;
    favorite_count: number;
  }> {
    const activity = await this.activityModel.findById(activityId);
    if (!activity) {
      throw new NotFoundException(`Không tìm thấy Hoạt động với ID: ${activityId}`);
    }

    const existing = await this.favoriteModel.findOne({
      activity_id: new Types.ObjectId(activityId),
      user_id: new Types.ObjectId(userId),
    });

    if (!existing) {
      try {
        await new this.favoriteModel({
          activity_id: new Types.ObjectId(activityId),
          user_id: new Types.ObjectId(userId),
        }).save();
      } catch (error: any) {
        if (error.code !== 11000) {
          throw error;
        }
        // Concurrent duplicate — treat as idempotent success
      }
    }

    const favoriteCount = await this.favoriteModel.countDocuments({
      activity_id: new Types.ObjectId(activityId),
    });
    this.realtime.publishFavoriteUpdated(activityId, favoriteCount);

    return {
      activity_id: activityId,
      is_favorited: true,
      favorite_count: favoriteCount,
    };
  }

  async unfavoriteActivity(
    activityId: string,
    userId: string,
  ): Promise<{
    activity_id: string;
    is_favorited: boolean;
    favorite_count: number;
  }> {
    const activity = await this.activityModel.findById(activityId);
    if (!activity) {
      throw new NotFoundException(`Không tìm thấy Hoạt động với ID: ${activityId}`);
    }

    await this.favoriteModel
      .findOneAndDelete({
        activity_id: new Types.ObjectId(activityId),
        user_id: new Types.ObjectId(userId),
      })
      .exec();

    const favoriteCount = await this.favoriteModel.countDocuments({
      activity_id: new Types.ObjectId(activityId),
    });
    this.realtime.publishFavoriteUpdated(activityId, favoriteCount);

    return {
      activity_id: activityId,
      is_favorited: false,
      favorite_count: favoriteCount,
    };
  }

  async getMyFavoriteActivityIds(userId: string): Promise<{ activity_ids: string[] }> {
    const favorites = await this.favoriteModel
      .find({
        user_id: new Types.ObjectId(userId),
      })
      .lean()
      .exec();

    return {
      activity_ids: favorites.map((f) => f.activity_id.toString()),
    };
  }

  async isAdvisorOrPresident(activityId: string, userId: string): Promise<boolean> {
    const activity = await this.activityModel.findById(activityId).lean();
    if (!activity) return false;

    const advisorId = activity.advisor_id?.toString();
    return advisorId === userId;
  }
}
