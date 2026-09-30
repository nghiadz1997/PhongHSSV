'use client';

import React, { useEffect, useRef, useState } from 'react';
import { useParams, useRouter, useSearchParams } from 'next/navigation';
import {
  activityApi,
  activityScheduleApi,
  activityCompletionRuleApi,
  Activity,
  ActivityMember,
  ActivitySchedule,
  ActivityCompletionRule
} from '@/api/activity-api';
import { semesterApi, Semester } from '@/api/semester-api';
import { classApi } from '@/api/class-api';
import { useAuth, isAdminUser } from '@/providers/auth-provider';
import { criteriaApi } from '@/api/criteria-api';
import { isTeacherRole, isStudentRole } from '@/utils/role.util';
import { toast } from 'sonner';
import {
  Compass, Calendar, Users, Award, ShieldAlert,
  ChevronLeft, Sparkles, UserCheck,
  Settings, Clock, MapPin, User, Star, CheckCircle2,
  ClipboardCheck, Radio, QrCode, Camera, UserPlus, LogOut, XCircle
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { getActivityViewPolicy, getImageUrl } from '@/components/activities/activity-view-policy';
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import ConfirmModal from '@/components/modals/ConfirmModal';
import ActivityMemberTable from '@/components/activities/ActivityMemberTable';
import ActivityScheduleTimeline from '@/components/activities/ActivityScheduleTimeline';
import ActivityCompletionRuleForm from '@/components/activities/ActivityCompletionRuleForm';
import { useAttendanceSession } from '@/hooks/useAttendanceSession';
import AttendanceMethodSelector from '@/components/attendance/AttendanceMethodSelector';
import AttendanceSessionStatus from '@/components/attendance/AttendanceSessionStatus';
import QrDisplayPanel from '@/components/attendance/QrDisplayPanel';
import QrScannerModal from '@/components/attendance/QrScannerModal';
import ProximityPanel from '@/components/attendance/ProximityPanel';
import ProximityCheckinModal from '@/components/attendance/ProximityCheckinModal';
import ProximityCheckinButton from '@/components/attendance/ProximityCheckinButton';
import AttendanceGrantManager from '@/components/attendance/AttendanceGrantManager';
import ManualAttendanceGrid from '@/components/attendance/ManualAttendanceGrid';

const categoryLabels: Record<string, string> = {
  academic: 'Học thuật',
  sports: 'Thể thao',
  art: 'Nghệ thuật',
  volunteer: 'Tình nguyện',
  technology: 'Công nghệ',
  other: 'Khác',
};

const typeLabels: Record<string, string> = {
  club: 'Câu lạc bộ',
  event: 'Sự kiện',
  activity: 'Hoạt động',
  festival: 'Lễ hội',
};

const normalizeEntityId = (value: any) => {
  if (value && typeof value === 'object') {
    return value._id || value.id || '';
  }
  return value || '';
};

const getTodaySchedule = (schedules: ActivitySchedule[]) => {
  const formatter = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Ho_Chi_Minh', year: 'numeric', month: '2-digit', day: '2-digit',
  });
  const today = formatter.format(new Date());
  return schedules.find((schedule) =>
    schedule?.status !== 'cancelled' && formatter.format(new Date(schedule.start_time)) === today,
  );
};

const isScheduleOpenWindow = (schedule?: ActivitySchedule, now = new Date()) => {
  if (!schedule || schedule.status === 'cancelled') return false;
  const start = new Date(schedule.start_time).getTime();
  const end = new Date(schedule.end_time).getTime();
  return Number.isFinite(start) && Number.isFinite(end) && start <= end && now.getTime() >= start && now.getTime() <= end;
};

const getCriterionLabel = (criterion: any, criteriaById: Record<string, string>) => {
  const id = normalizeEntityId(criterion);

  if (criterion && typeof criterion === 'object') {
    return criterion.criterion_name || criterion.name || criteriaById[id] || id || '';
  }

  return criteriaById[id] || id || '';
};

export default function ActivityDetailPage() {
  const params = useParams();
  const router = useRouter();
  const searchParams = useSearchParams();
  const tabParam = searchParams.get('tab');
  const { user } = useAuth();
  const activityId = params.activityId as string;

  const [activity, setActivity] = useState<Activity | null>(null);
  const [members, setMembers] = useState<ActivityMember[]>([]);
  const [schedules, setSchedules] = useState<ActivitySchedule[]>([]);
  const [timelineViewerMode, setTimelineViewerMode] = useState<'student' | 'staff' | null>(null);
  const [completionRule, setCompletionRule] = useState<ActivityCompletionRule | null>(null);
  const [criteriaById, setCriteriaById] = useState<Record<string, string>>({});
  const [activeSemester, setActiveSemester] = useState<Semester | null>(null);
  
  const [activeTab, setActiveTab] = useState<'info' | 'members' | 'rule' | 'attendance'>('info');

  useEffect(() => {
    if (tabParam === 'schedule') {
      setActiveTab('info');
    } else if (tabParam && ['info', 'members', 'rule', 'attendance'].includes(tabParam)) {
      setActiveTab(tabParam as typeof activeTab);
    }
  }, [tabParam]);

  const handleTabChange = (tab: typeof activeTab) => {
    setActiveTab(tab);
    const newParams = new URLSearchParams(window.location.search);
    newParams.set('tab', tab);
    router.replace(`/activities/${activityId}?${newParams.toString()}`);
  };

  const [loading, setLoading] = useState(true);
  const [joining, setJoining] = useState(false);
  const [leaving, setLeaving] = useState(false);
  const [leaveRemaining, setLeaveRemaining] = useState<number | null>(null);
  const [showLeaveConfirm, setShowLeaveConfirm] = useState(false);
  const [showMethodSelector, setShowMethodSelector] = useState(false);
  const [showQrScanner, setShowQrScanner] = useState(false);
  const [showMemberProximity, setShowMemberProximity] = useState(false);
  const [showRuleModal, setShowRuleModal] = useState(false);
  const [updatingLogo, setUpdatingLogo] = useState(false);
  const [logoLoadFailed, setLogoLoadFailed] = useState(false);
  const logoInputRef = useRef<HTMLInputElement>(null);

  const isAdmin = isAdminUser(user);
  const isAssignedTeacher = isTeacherRole(user) && Boolean(activity?.advisor_id) && normalizeEntityId(activity.advisor_id) === normalizeEntityId(user?.id);
  const isStudent = isStudentRole(user);
  const canUseMemberFlow = isStudent || isAdmin;
  const activityPolicy = getActivityViewPolicy({
    permissions: user?.permissions || [],
    isAdmin,
    isStudent,
    isOwner: isAssignedTeacher,
  });
  const canManageAttendancePermission = isAdmin || [
    'ATTENDANCE_SESSION_CREATE',
    'ACTIVITY_ATTENDANCE_CREATE',
    'ACTIVITY_ATTENDANCE_UPDATE',
    'ACTIVITY_ATTENDANCE_APPROVE',
  ].some((permission) => (user?.permissions || []).includes(permission));
  const isAdminOrAdvisor = activityPolicy.canUpdate || activityPolicy.canManageSchedule || canManageAttendancePermission;
  const canViewStaffTabs = activityPolicy.canManageMembers;
  const todayScheduleId = getTodaySchedule(schedules)?._id;

  const attendance = useAttendanceSession({
    contextType: activity?.activity_type === 'club' ? 'club' : 'activity',
    contextId: activityId,
    enabled: Boolean(activityId),
    activityId,
    currentUserId: normalizeEntityId(user?.id),
    manualScheduleId: todayScheduleId,
    canManage: canManageAttendancePermission && (isAdmin || isAssignedTeacher || members.some((member) => member.status === 'active' && member.role === 'president' && (
      normalizeEntityId(member.student_id) === user?.studentId || normalizeEntityId(member.user_id) === user?.id
    ))),
  });


  const loadActivityData = async () => {
    try {
      setLoading(true);
      const [actData, membersData, schedulesResponse, rulesList, criteriaList, semesters] = await Promise.all([
        activityApi.getById(activityId),
        activityApi.getMembers(activityId).catch(() => []),
        activityScheduleApi.getActivityTimeline(activityId).catch(() => ({ items: [] } as any)),
        activityCompletionRuleApi.getAll().catch(() => []),
        (async () => criteriaApi.getCriteria())().catch(() => []),
        semesterApi.getSemesters().catch(() => []),
      ]);

      setActivity(actData);
      setLogoLoadFailed(false);
      setMembers(membersData);
      const loadedStudentMembership = membersData.find((m: any) => normalizeEntityId(m.student_id) === user?.studentId || normalizeEntityId(m.user_id) === user?.id);
      const semesterId = normalizeEntityId(actData.semester_id);
      const memberProgress = semesterId
        ? (await Promise.resolve(activityCompletionRuleApi.getMemberProgress?.(activityId, semesterId)).catch(() => [])) ?? []
        : [];
      const progressByMember = new Map(memberProgress.map((item) => [item.member_id, item.participation_count]));
      setMembers(membersData.map((member: ActivityMember) => ({ ...member, participation_count: progressByMember.get(member._id) ?? 0 })));
      if (isStudent && actData.activity_type === 'club' && loadedStudentMembership?.status === 'active' && semesterId) {
        const policy = await activityApi.getMyTransferPolicy({ semester_id: semesterId }).catch(() => null);
        setLeaveRemaining(policy?.self_service_leaves_remaining ?? null);
      } else setLeaveRemaining(null);
      setCriteriaById(
        (Array.isArray(criteriaList) ? criteriaList : []).reduce((acc: Record<string, string>, criterion: any) => {
          if (criterion?._id && criterion?.criterion_name) {
            acc[criterion._id] = criterion.criterion_name;
          }
          return acc;
        }, {})
      );
      
      const timelineItems = Array.isArray(schedulesResponse) 
        ? schedulesResponse 
        : schedulesResponse?.items || [];
      setSchedules(timelineItems);
      setTimelineViewerMode(Array.isArray(schedulesResponse) ? null : schedulesResponse?.viewer_mode || null);
      setActiveSemester(
        (Array.isArray(semesters) ? semesters : []).find((semester) => semester?.status === 'active') || null
      );

      // Find the completion rule for this activity
      const rule = rulesList.find((r: any) => {
        const rActivityId = normalizeEntityId(r.activity_id);
        const rSemId = normalizeEntityId(r.semester_id);
        const actSemId = normalizeEntityId(actData.semester_id);
        
        return rActivityId === activityId && rSemId === actSemId;
      });
      setCompletionRule(rule || null);
    } catch (err: any) {
      toast.error('Lỗi khi tải thông tin hoạt động');
      console.error(err);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    if (activityId) {
      loadActivityData();
    }
  }, [activityId]);

  const handleResetMemberProgress = async (memberId: string) => {
    const semesterId = normalizeEntityId(activity?.semester_id);
    if (!semesterId) return;
    await activityApi.resetMemberProgress(activityId, memberId, semesterId);
    setMembers((current) => current.map((member) => member._id === memberId ? { ...member, participation_count: 3 } : member));
    toast.success('Đã reset số lượt tham gia');
  };

  // Join activity (student)
  const handleJoinActivity = async () => {
    if (!activity) return;
    setJoining(true);
    try {
      const actSemId = typeof activity.semester_id === 'object' 
        ? activity.semester_id?._id 
        : activity.semester_id;

      await activityApi.joinActivity(activityId, { semester_id: actSemId });
      toast.success(
        activity.settings?.require_approval 
          ? 'Gửi yêu cầu tham gia thành công. Vui lòng chờ phê duyệt!' 
          : 'Đăng ký tham gia hoạt động thành công!'
      );
      loadActivityData();
    } catch (err: any) {
      toast.error(err.message || 'Lỗi khi đăng ký tham gia');
    } finally {
      setJoining(false);
    }
  };

  // Member functions
  const handleApproveMember = async (memberId: string) => {
    await activityApi.approveMember(activityId, memberId, { status: 'active' });
    loadActivityData();
  };

  const handleRejectMember = async (memberId: string) => {
    await activityApi.approveMember(activityId, memberId, { status: 'rejected' });
    loadActivityData();
  };

  const handleUpdateMemberRole = async (memberId: string, newRole: string) => {
    await activityApi.updateMember(activityId, memberId, { role: newRole });
    loadActivityData();
  };

  const handleRemoveMember = async (memberId: string) => {
    await activityApi.removeMember(activityId, memberId);
    loadActivityData();
  };

  const handleLeaveActivity = async () => {
    if (!activity || leaving || leaveRemaining === 0) return;
    const semesterId = normalizeEntityId(activity.semester_id);
    if (!semesterId) return;
    setLeaving(true);
    try {
      const response = await activityApi.leaveActivity(activityId, { semester_id: semesterId });
      setLeaveRemaining(response.self_service_leaves_remaining ?? Math.max(0, (leaveRemaining ?? 1) - 1));
      toast.success('Left activity successfully');
      await loadActivityData();
    } catch (err: any) {
      toast.error(err?.message || 'Unable to leave activity');
    } finally { setLeaving(false); }
  };

  const handleLogoChange = async (event: React.ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    event.target.value = '';
    if (!file) return;
    if (!['image/png', 'image/jpeg', 'image/webp'].includes(file.type) || file.size > 5 * 1024 * 1024) {
      toast.error('Tệp ảnh phải là PNG, JPEG hoặc WebP và không vượt quá 5 MB.');
      return;
    }
    setUpdatingLogo(true);
    try {
      const uploaded = await activityApi.uploadMedia(file, 'logo');
      await activityApi.update(activityId, { logo_url: uploaded.url });
      toast.success('Cập nhật logo thành công');
      await loadActivityData();
    } catch (err: any) {
      toast.error(err.message || 'Không thể cập nhật logo');
    } finally {
      setUpdatingLogo(false);
    }
  };

  const handleRemoveLogo = async () => {
    if (!activity?.logo_url || updatingLogo || !window.confirm('Bạn có chắc muốn xóa logo hoạt động không?')) return;
    setUpdatingLogo(true);
    try {
      await activityApi.update(activityId, { logo_url: '' });
      toast.success('Xóa logo thành công');
      await loadActivityData();
    } catch (err: any) {
      toast.error(err.message || 'Không thể xóa logo');
    } finally {
      setUpdatingLogo(false);
    }
  };

  const handleRemoveMembers = async (memberIds: string[]) => {
    const result = await activityApi.removeMembers(activityId, memberIds);
    await loadActivityData();
    return result;
  };

  // Completion Rule functions
  const handleSaveCompletionRule = async (data: any) => {
    try {
      const semesterId = normalizeEntityId(activity?.semester_id);
      const { activity_id, ...rest } = data;
      const payload = {
        ...rest,
        activity_id: activityId,
        semester_id: semesterId,
      };

      if (completionRule) {
        await activityCompletionRuleApi.update(completionRule._id, payload);
        toast.success('Cập nhật quy tắc hoàn thành thành công');
      } else {
        await activityCompletionRuleApi.create(payload);
        toast.success('Thiết lập quy tắc hoàn thành thành công');
      }
      setShowRuleModal(false);
      loadActivityData();
    } catch (err: any) {
      toast.error(err.message || 'Lỗi khi lưu quy tắc hoàn thành');
    }
  };

  // Check registration status of current student
  const studentMembership = members.find(m => {
    const mStudentId = typeof m.student_id === 'object' ? m.student_id?._id : m.student_id;
    const mStudentUserId = typeof m.student_id === 'object' ? m.student_id?.user_id?._id || m.student_id?.user_id : '';
    const mUserId = typeof m.user_id === 'object' ? m.user_id?._id : m.user_id;
    
    return mStudentId === user?.studentId || mStudentUserId === user?.id || mUserId === user?.id;
  });

  const memberStatus = studentMembership?.status || 'none';
  const isPresident = memberStatus === 'active' && studentMembership?.role === 'president';
  const delegatedMethods = attendance.capabilities?.effective_methods || [];
  const canManageAttendance = getActivityViewPolicy({
    permissions: user?.permissions || [],
    isAdmin,
    isStudent,
    isOwner: isAssignedTeacher,
    isPresident,
    isDelegatedAttendance: delegatedMethods.length > 0,
  }).canManageAttendance;
  const canAdministerAttendanceGrants = attendance.capabilities?.can_administer_grants === true;
  const canCheckInAttendance = memberStatus === 'active' || (isStudent && activity?.settings?.require_registration_for_attendance === false);
  const canAccessAttendance = canManageAttendance || canCheckInAttendance;
  const isActiveStudentMember = isStudent && memberStatus === 'active';
  const allowedStudentTabs = isStudent
    ? ['info']
    : [
        'info',
        ...(canViewStaffTabs ? ['members'] : []),
        ...(canManageAttendance ? ['attendance'] : []),
        ...(isAdmin ? ['rule'] : []),
      ];
  const displayedTab = allowedStudentTabs.includes(activeTab) && (activeTab !== 'attendance' || canManageAttendance)
    ? activeTab
    : 'info';

  const hasCurrentMemberCheckedIn = attendance.checkinStatus === 'success' || attendance.checkins.some(
    (checkin) => normalizeEntityId(checkin.student_id) === normalizeEntityId(studentMembership?.student_id || user?.studentId),
  );

  const handleScheduleAttendance = (schedule: ActivitySchedule) => {
    if (!canCheckInAttendance) {
      if (canManageAttendance) handleTabChange('attendance');
      return;
    }
    if (hasCurrentMemberCheckedIn) {
      setShowMemberProximity(attendance.session?.method === 'proximity');
      setShowQrScanner(attendance.session?.method === 'qr');
      return;
    }
    if (!attendance.session || attendance.session.status !== 'active') {
      toast.info('Phiên điểm danh hiện chưa được mở.');
      return;
    }
    if (attendance.session.method === 'proximity') setShowMemberProximity(true);
    else if (attendance.session.method === 'qr') setShowQrScanner(true);
    else toast.info('Phương thức điểm danh chưa được hỗ trợ.');
  };

  if (loading) {
    return (
      <div className="h-full min-h-0 overflow-y-auto custom-scrollbar pb-12 p-6 space-y-6 animate-pulse">
        <div className="h-8 bg-slate-100 rounded-xl w-32" />
        <div className="h-40 bg-slate-100 rounded-2xl w-full" />
        <div className="h-10 bg-slate-100 rounded-xl w-80" />
        <div className="h-64 bg-slate-100 rounded-2xl w-full" />
      </div>
    );
  }

  if (!activity) {
    return (
      <div className="h-full min-h-0 overflow-y-auto custom-scrollbar pb-12 p-6 text-center">
        <p className="text-sm font-bold text-slate-500">Không tìm thấy thông tin hoạt động</p>
        <Button onClick={() => router.push('/activities')} className="mt-4 cursor-pointer">
          Quay lại danh sách
        </Button>
      </div>
    );
  }

  const actType = typeLabels[activity.activity_type] || activity.activity_type;

  return (
    <div className="h-full min-h-0 overflow-y-auto custom-scrollbar pb-12 p-6 space-y-6">

      {/* Back button */}
      <button
        onClick={() => router.push('/activities')}
        className="hidden md:flex items-center gap-1.5 text-xs font-bold text-slate-500 hover:text-blue-500 transition-colors cursor-pointer"
      >
        <ChevronLeft size={16} />
        Danh sách hoạt động
      </button>

      {/* Hero Banner / Cover */}
      <div className="relative overflow-hidden bg-white/60 backdrop-blur-md border border-white/70 rounded-2xl p-3.5 md:p-6 shadow-sm flex flex-col md:flex-row gap-3 md:gap-6 justify-between">
        {/* Cover background gradient */}
        <div className="absolute inset-0 bg-gradient-to-r from-blue-500/5 to-indigo-500/5 -z-10" />

        {/* Top Info Row (Logo + Title/Cố vấn + Status Badge on Mobile) */}
        <div className="flex flex-row items-center gap-3.5 md:gap-6 flex-1 min-w-0">
          {/* Logo */}
          <div className="relative w-12 h-12 md:w-20 md:h-20 rounded-2xl bg-gradient-to-tr from-blue-500 to-indigo-600 text-white flex items-center justify-center shrink-0 shadow-lg shadow-blue-500/20 font-black text-base md:text-2xl uppercase">
            {activity.logo_url && !logoLoadFailed ? (
              <img
                src={getImageUrl(activity.logo_url)}
                alt={activity.name}
                onError={() => setLogoLoadFailed(true)}
                className="w-full h-full object-contain object-center rounded-2xl p-1"
              />
            ) : (
              activity.code.slice(0, 2)
            )}
            {isAdminOrAdvisor && (
              <>
                <input ref={logoInputRef} type="file" accept="image/png,image/jpeg,image/webp" onChange={handleLogoChange} className="hidden" />
                <div className="absolute inset-0 flex items-center justify-center gap-2 rounded-2xl bg-black/45 opacity-0 hover:opacity-100 focus-within:opacity-100 transition-opacity">
                  <button
                    type="button"
                    aria-label="Cập nhật logo"
                    disabled={updatingLogo}
                    onClick={() => logoInputRef.current?.click()}
                    className="flex h-9 w-9 items-center justify-center rounded-lg text-white hover:bg-white/20 disabled:cursor-not-allowed"
                  >
                    {updatingLogo ? <span className="w-5 h-5 border-2 border-white border-t-transparent rounded-full animate-spin" /> : <Camera size={20} />}
                  </button>
                  {activity.logo_url && (
                    <button
                      type="button"
                      aria-label="Xóa logo"
                      disabled={updatingLogo}
                      onClick={handleRemoveLogo}
                      className="flex h-9 w-9 items-center justify-center rounded-lg text-white hover:bg-white/20 disabled:cursor-not-allowed"
                    >
                      <span aria-hidden="true">×</span>
                    </button>
                  )}
                </div>
              </>
            )}
          </div>

          {/* Info */}
          <div className="flex-1 space-y-0.5 md:space-y-2 min-w-0">
            <div className="hidden md:flex flex-wrap items-center gap-2">
              <span className="px-2.5 py-0.5 rounded-lg bg-blue-500/10 text-blue-600 border border-blue-200 text-[10px] font-black uppercase tracking-wider">
                {actType}
              </span>
              <span className="px-2.5 py-0.5 rounded-lg bg-slate-500/10 text-slate-600 border border-slate-200 text-[10px] font-bold">
                {categoryLabels[activity.category] || activity.category}
              </span>
              <span className="text-xs text-slate-400 font-semibold">
                Học kỳ: {activeSemester?.semester_name || '—'}
              </span>
            </div>

            <h1 className="text-base md:text-xl font-black text-slate-800 leading-tight">{activity.name}</h1>
            
            <div className="flex flex-wrap gap-x-4 gap-y-1 text-xs text-slate-500 font-semibold">
              <span className="flex items-center gap-1 text-slate-600">
                <User size={14} className="text-slate-400 shrink-0" />
                <span>Phụ trách: {activity.advisor_id?.full_name || activity.advisor_id?.user_name || 'Chưa phân công'}</span>
              </span>
              <span className="hidden md:flex items-center gap-1">
                <MapPin size={14} className="text-slate-400 shrink-0" />
                <span>Phòng: {activity.classroom}</span>
              </span>
            </div>
          </div>

          {/* Status badge on mobile */}
          {canUseMemberFlow && (!isStudent || isActiveStudentMember) && memberStatus === 'active' && (
            <div className="md:hidden shrink-0">
              <div
                title="Đã tham gia"
                className="p-2 bg-emerald-500/10 border border-emerald-200 text-emerald-600 font-bold rounded-xl flex items-center justify-center"
              >
                <CheckCircle2 size={18} className="shrink-0" />
              </div>
            </div>
          )}
        </div>

        {/* Member-flow status & action buttons */}
        {canUseMemberFlow && (!isStudent || isActiveStudentMember) && (
          <div className="shrink-0 flex items-center justify-end">
            {memberStatus === 'none' ? (
              <Button
                onClick={handleJoinActivity}
                disabled={joining}
                className="w-full md:w-auto px-5 py-2.5 bg-gradient-to-r from-blue-500 to-indigo-600 hover:from-blue-600 hover:to-indigo-750 text-white rounded-xl shadow-md shadow-blue-500/10 font-bold cursor-pointer"
              >
                Đăng ký tham gia
              </Button>
            ) : memberStatus === 'pending' ? (
              <div className="w-full md:w-auto px-4 py-2 bg-amber-500/10 border border-amber-200 text-amber-600 font-bold rounded-xl text-xs flex items-center justify-center gap-1.5">
                <Clock size={16} />
                Chờ duyệt tham gia
              </div>
            ) : memberStatus === 'active' ? (
              <div className="flex items-center gap-2 w-full md:w-auto">
                <div className="hidden md:flex px-4 py-2 bg-emerald-500/10 border border-emerald-200 text-emerald-600 font-bold rounded-xl text-xs items-center gap-1.5 whitespace-nowrap">
                  <CheckCircle2 size={16} className="shrink-0" />
                  Đã tham gia
                </div>
                {isStudent && activity.activity_type === 'club' && (
                  <Button
                    onClick={() => setShowLeaveConfirm(true)}
                    disabled={leaving || leaveRemaining === 0}
                    variant="outline"
                    className="w-full md:w-auto px-4 py-2 rounded-xl text-xs font-bold text-red-600 border-red-200 hover:bg-red-50 hover:text-red-700 flex items-center justify-center gap-1.5 whitespace-nowrap"
                  >
                    <LogOut size={16} className="shrink-0" />
                    <span>Rời hoạt động ({leaveRemaining ?? 3})</span>
                  </Button>
                )}
              </div>
            ) : (
              <div className="w-full md:w-auto px-4 py-2 bg-red-500/10 border border-red-200 text-red-600 font-bold rounded-xl text-xs text-center">
                Yêu cầu bị từ chối
              </div>
            )}
          </div>
        )}
      </div>

      {/* Tabs navigation */}
      <div className="flex flex-col sm:flex-row justify-between items-start sm:items-center gap-4 border-b border-slate-200">
        <div className="flex w-full items-stretch overflow-x-auto custom-scrollbar sm:w-auto sm:gap-6">
          <button
            onClick={() => handleTabChange('info')}
            aria-label="Thông tin chung"
            title="Thông tin chung"
            className={`flex flex-1 items-center justify-center gap-1.5 border-b-2 px-1 pb-3 text-[0px] font-bold transition-all cursor-pointer sm:flex-none sm:text-xs ${
              activeTab === 'info'
                ? 'border-blue-500 text-blue-600 font-extrabold'
                : 'border-transparent text-slate-400 hover:text-slate-600'
            }`}
          >
            <Compass size={14} />
            Thông tin chung
          </button>
          {canViewStaffTabs && <button
            onClick={() => handleTabChange('members')}
            aria-label="Thành viên"
            title="Thành viên"
            className={`flex flex-1 items-center justify-center gap-1.5 border-b-2 px-1 pb-3 text-[0px] font-bold transition-all cursor-pointer sm:flex-none sm:text-xs ${
              activeTab === 'members'
                ? 'border-blue-500 text-blue-600 font-extrabold'
                : 'border-transparent text-slate-400 hover:text-slate-600'
            }`}
          >
            <Users size={14} />
            Thành viên ({members.filter(m => m.status === 'active').length})
          </button>}
          {canManageAttendance && (
            <button
              onClick={() => handleTabChange('attendance')}
              aria-label="Điểm danh"
              title="Điểm danh"
              className={`flex flex-1 items-center justify-center gap-1.5 border-b-2 px-1 pb-3 text-[0px] font-bold transition-all cursor-pointer sm:flex-none sm:text-xs ${
                activeTab === 'attendance'
                  ? 'border-blue-500 text-blue-600 font-extrabold'
                  : 'border-transparent text-slate-400 hover:text-slate-600'
              }`}
            >
              <ClipboardCheck size={14} />
              Điểm danh
            </button>
          )}
          {isAdmin && <button
            onClick={() => handleTabChange('rule')}
            aria-label="Quy tắc hoàn thành"
            title="Quy tắc hoàn thành"
            className={`flex flex-1 items-center justify-center gap-1.5 border-b-2 px-1 pb-3 text-[0px] font-bold transition-all cursor-pointer sm:flex-none sm:text-xs ${
              activeTab === 'rule'
                ? 'border-blue-500 text-blue-600 font-extrabold'
                : 'border-transparent text-slate-400 hover:text-slate-600'
            }`}
          >
            <Award size={14} />
            Quy tắc hoàn thành
          </button>}
        </div>
        
        {isAdminOrAdvisor && (
          <Button
            variant="outline"
            onClick={() => setShowRuleModal(true)}
            className="mb-2 flex items-center gap-1.5 px-4 h-9 border border-white/80 bg-white/50 backdrop-blur-sm hover:bg-white/70 hover:scale-[1.01] rounded-xl cursor-pointer text-xs font-semibold text-slate-700 shadow-xs shrink-0 transition-all duration-150 ease-out focus:outline-none"
            aria-label="Cấu hình quy tắc hoàn thành"
          >
            <Settings size={14} />
            <span>Cấu hình quy tắc hoàn thành</span>
          </Button>
        )}
      </div>

      {/* Tab contents */}
      <div className="space-y-6">
        {/* Tab 1: Info */}
        {displayedTab === 'info' && (
          isActiveStudentMember ? (
            <div className="space-y-6">
              <div className="space-y-4">
                <div className="flex items-center justify-between">
                  <h2 className="text-sm font-bold text-slate-700">Lịch trình & dòng thời gian</h2>
                </div>
                <ActivityScheduleTimeline
                  schedules={schedules}
                  defaultClassroom={activity.classroom}
                  canViewAttendanceRoster={false}
                  canViewOwnAttendance={true}
                  isAdminOrAdvisor={false}
                  isStudent={true}
                  onOpenAttendance={handleScheduleAttendance}
                  activeSession={attendance.session}
                  ownCheckinCompleted={attendance.checkinStatus === 'success'}
                />
              </div>
              <div className="bg-white/50 backdrop-blur-md border border-white/60 p-5 rounded-2xl space-y-3">
                <h3 className="text-sm font-bold text-slate-800 uppercase tracking-wider border-b border-slate-100 pb-2">
                  Giới thiệu hoạt động
                </h3>
                <p className="text-xs text-slate-600 leading-relaxed font-semibold">
                  {activity.description || 'Chưa có thông tin mô tả chi tiết cho hoạt động này.'}
                </p>
              </div>
              {completionRule && (
                <div className="bg-gradient-to-r from-blue-500/10 to-indigo-500/10 border border-blue-200 p-5 rounded-2xl space-y-3">
                  <h3 className="text-xs font-extrabold text-blue-800 uppercase tracking-wider flex items-center gap-1.5">
                    <Award size={16} className="text-rose-500" />
                    Cơ chế tích lũy điểm rèn luyện
                  </h3>
                  <div className="text-xs font-semibold text-slate-700 space-y-1">
                    <p>• Yêu cầu tham gia tối thiểu: <span className="text-blue-600 font-black">{completionRule.minimum_attendance} buổi</span></p>
                    <p>• Tiêu chí cộng điểm:</p>
                    <div className="flex flex-wrap gap-1.5 pl-3 pt-1">
                      {completionRule.criterion_ids?.map((c: any) => (
                        <span key={c._id || c} className="px-2 py-0.5 bg-white border border-blue-200 text-blue-600 text-[10px] font-bold rounded-lg">
                          {c.criterion_name || 'Tiêu chí học bạ'}
                        </span>
                      ))}
                    </div>
                  </div>
                </div>
              )}
            </div>
          ) : (
            <div className="space-y-6">
              {isAssignedTeacher && <div className="space-y-4">
                <div className="flex items-center justify-between"><h2 className="text-sm font-bold text-slate-700">Lịch trình & dòng thời gian</h2></div>
                <ActivityScheduleTimeline schedules={schedules} defaultClassroom={activity.classroom} canViewAttendanceRoster={canViewStaffTabs || timelineViewerMode === 'staff'} canViewOwnAttendance={isStudent && memberStatus === 'active'} isAdminOrAdvisor={isAdminOrAdvisor} isStudent={isStudent && memberStatus === 'active'} onOpenAttendance={handleScheduleAttendance} activeSession={attendance.session} ownCheckinCompleted={attendance.checkinStatus === 'success'} />
              </div>}
              <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
                <div className="lg:col-span-2 space-y-6">
                  <div className="bg-white/50 backdrop-blur-md border border-white/60 p-5 rounded-2xl space-y-3">
                    <h3 className="text-sm font-bold text-slate-800 uppercase tracking-wider border-b border-slate-100 pb-2">Giới thiệu hoạt động</h3>
                    <p className="text-xs text-slate-600 leading-relaxed font-semibold">{activity.description || 'Chưa có thông tin mô tả chi tiết cho hoạt động này.'}</p>
                  </div>
                  {canUseMemberFlow && completionRule && (
                    <div className="bg-gradient-to-r from-blue-500/10 to-indigo-500/10 border border-blue-200 p-5 rounded-2xl space-y-3">
                      <h3 className="text-xs font-extrabold text-blue-800 uppercase tracking-wider flex items-center gap-1.5"><Award size={16} className="text-rose-500" />Cơ chế tích lũy điểm rèn luyện</h3>
                      <div className="text-xs font-semibold text-slate-700 space-y-1">
                        <p>• Yêu cầu tham gia tối thiểu: <span className="text-blue-600 font-black">{completionRule.minimum_attendance} buổi</span></p>
                        <p>• Tiêu chí cộng điểm:</p>
                        <div className="flex flex-wrap gap-1.5 pl-3 pt-1">{completionRule.criterion_ids?.map((c: any) => <span key={c._id || c} className="px-2 py-0.5 bg-white border border-blue-200 text-blue-600 text-[10px] font-bold rounded-lg">{c.criterion_name || 'Tiêu chí học bạ'}</span>)}</div>
                      </div>
                    </div>
                  )}
                </div>
                <div className="space-y-6">
                  <div className="bg-white/50 backdrop-blur-md border border-white/60 p-5 rounded-2xl space-y-4">
                    <h3 className="text-xs font-bold text-slate-500 uppercase tracking-wider border-b border-slate-100 pb-2">Chi tiết hoạt động</h3>
                    <div className="space-y-3 text-xs font-semibold text-slate-600">
                      <div className="flex justify-between"><span className="text-slate-400">Người quản lý:</span><span className="text-slate-700 font-bold">{activity.president_id?.full_name || '—'}</span></div>
                      <div className="flex justify-between"><span className="text-slate-400">Giới hạn thành viên:</span><span className="text-slate-700 font-bold">{activity.max_members ? `${activity.max_members} người` : 'Không giới hạn'}</span></div>
                      <div className="flex justify-between"><span className="text-slate-400">Ngày bắt đầu:</span><span className="text-slate-700 font-bold">{activity.activity_start_date ? new Date(activity.activity_start_date).toLocaleDateString('vi-VN') : '—'}</span></div>
                      <div className="flex justify-between"><span className="text-slate-400">Ngày kết thúc:</span><span className="text-slate-700 font-bold">{activity.activity_end_date ? new Date(activity.activity_end_date).toLocaleDateString('vi-VN') : '—'}</span></div>
                      <div className="flex justify-between"><span className="text-slate-400">Tự đăng ký:</span><span className={`font-bold ${activity.settings?.allow_self_registration ? 'text-emerald-600' : 'text-slate-400'}`}>{activity.settings?.allow_self_registration ? 'Cho phép' : 'Khóa'}</span></div>
                    </div>
                  </div>
                </div>
              </div>
              {!isAssignedTeacher && <div className="space-y-4">
                <div className="flex items-center justify-between"><h2 className="text-sm font-bold text-slate-700">Lịch trình & dòng thời gian</h2></div>
                <ActivityScheduleTimeline schedules={schedules} defaultClassroom={activity.classroom} canViewAttendanceRoster={canViewStaffTabs || timelineViewerMode === 'staff'} canViewOwnAttendance={canCheckInAttendance} isAdminOrAdvisor={isAdminOrAdvisor} isStudent={canCheckInAttendance} onOpenAttendance={handleScheduleAttendance} activeSession={attendance.session} ownCheckinCompleted={attendance.checkinStatus === 'success'} />
              </div>}
            </div>
          )
        )}

        {/* Tab 2: Members */}
        {displayedTab === 'members' && (
          <div className="space-y-4">
            <div className="flex items-center justify-between">
              <h2 className="text-sm font-bold text-slate-700">Danh sách thành viên</h2>
            </div>
            <ActivityMemberTable
              members={members}
              onApprove={handleApproveMember}
              onReject={handleRejectMember}
              onUpdateRole={handleUpdateMemberRole}
              onRemove={handleRemoveMember}
              onRemoveMany={handleRemoveMembers}
              isAdminOrAdvisor={isAdminOrAdvisor}
              onResetProgress={isAdmin ? handleResetMemberProgress : undefined}
            />
          </div>
        )}

        {/* Tab 4: Completion Rules */}
        {displayedTab === 'rule' && (
          <div className="space-y-4">
            <div className="flex items-center justify-between">
              <h2 className="text-sm font-bold text-slate-700">Thông tin quy tắc hoàn thành</h2>
            </div>
            {completionRule ? (
              <div className="bg-white/50 backdrop-blur-md border border-white/60 p-5 rounded-2xl shadow-sm space-y-4 max-w-2xl">
                <div className="flex justify-between items-start">
                  <div>
                    <h3 className="text-xs font-extrabold text-blue-800 uppercase tracking-wider flex items-center gap-1.5">
                      <Award size={16} className="text-rose-500" />
                      Cơ chế tích lũy điểm rèn luyện
                    </h3>
                  </div>
                  <span className={`px-2.5 py-0.5 rounded-lg text-[10px] font-black uppercase tracking-wider border ${completionRule.status === 'active' ? 'bg-emerald-50 text-emerald-600 border-emerald-200' : 'bg-slate-100 text-slate-500 border-slate-200'}`}>
                    {completionRule.status === 'active' ? 'Đang áp dụng' : 'Tạm ngưng'}
                  </span>
                </div>
                <div className="text-sm font-semibold text-slate-700 space-y-3">
                  <p className="flex items-center gap-2">
                    <CheckCircle2 size={16} className="text-blue-500" />
                    <span>Yêu cầu tham gia tối thiểu: <span className="text-blue-600 font-black">{completionRule.minimum_attendance} buổi</span></span>
                  </p>
                  <div>
                    <p className="flex items-center gap-2 mb-2">
                      <Star size={16} className="text-amber-500" />
                      <span>Tiêu chí cộng điểm:</span>
                    </p>
                    <div className="flex flex-wrap gap-2 pl-6">
                      {completionRule.criterion_ids?.map((c: any) => (
                        <span key={normalizeEntityId(c)} className="px-3 py-1.5 bg-white border border-blue-200 text-blue-700 text-xs font-bold rounded-xl shadow-sm">
                          {getCriterionLabel(c, criteriaById)}
                        </span>
                      ))}
                    </div>
                  </div>
                </div>
              </div>
            ) : (
              <div className="bg-white/50 backdrop-blur-md border border-white/60 p-8 rounded-2xl shadow-sm text-center max-w-2xl">
                <Award size={48} className="text-slate-300 mx-auto mb-3" />
                <p className="text-sm font-bold text-slate-500">Chưa có quy tắc hoàn thành nào được thiết lập</p>
                <p className="text-xs text-slate-400 mt-1">Hoạt động này hiện chưa có cơ chế tính điểm rèn luyện tự động.</p>
              </div>
            )}
          </div>
        )}

        {/* Tab 5: Attendance */}
        {displayedTab === 'attendance' && canManageAttendance && (
          <div className="space-y-4">
            <ActivityAttendanceTab
              activityId={activityId}
              activity={activity}
              schedules={schedules}
              showMethodSelector={showMethodSelector}
              setShowMethodSelector={setShowMethodSelector}
              showQrScanner={showQrScanner}
              setShowQrScanner={setShowQrScanner}
              canManageAttendance={canManageAttendance}
              canCheckInAttendance={canCheckInAttendance}
              currentStudentId={normalizeEntityId(studentMembership?.student_id) || user?.studentId || ''}
              attendance={attendance}
              canAdministerGrants={canAdministerAttendanceGrants}
              allowedMethods={isAdmin || isAssignedTeacher ? ['qr', 'proximity', 'manual_class'] : isPresident ? ['qr', 'proximity'] : delegatedMethods}
              isManualClassChooser={isAdminOrAdvisor}
              isAdmin={isAdmin}
              onAttendanceCompleted={loadActivityData}
            />
          </div>
        )}
      </div>

      <Dialog open={showRuleModal} onOpenChange={setShowRuleModal}>
        <DialogContent className="max-w-3xl bg-slate-50/95 backdrop-blur-xl border border-white shadow-2xl p-0 overflow-hidden rounded-[24px]">
          <DialogHeader className="px-6 pt-6 pb-2">
            <DialogTitle className="text-lg font-black text-slate-800">
              Cấu hình quy tắc hoàn thành
            </DialogTitle>
          </DialogHeader>
          <div className="px-6 pb-6 max-h-[80vh] overflow-y-auto custom-scrollbar">
            <ActivityCompletionRuleForm
              initialData={completionRule}
              activityId={activityId}
              semesterId={typeof activity.semester_id === 'object' ? activity.semester_id?._id : activity.semester_id}
              onSubmit={handleSaveCompletionRule}
              onCancel={() => setShowRuleModal(false)}
            />
          </div>
        </DialogContent>
      </Dialog>

      <ProximityCheckinModal
        open={showMemberProximity}
        onClose={() => {
          setShowMemberProximity(false);
          attendance.resetCheckinStatus();
        }}
        alreadyCheckedIn={hasCurrentMemberCheckedIn}
        onCheckin={async (latitude, longitude) => {
          await attendance.checkinProximity(latitude, longitude);
          toast.success('Điểm danh thành công!');
          await loadActivityData();
        }}
      />

      {canCheckInAttendance && !hasCurrentMemberCheckedIn && <QrScannerModal
        open={showQrScanner}
        onClose={() => {
          setShowQrScanner(false);
          attendance.resetCheckinStatus();
        }}
        onScanned={async (token) => {
          await attendance.checkinQr(token);
          toast.success('Điểm danh thành công!');
          await loadActivityData();
        }}
        checkinStatus={attendance.checkinStatus}
        checkinError={attendance.checkinError}
        onReset={attendance.resetCheckinStatus}
      />}

      <ConfirmModal
        isOpen={showLeaveConfirm}
        onClose={() => setShowLeaveConfirm(false)}
        onConfirm={handleLeaveActivity}
        title="Xác nhận rời hoạt động"
        message={`Bạn còn ${leaveRemaining ?? 3} lần rời hoạt động trong học kỳ này. Sau khi rời, bạn có thể tham gia lại nếu hoạt động cho phép.`}
        confirmLabel="Rời hoạt động"
        cancelLabel="Hủy"
        variant="danger"
      />
    </div>
  );
}

// ── Activity Attendance Tab Component ──
function ActivityAttendanceTab({
  activityId,
  activity,
  schedules,
  showMethodSelector,
  setShowMethodSelector,
  showQrScanner,
  setShowQrScanner,
  canManageAttendance,
  canCheckInAttendance,
  currentStudentId,
  attendance,
  canAdministerGrants,
  allowedMethods,
  isManualClassChooser,
  isAdmin,
  onAttendanceCompleted,
}: {
  activityId: string;
  activity: any;
  schedules: any[];
  showMethodSelector: boolean;
  setShowMethodSelector: (v: boolean) => void;
  showQrScanner: boolean;
  setShowQrScanner: (v: boolean) => void;
  canManageAttendance: boolean;
  canCheckInAttendance: boolean;
  currentStudentId: string;
  attendance: ReturnType<typeof useAttendanceSession>;
  canAdministerGrants: boolean;
  allowedMethods: Array<'qr' | 'proximity' | 'manual_class'>;
  isManualClassChooser: boolean;
  isAdmin: boolean;
  onAttendanceCompleted: () => Promise<void>;
}) {
  const hasActiveSession = attendance.session?.status === 'active';
  const hasAnyActiveManualSession = Object.values(attendance.manualLanes || {}).some(
    (lane) => lane?.session?.status === 'active',
  );
  const isAnySessionActive = hasActiveSession || hasAnyActiveManualSession;
  const isQrSession = hasActiveSession && attendance.session?.method === 'qr';
  const isProximitySession = hasActiveSession && attendance.session?.method === 'proximity';
  const selfServiceMethods = allowedMethods.filter((method): method is 'qr' | 'proximity' => method !== 'manual_class');
  const hasCurrentMemberCheckedIn = attendance.checkinStatus === 'success' || attendance.checkins.some(
    (checkin) => normalizeEntityId(checkin.student_id) === currentStudentId,
  );
  const todaySchedule = getTodaySchedule(schedules);
  const [attendanceWindowNow, setAttendanceWindowNow] = useState(() => new Date());
  const attendanceWindowOpen = isScheduleOpenWindow(todaySchedule, attendanceWindowNow);
  const [classPickerOpen, setClassPickerOpen] = useState(false);
  const [selectedClassId, setSelectedClassId] = useState('');
  const [adminClasses, setAdminClasses] = useState<Array<{ _id: string; class_name: string }>>([]);
  const manualClasses = isAdmin ? adminClasses : (attendance.capabilities?.classes || []);

  useEffect(() => {
    const timer = window.setInterval(() => setAttendanceWindowNow(new Date()), 30_000);
    return () => window.clearInterval(timer);
  }, []);

  useEffect(() => {
    if (!classPickerOpen || !isAdmin) return;
    void classApi.getClasses().then((classes) => setAdminClasses(classes)).catch(() => toast.error('Không thể tải danh sách lớp'));
  }, [classPickerOpen, isAdmin]);

  const handleOpenSession = async (params: {
    method: 'qr' | 'proximity' | 'manual_class';
    class_id?: string;
    latitude?: number;
    longitude?: number;
    radius_meters?: number;
    qr_refresh_interval?: number;
  }) => {
    try {
      if (!todaySchedule?._id) throw new Error('No non-cancelled schedule is available today.');
      if (!attendanceWindowOpen) throw new Error('Attendance can only be opened during the activity schedule window.');
      if (params.method === 'manual_class') {
        if (isManualClassChooser && !params.class_id) {
          setShowMethodSelector(false);
          setClassPickerOpen(true);
          return;
        }
        if (!isManualClassChooser) {
          const classes = attendance.capabilities?.classes || [];
          if (classes.length !== 1) throw new Error(classes.length === 0 ? 'Không tìm thấy lớp được phép.' : 'Không thể tự chọn giữa nhiều lớp.');
          params.class_id = classes[0]._id;
        }
        if (params.class_id) {
          setClassPickerOpen(false);
          setSelectedClassId('');
          await attendance.openSession({
            ...params,
            schedule_id: todaySchedule._id,
            semester_id: activity.semester_id?._id || activity.semester_id || '',
            title: `Điểm danh hoạt động ${activity.name}`,
          });
          toast.success('Đã mở phiên điểm danh theo lớp!');
        } else {
          setShowMethodSelector(false);
          toast.info('Vui lòng chọn lớp học bên dưới để mở phiên điểm danh');
        }
        return;
      }
      await attendance.openSession({
        ...params,
        schedule_id: todaySchedule._id,
        semester_id: activity.semester_id?._id || activity.semester_id || '',
        title: `Điểm danh hoạt động ${activity.name}`,
      });
      setShowMethodSelector(false);
      toast.success('Đã mở phiên điểm danh thành công!');
    } catch (err: any) {
      toast.error(err.message || 'Không thể mở phiên điểm danh');
    }
  };

  const handleCloseSession = async () => {
    try {
      await attendance.closeSession();
      toast.success('Đã đóng phiên điểm danh');
    } catch {
      toast.error('Không thể đóng phiên');
    }
  };

  return (
    <div className={`grid gap-6 ${canAdministerGrants ? 'lg:grid-cols-[minmax(0,1fr)_22rem]' : ''}`}>
      <div className="min-w-0 space-y-6">
      {/* Session Status Bar */}
      {hasActiveSession && attendance.session && (
        <AttendanceSessionStatus
          status={attendance.session.status as any}
          method={attendance.session.method as any}
          checkinCount={attendance.session.checkin_count}
          openedAt={attendance.session.opened_at}
        />
      )}

      {/* No active session */}
      {!isAnySessionActive && !showMethodSelector && !classPickerOpen && canManageAttendance && allowedMethods.length > 0 && (
        <div className="backdrop-blur-md bg-white/45 border border-white/70 rounded-3xl p-8 shadow-sm text-center">
          <div className="w-16 h-16 rounded-2xl bg-blue-500/10 flex items-center justify-center text-blue-600 mb-4 mx-auto border border-blue-500/20 shadow-sm">
            <ClipboardCheck size={32} />
          </div>
          <h3 className="text-base font-extrabold text-slate-800">Điểm danh hoạt động</h3>
          <p className="text-xs text-slate-500 mt-2 mb-6 max-w-md leading-relaxed font-semibold mx-auto">
            Hỗ trợ 3 phương thức điểm danh: <strong>QR Code</strong>, <strong>Phạm vi GPS</strong> và <strong>Theo lớp phụ trách</strong>.
          </p>
          <div className="flex flex-col sm:flex-row gap-3 w-full max-w-xs mx-auto justify-center">
            {allowedMethods.length > 0 && <Button
              type="button"
              variant="default"
              size="default"
              onClick={() => setShowMethodSelector(true)}
              disabled={!attendanceWindowOpen}
              className="w-full text-xs"
            >
              <Radio size={16} /> Mở điểm danh
            </Button>}
          </div>
          {!attendanceWindowOpen && (
            <p className="mt-3 text-xs font-semibold text-amber-700">
              {!todaySchedule
                ? 'Hoạt động chưa có lịch sinh hoạt trong ngày hôm nay. Vui lòng tạo lịch sinh hoạt ở tab "Lịch hoạt động" trước khi mở điểm danh.'
                : 'Chỉ có thể mở điểm danh trong khung giờ của buổi sinh hoạt hôm nay.'}
            </p>
          )}
        </div>
      )}

      {!isAnySessionActive && !showMethodSelector && !canManageAttendance && canCheckInAttendance && (
        <div className="backdrop-blur-md bg-white/45 border border-white/70 rounded-3xl p-8 shadow-sm text-center">
          <div className="w-16 h-16 rounded-2xl bg-slate-100 flex items-center justify-center text-slate-400 mb-4 mx-auto border border-slate-200 shadow-sm">
            <ClipboardCheck size={32} />
          </div>
          <h3 className="text-base font-extrabold text-slate-800">Đang chờ mở điểm danh</h3>
          <p className="text-xs text-slate-500 mt-2 font-semibold">Trạng thái sẽ cập nhật tự động khi Chủ nhiệm hoặc quản trị viên mở phiên.</p>
        </div>
      )}

      {/* Method Selector Modal */}
      {!isAnySessionActive && showMethodSelector && canManageAttendance && (
        <div className="backdrop-blur-md bg-white/45 border border-white/70 rounded-3xl p-6 shadow-sm">
          <AttendanceMethodSelector
            onSelect={handleOpenSession}
            loading={attendance.loading}
            allowedMethods={allowedMethods}
          />
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={() => setShowMethodSelector(false)}
            className="mt-4 w-auto"
          >
            <ChevronLeft size={16} /> Quay lại
          </Button>
        </div>
      )}

      {classPickerOpen && allowedMethods.includes('manual_class') && (
        <section className="backdrop-blur-md bg-white/45 border border-white/70 rounded-3xl p-5 shadow-sm space-y-4">
          <h3 className="text-sm font-extrabold text-slate-800">Chọn lớp điểm danh</h3>
          <Select value={selectedClassId} onValueChange={(value) => setSelectedClassId(value)}>
            <SelectTrigger className="w-full bg-white border border-slate-200 rounded-xl text-sm" aria-label="Lớp điểm danh">
              <SelectValue placeholder="Chọn lớp" />
            </SelectTrigger>
            <SelectContent>
              {manualClasses.map((item) => (
                <SelectItem key={item._id} value={item._id}>
                  {item.class_name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <div className="flex gap-3">
            <Button type="button" onClick={() => void handleOpenSession({ method: 'manual_class', class_id: selectedClassId })} disabled={!selectedClassId || !todaySchedule} className="bg-emerald-600 text-xs hover:bg-emerald-700">Mở phiên</Button>
            <Button type="button" variant="secondary" onClick={() => { setClassPickerOpen(false); setSelectedClassId(''); }} className="text-xs">Hủy</Button>
          </div>
        </section>
      )}

      {/* Owner-scoped manual lanes remain independent from QR/proximity and from each other. */}
      {allowedMethods.includes('manual_class') && attendance.capabilities?.classes.map((ownedClass) => {
        const lane = attendance.manualLanes?.[ownedClass._id];
        const activeManualSession = lane?.session?.status === 'active';
        if (!activeManualSession) return null;
        return (
          <section key={ownedClass._id} className="backdrop-blur-md bg-white/45 border border-white/70 rounded-3xl p-5 shadow-sm space-y-4">
            <div className="flex flex-wrap items-center justify-between gap-3">
              <div>
                <h3 className="text-sm font-extrabold text-slate-800">Lớp {ownedClass.class_name}</h3>
                <p className="text-[11px] font-semibold text-slate-500">
                  {activeManualSession ? 'Phiên của bạn đang hoạt động' : 'Chưa có phiên của bạn trong hôm nay'}
                </p>
              </div>
              {activeManualSession ? (
                <button
                  onClick={() => void attendance.closeManualSession(ownedClass._id)}
                  disabled={lane.loading}
                  className="rounded-xl bg-rose-600 px-4 py-2.5 text-xs font-bold text-white disabled:opacity-50"
                >
                  Đóng phiên lớp
                </button>
              ) : !lane || lane.loading ? (
                <span className="rounded-xl bg-slate-100 px-4 py-2.5 text-xs font-bold text-slate-500">
                  Đang tải...
                </span>
              ) : (
                <button
                  onClick={() => void handleOpenSession({ method: 'manual_class', class_id: ownedClass._id })}
                  disabled={!todaySchedule}
                  className="rounded-xl bg-emerald-600 px-4 py-2.5 text-xs font-bold text-white disabled:opacity-50"
                >
                  Điểm danh lớp {ownedClass.class_name}
                </button>
              )}
            </div>
            {lane?.error && <p className="text-xs font-semibold text-rose-600">{lane.error}</p>}
            {activeManualSession && lane.roster && (
              <ManualAttendanceGrid
                roster={lane.roster}
                pending={lane.pending}
                errors={lane.errors}
                onCheckin={(studentId) => attendance.manualCheckin(ownedClass._id, studentId)}
              />
            )}
          </section>
        );
      })}

      {/* Active QR Session */}
      {isQrSession && attendance.qrData && canManageAttendance && allowedMethods.includes('qr') && (
        <div className="backdrop-blur-md bg-white/45 border border-white/70 rounded-3xl shadow-sm overflow-hidden">
          <QrDisplayPanel
            token={attendance.qrData.token}
            expiresAt={attendance.qrData.expires_at}
            refreshInterval={attendance.qrData.refresh_interval}
            checkinCount={attendance.qrData.checkin_count}
            onClose={handleCloseSession}
            sessionTitle={attendance.session?.title}
          />
        </div>
      )}

      {/* Active Proximity Session */}
      {isProximitySession && attendance.session && canManageAttendance && allowedMethods.includes('proximity') && (
        <div className="backdrop-blur-md bg-white/45 border border-white/70 rounded-3xl shadow-sm overflow-hidden">
          <ProximityPanel
            latitude={attendance.session.latitude!}
            longitude={attendance.session.longitude!}
            radiusMeters={attendance.session.radius_meters!}
            checkinCount={attendance.session.checkin_count}
            checkins={attendance.checkins}
            onClose={handleCloseSession}
            sessionTitle={attendance.session.title}
          />
        </div>
      )}

      {/* Student Proximity check-in */}
      {false && isProximitySession && attendance.session && canCheckInAttendance && (
        <div className="backdrop-blur-md bg-white/45 border border-white/70 rounded-3xl shadow-sm overflow-hidden">
          <ProximityCheckinButton
            sessionLatitude={attendance.session.latitude!}
            sessionLongitude={attendance.session.longitude!}
            sessionRadius={attendance.session.radius_meters!}
            onCheckin={async (lat, lng) => {
              await attendance.checkinProximity(lat, lng);
              toast.success('Điểm danh thành công!');
              await onAttendanceCompleted();
            }}
            checkinStatus={hasCurrentMemberCheckedIn ? 'success' : attendance.checkinStatus}
            checkinError={attendance.checkinError}
          />
        </div>
      )}

      {/* Student QR Scanner */}
      {false && isQrSession && canCheckInAttendance && (
        <div className="flex justify-center">
          <button
            onClick={() => !hasCurrentMemberCheckedIn && setShowQrScanner(true)}
            disabled={hasCurrentMemberCheckedIn}
            className="flex items-center gap-2 px-6 py-3 bg-emerald-600 text-white text-sm font-bold rounded-xl hover:bg-emerald-700 shadow-md shadow-emerald-500/20 active:scale-95 transition-all cursor-pointer disabled:bg-emerald-100 disabled:text-emerald-700 disabled:shadow-none disabled:cursor-not-allowed"
          >
            {hasCurrentMemberCheckedIn ? <CheckCircle2 size={18} /> : <QrCode size={18} />}
            {hasCurrentMemberCheckedIn ? 'Đã điểm danh' : 'Quét mã để điểm danh'}
          </button>
        </div>
      )}

      {/* Checkins List */}
      {hasActiveSession && attendance.checkins.length > 0 && canManageAttendance && (
        <div className="backdrop-blur-md bg-white/45 border border-white/70 rounded-3xl p-5 shadow-sm">
          <h3 className="text-xs font-bold text-slate-800 pb-3 border-b border-white/50 mb-3">
            Đã điểm danh ({attendance.checkins.length})
          </h3>
          <div className="space-y-2 max-h-64 overflow-y-auto">
            {attendance.checkins.map((c) => (
              <div
                key={c._id}
                className="flex items-center justify-between px-3 py-2.5 bg-white/60 rounded-xl border border-white/80"
              >
                <div className="flex items-center gap-3">
                  <div className="w-8 h-8 rounded-full bg-blue-500/10 flex items-center justify-center text-xs font-bold text-blue-600 border border-blue-500/20">
                    {(c.student_id?.full_name || '?')[0]}
                  </div>
                  <div>
                    <p className="text-xs font-bold text-slate-800">{c.student_id?.full_name || '—'}</p>
                    <p className="text-[10px] text-slate-400 font-mono">{c.student_id?.student_code || ''}</p>
                  </div>
                </div>
                <div className="text-right text-xs">
                  <span className="text-[10px] text-emerald-600 font-bold bg-emerald-50 px-2 py-0.5 rounded-full">
                    {c.method === 'qr' ? 'QR' : 'GPS'}
                  </span>
                  {c.distance_meters != null && (
                    <p className="text-[10px] text-slate-400 mt-0.5">{c.distance_meters}m</p>
                  )}
                </div>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Scanner Modal */}
      {false && canCheckInAttendance && !hasCurrentMemberCheckedIn && <QrScannerModal
        open={showQrScanner}
        onClose={() => {
          setShowQrScanner(false);
          attendance.resetCheckinStatus();
        }}
        onScanned={async (token) => {
          await attendance.checkinQr(token);
          toast.success('Điểm danh thành công!');
          await onAttendanceCompleted();
        }}
        checkinStatus={attendance.checkinStatus}
        checkinError={attendance.checkinError}
        onReset={attendance.resetCheckinStatus}
      />}

      {/* Error */}
      {attendance.error && (
        <div className="bg-red-50 border border-red-200 rounded-xl px-4 py-3 text-xs text-red-600 font-medium">
          {attendance.error}
        </div>
      )}
      </div>
      {canAdministerGrants && (
        <aside className="min-w-0 lg:sticky lg:top-4 lg:self-start">
          <AttendanceGrantManager activityId={activityId} />
        </aside>
      )}
    </div>
  );
}

