'use client';

import React, { useCallback, useEffect, useRef, useState } from 'react';
import { Calendar, DoorOpen, Link2, Loader2, Pencil, Plus, QrCode, RefreshCw, Search as SearchIcon, Trash2, Upload, X } from 'lucide-react';
import QRCodeLib from 'qrcode';
import { ApplicantProfile, Bed, CreateDormitoryRosterEntryInput, dormitoryApi, DormitoryRosterEntry, DormitoryRosterRoomOption, Room } from '@/api/dormitory-api';
import { studentApi, Student } from '@/api/student-api';
import { semesterApi } from '@/api/semester-api';
import { useAuth } from '@/providers/auth-provider';
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle, DialogTrigger } from '@/components/ui/dialog';
import { toast } from 'sonner';
import ResponsiveDataView, { ResponsiveColumn } from '@/components/ui/ResponsiveDataView';
import FloatingActionBar from '@/components/ui/FloatingActionBar';
import { CustomPagination } from '@/components/ui/pagination';
import { Research } from '@/components/ui/Research';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/Input';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { CustomCalendar } from '@/components/calendar/CustomCalendar';
import ConfirmModal from '@/components/modals/ConfirmModal';
import { ApplicantProfileFields, compactApplicantProfile, emptyApplicantProfile } from '@/components/dormitory/PublicDormitoryRegistrationModal';
import DormitoryRegistrationEditModal, { dateInputValue, mapActiveSemester } from '@/components/dormitory/DormitoryRegistrationEditModal';
import DormitoryRosterImportModal from '@/components/dormitory/DormitoryRosterImportModal';
import type { ActiveSemesterValues } from '@/components/dormitory/DormitoryRegistrationEditModal';
import DormitoryChoicePopover from '@/components/dormitory/DormitoryChoicePopover';
import { runRosterBatches } from '@/components/dormitory/roster-batch';
import RosterOperationProgressDialog, { RosterOperationProgress } from '@/components/dormitory/RosterOperationProgressDialog';
import RosterStudentLinkModal from '@/components/dormitory/RosterStudentLinkModal';
export { buildEditRegistrationPayload, mapActiveSemester } from '@/components/dormitory/DormitoryRegistrationEditModal';

const pageSizeOptions = [20, 40, 50, 100];
export const REGISTRATION_TABLE_CLASS_NAME = 'text-xs';
export const PUBLIC_REGISTRATION_PATH = '/public/dormitory/register';
export const shouldShowRosterImport = (canCreate: boolean) => canCreate;
export const getPublicRegistrationUrl = (origin: string) => `${origin.replace(/\/$/, '')}${PUBLIC_REGISTRATION_PATH}`;
export const roomStatusLabel = (status: Room['status']) => ({ 'Trống': 'Trống', 'Đầy': 'Đầy', 'Khóa': 'Khóa', 'Bảo trì': 'Bảo trì' }[status] || status);
export const roomQuantityLabel = (room: Pick<Room, 'available_bed_count'> & Partial<Pick<Room, 'max_students'>>) => room.max_students === undefined
  ? `Còn ${room.available_bed_count} giường trống`
  : `Còn ${room.available_bed_count}/${room.max_students} giường trống`;
export const isAvailableBed = (bed: Bed) => bed.status === 'Trống';
export const studentName = (r: DormitoryRosterEntry) => r.student_id?.full_name || r.full_name || '—';
export const studentCode = (r: DormitoryRosterEntry) => {
  const value = r.student_id?.student_code || r.student_code;
  return typeof value === 'string' && value.trim() ? value.trim() : 'Chưa có mã SV';
};
export const roomLabel = (r: DormitoryRosterEntry) => r.assigned_room_name || (typeof r.room_id === 'object' ? r.room_id.room_name || r.room_id.room_code : '') || 'Chưa xếp phòng';
export const isUnassignedRoom = (r: DormitoryRosterEntry) => !r.room_id && !r.bed_id;
export const hasAssignedBed = (r: DormitoryRosterEntry) => Boolean(r.bed_id);
export type RoomAssignment = { room: Room | null; bed?: Bed; roster_entry?: DormitoryRosterEntry; active_contract_id?: string };
export const applyRoomAssignment = (row: DormitoryRosterEntry, assignment: RoomAssignment): DormitoryRosterEntry => ({
  ...row,
  ...(assignment.roster_entry || {}),
  room_id: assignment.room || undefined,
  bed_id: assignment.room ? assignment.bed || undefined : undefined,
  assigned_room_name: assignment.room ? assignment.room.room_name || assignment.room.room_code : undefined,
  active_contract_id: assignment.active_contract_id || assignment.roster_entry?.active_contract_id || row.active_contract_id,
});
export const applyRoomUnassignment = (row: DormitoryRosterEntry, response: Awaited<ReturnType<typeof dormitoryApi.roster.unassignRoom>>): DormitoryRosterEntry => ({
  ...row,
  ...(response.roster_entry || {}),
  room_id: undefined,
  bed_id: undefined,
  assigned_room_name: undefined,
  active_contract_id: undefined,
  active_contract: null,
});
export const createdDateLabel = (value?: string) => {
  if (!value) return '—';
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? '—' : date.toLocaleDateString('vi-VN');
};

type CreateForm = ActiveSemesterValues & {
  student_code?: string;
  date_of_birth: string;
  gender: '' | 'Male' | 'Female' | 'Other';
  phone_number: string;
  room_type: 'Thường' | 'Máy lạnh';
  notes: string;
  applicant_profile: ApplicantProfile;
};

const emptyCreateForm = (): CreateForm => ({ semester: '', academic_year: '', student_code: '', date_of_birth: '', gender: '', phone_number: '', room_type: 'Thường', notes: '', applicant_profile: emptyApplicantProfile() });

const dateLabel = (value: string) => {
  if (!value) return 'Chọn ngày sinh';
  const date = new Date(`${value}T00:00:00`);
  return Number.isNaN(date.getTime()) ? 'Chọn ngày sinh' : date.toLocaleDateString('vi-VN');
};

function rosterRows(rows: DormitoryRosterEntry[]) {
  const text = (value: unknown) => typeof value === 'string' ? value.trim() : '';
  return rows.map(row => ({
    'Mã SV': text(row.student_id?.student_code) || text(row.student_code),
    'Họ và tên': text(row.student_id?.full_name) || text(row.full_name),
    'Phòng': text(row.assigned_room_name) || text(typeof row.room_id === 'object' ? row.room_id.room_name || row.room_id.room_code : ''),
    'Trạng thái định danh': row.identity_state || '',
    'Ngày tạo': row.createdAt ? createdDateLabel(row.createdAt) : '',
  }));
}

export const selectedPdfRosterEntry = (rows: DormitoryRosterEntry[], selectedIds: string[]) => {
  if (selectedIds.length !== 1) return undefined;
  return rows.find(row => row._id === selectedIds[0]);
};

export const selectedPdfRosterEntries = (rows: DormitoryRosterEntry[], selectedIds: string[]) => {
  const selectedSet = new Set(selectedIds);
  return rows.filter(row => selectedSet.has(row._id));
};

type RoomAssignmentPopoverProps = {
  row: DormitoryRosterEntry;
  onAssigned: (assignment: RoomAssignment) => void;
  compact?: boolean;
};

const assignmentId = (value: Room | Bed | string | null | undefined) => (
  typeof value === 'object' && value !== null ? value._id : value
);

export function RoomAssignmentPopover({ row, onAssigned, compact = false }: RoomAssignmentPopoverProps) {
  const [open, setOpen] = useState(false);
  const [rooms, setRooms] = useState<Room[]>([]);
  const [selectedRoom, setSelectedRoom] = useState<Room | null>(null);
  const [beds, setBeds] = useState<Bed[]>([]);
  const [loading, setLoading] = useState(false);
  const [bedsLoading, setBedsLoading] = useState(false);
  const [error, setError] = useState('');
  const [assigning, setAssigning] = useState(false);
  const [unassignConfirmOpen, setUnassignConfirmOpen] = useState(false);
  const bedRequestRef = useRef(0);
  const currentRoomId = assignmentId(row.room_id);
  const currentBedId = assignmentId(row.bed_id);

  useEffect(() => {
    if (!open) return;
    setOpen(false);
    bedRequestRef.current += 1;
    setSelectedRoom(null);
    setBeds([]);
    setBedsLoading(false);
    setError('');
  }, [compact]);

  const handleOpenChange = (nextOpen: boolean) => {
    setOpen(nextOpen);
    if (!nextOpen) {
      bedRequestRef.current += 1;
      setSelectedRoom(null);
      setBeds([]);
      setBedsLoading(false);
      setError('');
      return;
    }

    bedRequestRef.current += 1;
    setRooms([]);
    setSelectedRoom(null);
    setBeds([]);
    setError('');
    setLoading(true);
    void dormitoryApi.roster.suggestRooms(row._id)
      .then(setRooms)
      .catch((err: any) => setError(err?.message || 'Không thể tải danh sách phòng.'))
      .finally(() => setLoading(false));
  };

  const selectRoom = async (room: Room) => {
    if (assigning) return;
    const requestId = ++bedRequestRef.current;
    setSelectedRoom(room);
    setBeds([]);
    setError('');
    setBedsLoading(true);
    try {
      const nextBeds = await dormitoryApi.beds.getByRoom(room._id);
      if (bedRequestRef.current === requestId) setBeds(nextBeds);
    } catch (err: any) {
      if (bedRequestRef.current === requestId) {
        setError(err?.message || 'Không thể tải danh sách giường.');
      }
    } finally {
      if (bedRequestRef.current === requestId) setBedsLoading(false);
    }
  };

  const assignBed = async (room: Room, bed: Bed) => {
    if (assigning || bed._id === currentBedId || !isAvailableBed(bed) || room.status !== 'Trống') return;
    setAssigning(true);
    setError('');
    try {
      const result = await dormitoryApi.roster.assignRoom({ roster_entry_id: row._id, room_id: room._id, bed_id: bed._id });
      toast.success(currentRoomId ? 'Đã đổi phòng cho sinh viên' : 'Đã phân phòng cho sinh viên');
      setOpen(false);
      onAssigned({ room: result.room || room, bed: result.bed || bed, roster_entry: result.roster_entry, active_contract_id: result.active_contract_id });
    } catch (err: any) {
      setError(err?.message || 'Không thể phân phòng.');
    } finally {
      setAssigning(false);
    }
  };

  const unassignRoom = async () => {
    if (assigning || !currentBedId) return;
    setAssigning(true);
    setError('');
    try {
      const result = await dormitoryApi.roster.unassignRoom(row._id);
      toast.success('Đã bỏ chọn phòng');
      setOpen(false);
      onAssigned({ room: null, bed: result.bed, roster_entry: result.roster_entry });
    } catch (err: any) {
      setError(err?.message || 'Không thể bỏ chọn phòng.');
    } finally { setAssigning(false); }
  };

  const renderRoomList = () => (
    <div className="space-y-1">
      {rooms.map(room => {
        const isCurrentRoom = room._id === currentRoomId;
        const selectable = isCurrentRoom || (room.status === 'Trống' && room.available_bed_count > 0);
        return (
          <button type="button" key={room._id} disabled={!selectable || assigning} onClick={() => compact ? void selectRoom(room) : selectedRoom?._id === room._id ? (setSelectedRoom(null), setBeds([])) : void selectRoom(room)} className={`flex min-h-11 w-full items-center justify-between rounded-xl border border-transparent px-3 py-2 text-left text-xs transition-all duration-150 ease-out hover:border-white/70 hover:bg-white/60 disabled:cursor-not-allowed disabled:opacity-50 ${selectedRoom?._id === room._id ? 'border-blue-500/20 bg-blue-500/10' : ''}`}>
          <span className="min-w-0">
              <span className="block truncate font-semibold text-sm text-slate-700">{room.room_name || room.room_code}</span>
              <span className="block text-xs text-slate-500">{roomQuantityLabel(room)}{isCurrentRoom ? ' · Phòng hiện tại' : ''}</span>
            </span>
            <span className="ml-2 shrink-0 text-xs text-slate-500">{roomStatusLabel(room.status)}</span>
          </button>
        );
      })}
    </div>
  );

  const renderBedList = () => (
    <div className="space-y-1">
      {beds.map(bed => {
        const isCurrentBed = bed._id === currentBedId;
        const selectable = !isCurrentBed && selectedRoom?.status === 'Trống' && isAvailableBed(bed);
        return (
          <button type="button" key={bed._id} disabled={!selectable || assigning} onClick={() => selectedRoom && void assignBed(selectedRoom, bed)} className="flex min-h-11 w-full items-center justify-between rounded-xl border border-transparent px-3 py-2 text-left text-xs transition-all duration-150 ease-out hover:border-white/70 hover:bg-white/60 disabled:cursor-not-allowed disabled:opacity-60">
            <span className="font-semibold text-sm text-slate-700">{bed.bed_code || bed._id}</span>
            <span className={`text-xs ${isCurrentBed ? 'font-semibold text-emerald-700' : 'text-slate-500'}`}>{isCurrentBed ? 'Đang chọn' : bed.status}</span>
          </button>
        );
      })}
    </div>
  );

  const renderPickerBody = () => loading ? (
    <p className="px-2 py-3 text-sm text-slate-500">Đang tải phòng...</p>
  ) : error && !selectedRoom ? (
    <p role="alert" className="px-2 py-3 text-sm text-red-600">{error}</p>
  ) : rooms.length === 0 && !selectedRoom ? (
    <p className="px-2 py-3 text-sm text-slate-500">Không có phòng phù hợp.</p>
  ) : selectedRoom ? (
    <div className="space-y-2">
      {compact && <button type="button" onClick={() => { bedRequestRef.current += 1; setSelectedRoom(null); setBeds([]); setBedsLoading(false); setError(''); }} disabled={assigning} className="min-h-11 rounded-xl px-2 text-xs font-semibold text-slate-600 transition-all duration-150 ease-out hover:bg-white/60">← Quay lại danh sách phòng</button>}
      <p className="px-2 text-sm font-semibold text-slate-600">Giường trong {selectedRoom.room_name || selectedRoom.room_code}</p>
      {bedsLoading ? <p className="px-2 py-2 text-sm text-slate-500">Đang tải giường...</p> : error ? <p role="alert" className="px-2 py-2 text-sm text-red-600">{error}</p> : beds.length === 0 ? <p className="px-2 py-2 text-sm text-slate-500">Phòng chưa có giường.</p> : renderBedList()}
    </div>
  ) : renderRoomList();

  const renderUnassign = () => currentBedId && (
    <button type="button" disabled={assigning} onClick={() => setUnassignConfirmOpen(true)} className="mt-2 min-h-11 w-full rounded-xl border border-rose-500/20 bg-rose-500/10 px-3 py-2 text-left text-xs font-semibold text-rose-700 transition-all duration-150 ease-out hover:bg-rose-500/15 disabled:opacity-50">Bỏ chọn phòng</button>
  );

  const trigger = <button type="button" aria-label={`${currentRoomId ? 'Đổi phòng' : 'Thêm phòng'} cho ${studentName(row)}`} title={currentRoomId ? 'Đổi phòng' : 'Thêm phòng'} className="rounded-xl p-1.5 text-emerald-600 hover:bg-emerald-50"><DoorOpen size={16} /></button>;
  return (
    <>
      {compact ? (
        <Dialog open={open} onOpenChange={handleOpenChange}>
          <DialogTrigger asChild>{trigger}</DialogTrigger>
          <DialogContent showCloseButton className="!flex !max-h-[calc(100dvh-2rem)] !w-[calc(100%-2rem)] !max-w-md flex-col overflow-hidden rounded-2xl border border-white/70 bg-gradient-to-br from-[#EBF2FA]/95 via-[#E7EEF8]/90 to-[#DCE6F1]/95 p-4 text-[#1E293B] shadow-sm shadow-slate-300/40 backdrop-blur-md">
            <DialogHeader className="shrink-0 border-b border-white/60 pb-3 pr-8 text-left"><DialogTitle className="text-base font-bold text-[#1E293B]">{selectedRoom ? 'Chọn giường' : 'Chọn phòng'}</DialogTitle></DialogHeader>
            <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain py-2 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">{renderPickerBody()}</div>
            <div className="shrink-0 border-t border-white/60 pt-2">{renderUnassign()}</div>
          </DialogContent>
        </Dialog>
      ) : (
        <Popover open={open} onOpenChange={handleOpenChange}>
          <PopoverTrigger asChild>{trigger}</PopoverTrigger>
          <PopoverContent align="end" side="bottom" sideOffset={6} collisionPadding={8} className="z-[120] flex max-h-[min(32rem,calc(100dvh-1rem))] w-80 flex-col rounded-2xl border border-white/70 bg-gradient-to-br from-[#EBF2FA]/95 via-[#E7EEF8]/90 to-[#DCE6F1]/95 p-2 text-[#1E293B] shadow-sm shadow-slate-300/40 backdrop-blur-md">
            <div className="shrink-0 border-b border-white/60 px-2 pb-2 text-xs font-semibold">Chọn phòng</div>
            <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain py-2 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">{renderPickerBody()}</div>
            <div className="shrink-0 border-t border-white/60 pt-2">{renderUnassign()}</div>
          </PopoverContent>
        </Popover>
      )}
      <ConfirmModal isOpen={unassignConfirmOpen} onClose={() => setUnassignConfirmOpen(false)} onConfirm={unassignRoom} title="Bỏ chọn phòng" message="Bạn có chắc muốn bỏ chọn phòng hiện tại? Giường sẽ được trả về trạng thái trống." confirmLabel="Bỏ chọn phòng" cancelLabel="Hủy" variant="warning" />
    </>
  );
}

export default function DormitoryRosterPage() {
  const { user, hasPermission } = useAuth();
  const isResidentStudent = user?.roleCode === 'STUDENT';
  const canCreate = hasPermission('DORM_REG_CREATE');
  const canView = isResidentStudent || hasPermission('DORM_REG_READ');
  const canUpdate = hasPermission('DORM_REG_UPDATE');
  const canDelete = hasPermission('DORM_REG_DELETE');
  const canAssignRoom = hasPermission('DORM_REG_UPDATE') && hasPermission('DORM_ROOM_READ');
  const [registrations, setRegistrations] = useState<DormitoryRosterEntry[]>([]);
  const [loading, setLoading] = useState(true); const [error, setError] = useState('');
  const [search, setSearch] = useState(''); const [page, setPage] = useState(1); const [pageSize, setPageSize] = useState(40);
  const [selected, setSelected] = useState<string[]>([]);
  const [roomFilter, setRoomFilter] = useState(''); const [roomOptions, setRoomOptions] = useState<DormitoryRosterRoomOption[]>([]);
  const [meta, setMeta] = useState<{ total: number; totalPages: number } | null>(null); const [refreshing, setRefreshing] = useState(false); const [mobileSearchOpen, setMobileSearchOpen] = useState(false); const [isCompact, setIsCompact] = useState(false);
  const searchRef = useRef<HTMLInputElement>(null); const mobileScrollRef = useRef<HTMLDivElement>(null); const mobileSentinelRef = useRef<HTMLDivElement>(null);
  const rosterRequestRef = useRef(0); const studentRequestRef = useRef(0);
  const [mobileLoadingMore, setMobileLoadingMore] = useState(false); const [mobileLoadError, setMobileLoadError] = useState(false); const [mobileHasMore, setMobileHasMore] = useState(true); const mobilePageRef = useRef(1); const mobileHasMoreRef = useRef(true); const queryGenerationRef = useRef(0);
  const [createOpen, setCreateOpen] = useState(false); const [importOpen, setImportOpen] = useState(false); const [createSaving, setCreateSaving] = useState(false); const [createError, setCreateError] = useState(''); const [semesterError, setSemesterError] = useState(''); const [semesterLoading, setSemesterLoading] = useState(false); const [activeSemesterName, setActiveSemesterName] = useState(''); const [calendarOpen, setCalendarOpen] = useState(false);
  const [qrOpen, setQrOpen] = useState(false); const [qrDataUrl, setQrDataUrl] = useState(''); const [qrError, setQrError] = useState('');
  const [studentSearch, setStudentSearch] = useState(''); const [studentOptions, setStudentOptions] = useState<Student[]>([]); const [student, setStudent] = useState<Student | null>(null);
  const [createForm, setCreateForm] = useState<CreateForm>(emptyCreateForm);
  const [editRow, setEditRow] = useState<DormitoryRosterEntry | null>(null);
  const [deleteRow, setDeleteRow] = useState<DormitoryRosterEntry | null>(null); const [bulkDeleteOpen, setBulkDeleteOpen] = useState(false); const [bulkDeleting, setBulkDeleting] = useState(false);
  const [reconcileOpen, setReconcileOpen] = useState(false); const [reconciling, setReconciling] = useState(false); const [importing, setImporting] = useState(false);
  const [operation, setOperation] = useState<'delete' | 'reconcile' | null>(null); const [operationProgress, setOperationProgress] = useState<RosterOperationProgress | null>(null); const [operationPending, setOperationPending] = useState(false);
  const [linkRow, setLinkRow] = useState<DormitoryRosterEntry | null>(null); const linkTriggerRef = useRef<HTMLButtonElement | null>(null);
  const [pdfRows, setPdfRows] = useState<DormitoryRosterEntry[]>([]); const [pdfUrl, setPdfUrl] = useState(''); const [pdfLoading, setPdfLoading] = useState(false); const [pdfError, setPdfError] = useState('');
  const [leaderRow, setLeaderRow] = useState<DormitoryRosterEntry | null>(null); const [leaderSaving, setLeaderSaving] = useState(false);
  const [bulkUnassignOpen, setBulkUnassignOpen] = useState(false); const [bulkUnassigning, setBulkUnassigning] = useState(false);

  useEffect(() => () => { if (pdfUrl) URL.revokeObjectURL(pdfUrl); }, [pdfUrl]);
  useEffect(() => {
    if (!canView || isResidentStudent) return;
    let cancelled = false;
    void dormitoryApi.roster.getRoomOptions().then(options => { if (!cancelled) setRoomOptions(options); }).catch(() => { if (!cancelled) setRoomOptions([]); });
    return () => { cancelled = true; };
  }, [canView, isResidentStudent]);
  const loadPdfPreview = async (targets: DormitoryRosterEntry[]) => {
    if (pdfLoading || !targets.length) return;
    if (pdfUrl) { URL.revokeObjectURL(pdfUrl); setPdfUrl(''); }
    setPdfRows(targets); setPdfLoading(true); setPdfError('');
    try {
      const blob = targets.length === 1
        ? await dormitoryApi.roster.getApplicationPdf(targets[0]._id, 'inline')
        : await dormitoryApi.roster.getApplicationPdfBulk(targets.map(item => item._id), 'inline');
      setPdfUrl(URL.createObjectURL(blob));
    } catch (err: any) {
      setPdfError(err?.message || 'Không thể tạo bản xem trước đơn KTX.');
    } finally {
      setPdfLoading(false);
    }
  };
  const downloadPdf = async (targets: DormitoryRosterEntry[]) => {
    if (pdfLoading || !targets.length) return;
    try {
      let blob: Blob;
      let filename: string;
      if (targets.length === 1) {
        blob = await dormitoryApi.roster.getApplicationPdf(targets[0]._id, 'attachment');
        filename = `danh-sach-ktx-${String(targets[0].roster_entry_code || targets[0]._id).replace(/[^a-zA-Z0-9_-]/g, '_')}.pdf`;
      } else {
        blob = await dormitoryApi.roster.getApplicationPdfBulk(targets.map(item => item._id), 'attachment');
        filename = `danh-sach-ktx-tong-hop-${targets.length}-sinh-vien.pdf`;
      }
      const url = URL.createObjectURL(blob);
      const link = document.createElement('a'); link.href = url; link.download = filename; document.body.appendChild(link); link.click(); link.remove(); URL.revokeObjectURL(url);
    } catch (err: any) { toast.error(err?.message || 'Không thể xuất PDF đơn KTX.'); }
  };

  useEffect(() => {
    if (!qrOpen) return;
    const url = getPublicRegistrationUrl(window.location.origin);
    setQrError('');
    void QRCodeLib.toDataURL(url, { errorCorrectionLevel: 'H', type: 'image/png', width: 320, margin: 3, color: { dark: '#000000', light: '#FFFFFF' } }).then(setQrDataUrl).catch(() => { setQrDataUrl(''); setQrError('Không thể tạo mã QR.'); });
  }, [qrOpen]);

  useEffect(() => { if (mobileSearchOpen) searchRef.current?.focus(); }, [mobileSearchOpen]);
  useEffect(() => {
    if (!window.matchMedia) return;
    const media = window.matchMedia('(max-width: 1023px)');
    const update = () => setIsCompact(media.matches);
    update();
    media.addEventListener?.('change', update);
    return () => media.removeEventListener?.('change', update);
  }, []);
  useEffect(() => {
    const requestId = ++studentRequestRef.current;
    if (!createOpen || !studentSearch.trim() || student) { setStudentOptions([]); return; }
    const timer = window.setTimeout(async () => {
      try { const result = await studentApi.getStudents({ search: studentSearch.trim(), page: 1, limit: 10, status: 'Studying' }); if (studentRequestRef.current === requestId) setStudentOptions(Array.isArray(result) ? result : result.data || []); } catch { if (studentRequestRef.current === requestId) setStudentOptions([]); }
    }, 300);
    return () => window.clearTimeout(timer);
  }, [createOpen, studentSearch, student]);
  useEffect(() => {
    if (!createOpen) return;
    let cancelled = false;
    setSemesterLoading(true); setSemesterError('');
    void semesterApi.getSemesters().then(items => { if (!cancelled) { const values = mapActiveSemester(items); const active = items.find(semester => semester.status === 'active'); setActiveSemesterName(active?.semester_name || ''); setCreateForm(current => ({ ...current, ...values })); } }).catch((err: any) => { if (!cancelled) { setActiveSemesterName(''); setSemesterError(err?.message || 'Không thể tải học kỳ active.'); setCreateForm(current => ({ ...current, semester: '', academic_year: '' })); } }).finally(() => { if (!cancelled) setSemesterLoading(false); });
    return () => { cancelled = true; };
  }, [createOpen]);
  const resetCreate = () => { setStudent(null); setStudentSearch(''); setStudentOptions([]); setCreateError(''); setSemesterError(''); setActiveSemesterName(''); setCalendarOpen(false); setCreateForm(emptyCreateForm()); };
  const selectStudent = (item: Student) => { setStudent(item); setStudentSearch(''); setStudentOptions([]); setCreateForm(current => ({ ...current, student_code: item.student_code || '', date_of_birth: dateInputValue(item.date_bir), gender: item.sex, room_type: item.sex === 'Female' ? current.room_type : 'Thường', phone_number: (item as Student & { phone_number?: string }).phone_number || '' })); };
  const clearStudentSelection = (value: string) => { setStudent(null); setStudentSearch(value); setStudentOptions([]); setCreateForm(current => ({ ...current, student_code: '', date_of_birth: '', gender: '' })); };
  const submitCreate = async (event: React.FormEvent) => {
    event.preventDefault(); setCreateError('');
    const birthDate = createForm.date_of_birth ? new Date(`${createForm.date_of_birth}T00:00:00`) : null;
    if (semesterLoading) { setCreateError('Đang tải học kỳ active, vui lòng chờ.'); return; }
    if (semesterError || !createForm.semester || !createForm.academic_year) { setCreateError(semesterError || 'Chưa xác định được học kỳ active.'); return; }
    const temporaryName = student ? '' : studentSearch.trim();
    if (!student && !temporaryName) { setCreateError('Vui lòng chọn sinh viên từ kết quả tìm kiếm hoặc nhập họ tên.'); return; }
    if (!student && (!birthDate || Number.isNaN(birthDate.getTime()) || birthDate >= new Date())) { setCreateError('Ngày sinh phải là một ngày hợp lệ trong quá khứ.'); return; }
    if (!student && (!createForm.gender || !createForm.phone_number.trim())) { setCreateError('Vui lòng nhập đủ ngày sinh, giới tính và số điện thoại.'); return; }
    if (student && !createForm.phone_number.trim()) { setCreateError('Vui lòng nhập số điện thoại.'); return; }
    if (!/^[0-9+().\s-]{8,20}$/.test(createForm.phone_number.trim())) { setCreateError('Số điện thoại không hợp lệ.'); return; }
    if (!student) {
      try {
        setCreateSaving(true);
        await dormitoryApi.roster.create({
          full_name: temporaryName,
          student_code: createForm.student_code?.trim() || undefined,
          date_of_birth: createForm.date_of_birth,
          gender: createForm.gender as Exclude<CreateForm['gender'], ''>,
          phone_number: createForm.phone_number.trim(),
          room_type: createForm.gender === 'Female' ? createForm.room_type : 'Thường',
          notes: createForm.notes || undefined,
          applicant_profile: compactApplicantProfile(createForm.applicant_profile),
        });
        toast.success('Đã thêm vào Danh sách KTX');
        setCreateOpen(false);
        resetCreate();
        reset();
        await load(true, 1);
      } catch (err: any) {
        setCreateError(err?.message || 'Không thể thêm vào Danh sách KTX.');
      } finally {
        setCreateSaving(false);
      }
      return;
    }
    const payload: CreateDormitoryRosterEntryInput = {
      student_id: student._id,
      phone_number: createForm.phone_number.trim(),
      room_type: createForm.room_type,
      notes: createForm.notes || undefined,
      applicant_profile: compactApplicantProfile(createForm.applicant_profile),
    };
    try {
      setCreateSaving(true);
      await dormitoryApi.roster.create(payload);
      toast.success('Đã thêm vào Danh sách KTX');
      setCreateOpen(false);
      resetCreate();
      reset();
      await load(true, 1);
    } catch (err: any) {
      setCreateError(err?.message || 'Không thể thêm vào Danh sách KTX.');
    } finally {
      setCreateSaving(false);
    }
  };
  const reset = () => { setPage(1); setSelected([]); mobilePageRef.current = 1; mobileHasMoreRef.current = true; setMobileHasMore(true); setMobileLoadError(false); queryGenerationRef.current += 1; rosterRequestRef.current += 1; };
  const load = useCallback(async (background = false, requestedPage = page) => {
    const requestId = ++rosterRequestRef.current;
    const requested = isCompact ? 1 : requestedPage;
    try {
      background ? setRefreshing(true) : setLoading(true); setError('');
      const res = isResidentStudent
        ? { data: (await dormitoryApi.roster.getMineRoommates()).data as any, meta: { total: 0, totalPages: 1 } }
        : await dormitoryApi.roster.getAll({ search: search.trim() || undefined, room_id: roomFilter || undefined, page: requested, limit: pageSize });
      if (rosterRequestRef.current !== requestId) return;
      setRegistrations(res.data); setMeta(res.meta); mobilePageRef.current = requested;
      const hasMore = isCompact && requested < res.meta.totalPages;
      mobileHasMoreRef.current = hasMore; setMobileHasMore(hasMore); setMobileLoadError(false);
    } catch (err: any) {
      if (rosterRequestRef.current === requestId) { setError(err?.message || 'Không thể tải Danh sách KTX.'); toast.error(err?.message || 'Lỗi tải Danh sách KTX'); }
    } finally { if (rosterRequestRef.current === requestId) { setLoading(false); setRefreshing(false); } }
  }, [isCompact, page, pageSize, search, roomFilter, isResidentStudent]);
  useEffect(() => { const timer = window.setTimeout(() => void load(), 200); return () => window.clearTimeout(timer); }, [load]);
  useEffect(() => {
    queryGenerationRef.current += 1; mobilePageRef.current = 1; mobileHasMoreRef.current = true; setMobileHasMore(true); setMobileLoadError(false);
    if (isCompact) { setPage(1); setSelected([]); }
  }, [isCompact, pageSize, search, roomFilter]);
  const loadMoreMobile = useCallback(async () => {
    if (!isCompact || loading || mobileLoadingMore || !mobileHasMoreRef.current) return;
    setMobileLoadingMore(true);
    const nextPage = mobilePageRef.current + 1;
    const generation = queryGenerationRef.current;
    const requestId = ++rosterRequestRef.current;
    try {
      const res = await dormitoryApi.roster.getAll({ search: search.trim() || undefined, room_id: roomFilter || undefined, page: nextPage, limit: pageSize });
      const next = res.data || [];
      if (rosterRequestRef.current !== requestId || queryGenerationRef.current !== generation) return;
      setRegistrations(current => [...current, ...next.filter(item => !current.some(row => row._id === item._id))]);
      mobilePageRef.current = nextPage;
      const hasMore = nextPage < res.meta.totalPages;
      mobileHasMoreRef.current = hasMore; setMobileHasMore(hasMore); setMobileLoadError(false);
    } catch { if (queryGenerationRef.current === generation) { setMobileLoadError(true); setError('Không thể tải thêm đăng ký.'); } } finally { setMobileLoadingMore(false); }
  }, [isCompact, loading, search, pageSize, mobileLoadingMore, roomFilter]);
  useEffect(() => {
    const target = mobileSentinelRef.current;
    if (!target || !isCompact) return;
    const observer = new IntersectionObserver(([entry]) => { if (entry.isIntersecting && !mobileLoadError) void loadMoreMobile(); }, { root: mobileScrollRef.current, rootMargin: '160px', threshold: 0.1 });
    observer.observe(target);
    return () => observer.disconnect();
  }, [isCompact, loadMoreMobile, mobileLoadError]);
  const allSelected = registrations.length > 0 && registrations.every(row => selected.includes(row._id));
  const toggleAll = (checked: boolean) => setSelected(checked ? registrations.map(row => row._id) : []);
  const openEdit = (row: DormitoryRosterEntry) => setEditRow(row);
  const deleteRegistration = async () => {
    if (!deleteRow) return;
    await dormitoryApi.roster.delete(deleteRow._id);
    toast.success('Đã xóa mục Danh sách KTX'); setSelected(ids => ids.filter(id => id !== deleteRow._id)); setDeleteRow(null); await load(true);
  };
  const removeSelected = async () => {
    if (bulkDeleting || !selected.length) return;
    const frozen = [...new Set(selected)];
    if (frozen.length > 100) { toast.error('Tối đa 100 mục Danh sách KTX mỗi lần xóa.'); return; }
    setBulkDeleting(true);
    setBulkDeleteOpen(false);
    setOperation('delete');
    setOperationPending(true);
    setOperationProgress({ phase: 'processing', processed: 0, total: frozen.length, counters: { deleted: 0, blocked: 0, notFound: 0, invalid: 0 }, unconfirmed: 0, unsent: 0 });
    try {
      const run = await runRosterBatches<string, Awaited<ReturnType<typeof dormitoryApi.roster.bulkDelete>>>(frozen, 10, batch => dormitoryApi.roster.bulkDelete([...batch]), state => {
        const outcomes = state.acknowledged as ReadonlyArray<{ deleted: string[]; blocked: Array<{ id: string }>; not_found: string[]; invalid: string[] }>;
        setOperationProgress({ phase: state.status === 'interrupted' ? 'interrupted' : state.status === 'partial' ? 'partial' : state.status === 'completed' ? 'completed' : 'processing', processed: state.processed, total: state.total, counters: { deleted: outcomes.flatMap(item => item.deleted || []).length, blocked: outcomes.flatMap(item => item.blocked || []).length, notFound: outcomes.flatMap(item => item.not_found || []).length, invalid: outcomes.flatMap(item => item.invalid || []).length }, unconfirmed: state.unconfirmed.length, unsent: state.unsent.length });
      }, response => Boolean(response.blocked?.length || response.not_found?.length || response.invalid?.length));
      const results = run.acknowledged;
      const result = { deleted: results.flatMap(item => item.deleted), blocked: results.flatMap(item => item.blocked), not_found: results.flatMap(item => item.not_found), invalid: results.flatMap(item => item.invalid) };
      const deletedIds = new Set(result.deleted);
      const retainedIds = frozen.filter(id => !deletedIds.has(id));
      const failedCount = result.blocked.length + result.not_found.length + result.invalid.length;
      setSelected(run.status === 'interrupted' ? retainedIds : retainedIds);
      if (result.deleted.length) await load(true);
      if (run.status === 'interrupted') toast.error('Xóa bị gián đoạn; batch chưa xác nhận và các mục chưa gửi vẫn được giữ lại.');
      else if (!failedCount) toast.success(`Đã xóa ${result.deleted.length} mục Danh sách KTX`);
      else if (result.deleted.length) toast.warning(`Đã xóa ${result.deleted.length} mục, ${failedCount} mục không thể xóa`);
      else toast.error('Không thể xóa các mục Danh sách KTX đã chọn.');
    } catch (err: any) {
      toast.error(err?.message || 'Không thể xóa các mục Danh sách KTX đã chọn.');
      setOperationProgress(current => current ? { ...current, phase: 'interrupted', message: 'Yêu cầu thất bại. Không tự động gửi lại batch đã có thể đã được ghi nhận.' } : current);
    } finally {
      setBulkDeleting(false);
      setOperationPending(false);
    }
  };
  type BulkUnassignOutcome = {
    id: string;
    ok: boolean;
    response?: Awaited<ReturnType<typeof dormitoryApi.roster.unassignRoom>>;
    error?: unknown;
  };
  const eligibleSelectedRows = registrations.filter(row => selected.includes(row._id) && Boolean(row.room_id && row.bed_id));
  const openBulkUnassign = () => {
    if (!canAssignRoom || operationPending || !eligibleSelectedRows.length) return;
    if (eligibleSelectedRows.length > 100) {
      toast.error('Tối đa 100 mục có phòng mỗi lần bỏ chọn phòng.');
      return;
    }
    setBulkUnassignOpen(true);
  };
  const unassignSelected = async () => {
    if (bulkUnassigning || operationPending) return;
    const frozen = [...new Set(eligibleSelectedRows.map(row => row._id))].slice(0, 100);
    if (!frozen.length) { setBulkUnassignOpen(false); return; }
    setBulkUnassigning(true);
    setBulkUnassignOpen(false);
    setOperationPending(true);
    try {
      const run = await runRosterBatches<string, BulkUnassignOutcome[]>(frozen, 10, async batch => {
        const outcomes = await Promise.all(batch.map(async id => {
          try { return { id, ok: true, response: await dormitoryApi.roster.unassignRoom(id) }; }
          catch (error) { return { id, ok: false, error }; }
        }));
        return outcomes;
      });
      const outcomes = run.acknowledged.flat();
      const successful = new Set(outcomes.filter(item => item.ok).map(item => item.id));
      const failed = frozen.length - successful.size;
      const responses = new Map(outcomes.filter(item => item.ok && item.response).map(item => [item.id, item.response!]));
      setRegistrations(current => current.map(row => {
        const response = responses.get(row._id);
        return successful.has(row._id) && response ? applyRoomUnassignment(row, response) : row;
      }));
      setSelected(current => current.filter(id => !successful.has(id)));
      if (!failed) toast.success(`Đã bỏ chọn phòng cho ${successful.size} mục`);
      else if (successful.size) toast.warning(`Đã bỏ chọn phòng cho ${successful.size} mục; ${failed} mục chưa thay đổi`);
      else toast.error('Không thể bỏ chọn phòng cho các mục đã chọn.');
    } catch (err: any) {
      toast.error(err?.message || 'Không thể bỏ chọn phòng cho các mục đã chọn.');
    } finally {
      setBulkUnassigning(false);
      setOperationPending(false);
    }
  };
  const openSelectedPdfPreview = () => {
    const targets = selectedPdfRosterEntries(registrations, selected);
    if (!targets.length) {
      toast.error('Vui lòng chọn ít nhất một đơn để xuất PDF.');
      return;
    }
    if (targets.length > 100) {
      toast.error('Tối đa 100 đơn mỗi lần xuất PDF.');
      return;
    }
    void loadPdfPreview(targets);
  };
  const reconcileAll = async () => {
    if (reconciling) return;
    setReconcileOpen(false);
    setReconciling(true);
    setOperation('reconcile');
    setOperationPending(true);
    setOperationProgress({ phase: 'processing', processed: 0, total: 0, counters: { linked: 0, unlinked: 0, conflicts: 0, failed: 0 } });
    let cursor: string | undefined;
    let hasMore = true;
    let processed = 0;
    try {
      while (hasMore) {
        const response = await dormitoryApi.roster.reconcile({ after_id: cursor, limit: 100 });
        processed += response.scanned;
        hasMore = response.has_more && Boolean(response.next_cursor);
        cursor = response.next_cursor;
        setOperationProgress(current => ({ phase: hasMore ? 'processing' : 'completed', processed, total: hasMore ? null : processed, counters: { linked: (current?.counters.linked || 0) + response.linked, unlinked: (current?.counters.unlinked || 0) + response.unlinked, conflicts: (current?.counters.conflicts || 0) + response.conflicts, failed: (current?.counters.failed || 0) + response.failed } }));
      }
      await load(true);
      toast.success('Đã hoàn tất đối chiếu liên kết.');
    } catch (err: any) {
      setOperationProgress(current => current ? { ...current, phase: 'interrupted', message: err?.message || 'Không thể đối chiếu liên kết.' } : current);
      toast.error(err?.message || 'Không thể đối chiếu liên kết.');
    } finally {
      setReconciling(false);
      setOperationPending(false);
    }
  };
  const openStudentLink = (row: DormitoryRosterEntry, event: React.MouseEvent<HTMLButtonElement>) => {
    linkTriggerRef.current = event.currentTarget;
    setLinkRow(row);
  };
  const saveLeader = async () => {
    if (!leaderRow) return;
    const target = leaderRow;
    setLeaderSaving(true);
    try { await dormitoryApi.roster.setRoomLeader(target._id, !target.is_room_leader); setLeaderRow(null); await load(true); toast.success(target.is_room_leader ? 'Đã gỡ trưởng phòng' : 'Đã cập nhật trưởng phòng'); }
    catch (err: any) { toast.error(err?.message || 'Không thể cập nhật trưởng phòng.'); }
    finally { setLeaderSaving(false); }
  };
  const closeOperation = (open: boolean) => { if (!operationPending && !open) { setOperationProgress(null); setOperation(null); } };
  const columns: ResponsiveColumn<DormitoryRosterEntry>[] = [
    { key: 'student_code', header: 'Mã SV', priority: 'primary', render: (_, r) => studentCode(r) }, { key: 'student_name', header: 'Họ và tên', priority: 'secondary', render: (_, r) => studentName(r) },
    { key: 'room', header: 'Phòng', render: (_, r) => <div className="flex flex-wrap items-center gap-1.5"><span className={isUnassignedRoom(r) ? 'font-medium text-amber-600' : undefined}>{roomLabel(r)}</span>{r.is_room_leader && <span className="rounded-full bg-amber-100 px-2 py-0.5 text-[11px] font-bold text-amber-800" aria-label="Trưởng phòng">Trưởng phòng</span>}</div> }, { key: 'identity', header: 'Định danh', render: (_, r) => <span className={`rounded-full px-2.5 py-1 text-xs font-bold ${r.identity_state === 'LINKED' ? 'bg-emerald-100 text-emerald-700' : r.identity_state === 'CONFLICT' ? 'bg-red-100 text-red-700' : 'bg-amber-100 text-amber-700'}`}>{r.identity_state === 'LINKED' ? 'Đã liên kết' : r.identity_state === 'CONFLICT' ? 'Cần kiểm tra' : 'Chưa liên kết'}</span> },
    { key: 'created', header: 'Ngày tạo', render: (_, r) => createdDateLabel(r.createdAt) },
    { key: 'actions', header: 'Thao tác', priority: 'action', className: 'text-right', render: (_, r) => <div className="flex justify-end gap-1">{canAssignRoom && !operationPending && <RoomAssignmentPopover compact={isCompact} row={r} onAssigned={assignment => setRegistrations(current => current.map(item => item._id === r._id ? applyRoomAssignment(item, assignment) : item))} />}{canUpdate && r.bed_id && r.room_id && <button type="button" aria-label={`${r.is_room_leader ? 'Gỡ trưởng phòng' : 'Chọn trưởng phòng'} cho ${studentName(r)}`} title={r.is_room_leader ? 'Gỡ trưởng phòng' : 'Chọn trưởng phòng'} disabled={leaderSaving || operationPending} onClick={() => setLeaderRow(r)} className="rounded-xl p-1.5 text-amber-700 hover:bg-amber-50 disabled:opacity-50">{r.is_room_leader ? '★' : '☆'}</button>}{canUpdate && r.identity_state !== 'LINKED' && <button type="button" aria-label={`Liên kết sinh viên cho ${studentName(r)}`} title="Liên kết sinh viên" disabled={bulkDeleting || reconciling || importing || operationPending} onClick={event => openStudentLink(r, event)} className="rounded-xl p-1.5 text-emerald-600 hover:bg-emerald-50 disabled:opacity-50"><Link2 size={16} /></button>}{canUpdate && <button type="button" aria-label={`Sửa đơn ${studentName(r)}`} title="Sửa" disabled={importing || operationPending} onClick={() => openEdit(r)} className="rounded-xl p-1.5 text-blue-600 hover:bg-blue-50 disabled:opacity-50"><Pencil size={16} /></button>}{canDelete && <button type="button" aria-label={`Xóa đơn ${studentName(r)}`} title="Xóa" disabled={importing || operationPending} onClick={() => setDeleteRow(r)} className="rounded-xl p-1.5 text-red-600 hover:bg-red-50 disabled:opacity-50"><Trash2 size={16} /></button>}</div> },
  ];
  return <main className="flex h-full min-h-0 flex-col gap-3 overflow-y-auto bg-transparent p-4 custom-scrollbar max-lg:[scrollbar-width:none] max-lg:[&::-webkit-scrollbar]:hidden sm:p-6">
    {mobileSearchOpen ? (
      <div className="flex w-full items-center gap-1 py-0.5 lg:hidden">
        <Research ref={searchRef} aria-label="Tìm kiếm đăng ký" placeholder="Tìm kiếm..." value={search} onChange={e => { setSearch(e.target.value); reset(); }} containerClassName="flex-1 w-full max-w-none" />
        <Button type="button" variant="outline" aria-label="Đóng tìm kiếm" title="Đóng" onClick={() => setMobileSearchOpen(false)} className="h-9 w-9 shrink-0 rounded-xl border border-white/80 bg-white/50 p-0 text-slate-700"><X size={16} /></Button>
      </div>
    ) : null}
    <div className={`flex shrink-0 items-center justify-start gap-1 overflow-x-auto scrollbar-none py-0.5 w-full flex-nowrap ${mobileSearchOpen ? 'hidden lg:flex' : ''}`}>
      <Research aria-label="Tìm kiếm đăng ký" placeholder="Tìm kiếm..." value={search} onChange={e => { setSearch(e.target.value); reset(); }} containerClassName="hidden lg:flex shrink-0 w-[231px]" />
      {!mobileSearchOpen && <Button type="button" variant="outline" aria-label="Mở tìm kiếm" title="Tìm kiếm" onClick={() => setMobileSearchOpen(true)} className="flex lg:hidden h-9 w-9 shrink-0 items-center justify-center rounded-xl border border-white/80 bg-white/50 p-0 text-slate-700"><SearchIcon size={15} /></Button>}
      {canView && <label className="flex shrink-0 items-center gap-2 text-xs font-semibold text-slate-700"><span className="sr-only">Lọc theo phòng</span><select aria-label="Lọc theo phòng" value={roomFilter} onChange={event => { setRoomFilter(event.target.value); reset(); }} className="h-9 max-w-[190px] rounded-xl border border-white/80 bg-white/60 px-2 text-xs text-slate-700 outline-none"><option value="">Tất cả phòng</option>{roomOptions.map(room => <option key={room._id} value={room._id}>{room.room_name || room.room_code}</option>)}</select></label>}
      <div className="ml-auto flex items-center gap-2 shrink-0 flex-nowrap">
        {canView && <Button type="button" variant="outline" aria-label="Mở QR đăng ký KTX" title="QR đăng ký KTX" onClick={() => setQrOpen(true)} className="h-9 w-9 shrink-0 rounded-xl border border-white/80 bg-white/50 p-0 text-slate-700"><QrCode size={15} /></Button>}
        {shouldShowRosterImport(canCreate) && <Button type="button" variant="outline" aria-label="Nhập danh sách KTX từ Excel" disabled={importing || operationPending} onClick={() => setImportOpen(true)} className="h-9 shrink-0 rounded-xl border border-white/80 bg-white/50 px-3 text-xs text-slate-700 hover:bg-white/80"><Upload size={14} /> <span className="hidden sm:inline">Nhập Excel</span></Button>}
        {canUpdate && <Button type="button" variant="outline" aria-label="Đối chiếu liên kết KTX" disabled={reconciling || bulkDeleting || Boolean(operationPending)} onClick={() => setReconcileOpen(true)} className="h-9 shrink-0 rounded-xl border border-white/80 bg-white/50 px-3 text-xs text-slate-700 hover:bg-white/80">Đối chiếu</Button>}
        {canCreate && <Button type="button" variant="outline" aria-label="Thêm sinh viên" disabled={importing || operationPending} onClick={() => setCreateOpen(true)} className="h-9 shrink-0 rounded-xl border border-white/80 bg-white/50 px-3 text-xs text-slate-700 hover:bg-white/80"><Plus size={14} /> <span className="hidden sm:inline">Thêm sinh viên</span></Button>}
        <Button type="button" variant="outline" aria-label="Tải lại danh sách" title="Tải lại" onClick={() => void load(true)} disabled={refreshing || importing || operationPending} className="h-9 w-9 shrink-0 rounded-xl border border-white/80 bg-white/50 p-0 text-slate-700"><RefreshCw size={14} className={refreshing ? 'animate-spin' : ''} /></Button>
      </div>
    </div>
    {error && <div role="alert" className="rounded-xl bg-red-50 p-3 text-sm text-red-700">{error}</div>}
    <div className="flex min-h-0 flex-1 overflow-hidden bg-transparent lg:rounded-2xl lg:border lg:border-white/70 lg:bg-white/45 lg:shadow-sm lg:shadow-slate-300/40 lg:backdrop-blur-md"><ResponsiveDataView data={registrations} columns={columns} isLoading={loading} breakpoint="lg" keyExtractor={r => r._id} tableClassName={REGISTRATION_TABLE_CLASS_NAME} mobileScrollRef={mobileScrollRef} mobileVirtualization mobileClassName="px-0 py-4" hideMobileSelection hidePaginationOnMobile mobileFooter={<div ref={mobileSentinelRef} className="flex min-h-12 items-center justify-center py-3 text-center text-xs text-slate-500">{mobileLoadingMore ? 'Đang tải thêm...' : mobileLoadError ? <button type="button" className="text-blue-600 underline" onClick={() => void loadMoreMobile()}>Thử lại</button> : !mobileHasMore && registrations.length ? 'Đã hiển thị tất cả bản ghi.' : null}</div>} selection={{ selectedKeys: selected, onSelectRow: (key, checked) => setSelected(ids => checked ? [...ids, key] : ids.filter(id => id !== key)), onSelectAll: toggleAll, allSelected }} emptyState={<div className="p-8 text-center text-sm text-slate-500">Chưa có mục Danh sách KTX nào</div>} pagination={<CustomPagination totalItems={meta?.total || 0} pageSize={pageSize} currentPage={page} onPageChange={p => { setPage(p); setSelected([]); }} onPageSizeChange={s => { setPage(1); setPageSize(s); setSelected([]); }} pageSizeOptions={pageSizeOptions} isLoading={loading} label="mục Danh sách KTX" />} /></div>
    <FloatingActionBar selectedCount={selected.length} onClear={() => setSelected([])} itemLabel="đơn" actions={<>{canAssignRoom && eligibleSelectedRows.length > 0 && <button type="button" aria-label="Bỏ chọn phòng" disabled={operationPending || bulkUnassigning} onClick={openBulkUnassign} className="inline-flex items-center gap-1.5 rounded-xl bg-amber-600 px-3 py-1.5 text-xs font-semibold text-white transition-all duration-150 ease-out hover:bg-amber-700 disabled:opacity-50"><DoorOpen size={14} /> Bỏ chọn phòng</button>}{canDelete && <button type="button" aria-label="Xóa đơn đã chọn" disabled={bulkDeleting || reconciling || operationPending} onClick={() => setBulkDeleteOpen(true)} className="inline-flex items-center gap-1.5 rounded-xl bg-rose-600 px-3 py-1.5 text-xs font-semibold text-white hover:bg-rose-700 disabled:opacity-50"><Trash2 size={14} /> Xóa</button>}{canView && <button type="button" aria-label="Xuất PDF đã chọn" disabled={pdfLoading || bulkDeleting || reconciling || operationPending} onClick={openSelectedPdfPreview} className="inline-flex items-center rounded-xl bg-rose-600 px-3 py-1.5 text-xs font-semibold text-white hover:bg-rose-700 disabled:opacity-50">Xuất PDF</button>}</>} />
    <ConfirmModal isOpen={bulkUnassignOpen} onClose={() => !bulkUnassigning && setBulkUnassignOpen(false)} onConfirm={unassignSelected} title="Bỏ chọn phòng hàng loạt" message={`Bạn có chắc muốn bỏ chọn phòng cho ${eligibleSelectedRows.length} mục đã chọn? Các mục chưa được xếp phòng sẽ không bị thay đổi.`} confirmLabel="Bỏ chọn phòng" cancelLabel="Hủy" variant="warning" disabled={bulkUnassigning || operationPending} />
    <Dialog open={pdfRows.length > 0} onOpenChange={open => { if (!open) { if (pdfUrl) URL.revokeObjectURL(pdfUrl); setPdfUrl(''); setPdfRows([]); setPdfError(''); } }}>
      <DialogContent className="flex h-[90vh] max-w-5xl flex-col"><DialogHeader><DialogTitle>{pdfRows.length > 1 ? `Xem trước đơn KTX (${pdfRows.length} sinh viên)` : 'Xem trước đơn KTX'}</DialogTitle></DialogHeader>{pdfLoading ? <div className="flex flex-1 items-center justify-center text-sm"><Loader2 className="mr-2 h-4 w-4 animate-spin" />Đang tạo PDF...</div> : pdfError ? <div className="space-y-3 py-8 text-center"><p role="alert" className="text-sm text-red-600">{pdfError}</p><Button onClick={() => pdfRows.length > 0 && void loadPdfPreview(pdfRows)}>Thử lại</Button></div> : pdfUrl ? <iframe title="Xem trước đơn KTX" src={pdfUrl} className="min-h-0 flex-1 rounded border" /> : null}<DialogFooter><Button variant="outline" onClick={() => { if (pdfUrl) URL.revokeObjectURL(pdfUrl); setPdfUrl(''); setPdfRows([]); setPdfError(''); }}>Đóng</Button>{pdfRows.length > 0 && <Button disabled={pdfLoading || Boolean(pdfError)} onClick={() => void downloadPdf(pdfRows)}>Xuất PDF</Button>}</DialogFooter></DialogContent>
    </Dialog>
    <Dialog open={qrOpen} onOpenChange={setQrOpen}>
      <DialogContent className="w-[calc(100%-2rem)] max-w-md rounded-2xl border border-white/80 bg-gradient-to-br from-[#EBF2FA] to-[#DCE6F1] p-4 font-sans shadow-2xl">
        <DialogHeader className="border-b border-white/60 pb-2"><DialogTitle className="flex items-center gap-2 text-sm font-bold text-[#1E293B]"><QrCode className="h-4 w-4 text-blue-600" />QR đăng ký KTX</DialogTitle></DialogHeader>
        <div className="space-y-3 py-2 text-center"><p className="text-xs text-slate-600">Quét mã để mở trang đăng ký KTX công khai</p>{qrDataUrl && <img src={qrDataUrl} alt="QR mở trang đăng ký KTX" className="mx-auto h-64 w-64 rounded-lg bg-white p-2" />}{qrError && <p role="alert" className="text-sm text-red-600">{qrError}</p>}<p className="break-all rounded-xl border border-white/80 bg-white/60 px-3 py-2 text-[11px] text-slate-600">{typeof window !== 'undefined' ? getPublicRegistrationUrl(window.location.origin) : PUBLIC_REGISTRATION_PATH}</p></div>
        <DialogFooter className="border-t border-white/60 pt-2"><Button type="button" variant="outline" onClick={() => setQrOpen(false)}>Đóng</Button></DialogFooter>
      </DialogContent>
    </Dialog>
    <DormitoryRegistrationEditModal open={Boolean(editRow)} registration={editRow} canEdit={canUpdate} onOpenChange={open => { if (!open) setEditRow(null); }} onSuccess={() => load(true)} />
    <DormitoryRosterImportModal isOpen={importOpen} onClose={() => setImportOpen(false)} onSuccess={() => void load(true)} onOperationStateChange={setImporting} />
    <RosterOperationProgressDialog open={Boolean(operationProgress)} operation={operation || 'delete'} progress={operationProgress || { phase: 'preparing', processed: 0, total: 0, counters: {} }} pending={operationPending} onOpenChange={closeOperation} />
    <RosterStudentLinkModal open={Boolean(linkRow)} registration={linkRow} onOpenChange={open => { if (!open) setLinkRow(null); }} onSuccess={() => load(true)} restoreFocus={() => linkTriggerRef.current?.focus()} />
    <ConfirmModal isOpen={Boolean(leaderRow)} onClose={() => !leaderSaving && setLeaderRow(null)} onConfirm={saveLeader} title={leaderRow?.is_room_leader ? 'Gỡ trưởng phòng' : 'Chọn trưởng phòng'} message={leaderRow ? `Xác nhận ${leaderRow.is_room_leader ? 'gỡ vai trò trưởng phòng của' : 'chọn'} ${studentName(leaderRow)}? Trưởng phòng hiện tại của phòng sẽ được thay thế nếu có.` : null} confirmLabel="Xác nhận" cancelLabel="Hủy" variant="warning" disabled={leaderSaving} />
    <ConfirmModal
      isOpen={bulkDeleteOpen}
      onClose={() => !bulkDeleting && setBulkDeleteOpen(false)}
      onConfirm={removeSelected}
      title="Xóa các mục Danh sách KTX"
      message={`Bạn có chắc muốn xóa ${selected.length} mục Danh sách KTX đã chọn không? Các mục bị hệ thống chặn sẽ vẫn được giữ lại.`}
      confirmLabel="Xóa mục"
      cancelLabel="Hủy"
      variant="danger"
      disabled={bulkDeleting}
    />
    <ConfirmModal
      isOpen={Boolean(deleteRow)}
      onClose={() => setDeleteRow(null)}
      onConfirm={async () => {
        try { await deleteRegistration(); } catch (err: any) { toast.error(err?.message || 'Không thể xóa mục Danh sách KTX.'); throw err; }
      }}
      title="Xóa mục Danh sách KTX"
      message={deleteRow ? <>Bạn có chắc muốn xóa đơn của <strong>{studentName(deleteRow)}</strong> ({studentCode(deleteRow)}) không?</> : null}
      confirmLabel="Xóa đơn"
      cancelLabel="Hủy"
      variant="danger"
    />
    <Dialog open={reconcileOpen} onOpenChange={open => { if (!reconciling) setReconcileOpen(open); }}><DialogContent className="w-[calc(100%-1rem)] max-w-lg rounded-2xl border border-white/75 bg-white/45 p-4 text-[#1E293B] shadow-sm shadow-slate-300/40 backdrop-blur-md sm:p-5"><DialogHeader><DialogTitle>Đối chiếu liên kết KTX</DialogTitle></DialogHeader><p className="rounded-xl border border-white/75 bg-white/50 p-3 text-sm leading-6 text-[#64748B]">Hệ thống sẽ quét tất cả mục chưa liên kết hoặc đang xung đột ở mọi học kỳ, theo thứ tự ổn định. Chỉ sinh viên đang học và thuộc lớp hiện tại được xét.</p><DialogFooter><Button variant="outline" disabled={reconciling} onClick={() => setReconcileOpen(false)} className="rounded-xl">Hủy</Button><Button disabled={reconciling || bulkDeleting} onClick={() => void reconcileAll()} className="rounded-xl">Bắt đầu đối chiếu</Button></DialogFooter></DialogContent></Dialog>
    <Dialog open={createOpen} onOpenChange={open => { setCreateOpen(open); if (!open && !createSaving) resetCreate(); }}>
      <DialogContent className="max-h-[calc(100dvh-1rem)] w-[calc(100%-1rem)] max-w-4xl overflow-y-auto overscroll-contain rounded-2xl border border-white/80 bg-gradient-to-br from-[#EBF2FA] to-[#DCE6F1] p-4 shadow-2xl shadow-slate-300/40 backdrop-blur-md max-lg:[scrollbar-width:none] max-lg:[&::-webkit-scrollbar]:hidden sm:max-h-[90vh] sm:p-6 sm:max-w-4xl">
        <DialogHeader className="mb-4 border-b border-white/50 pb-3">
          <DialogTitle className="flex flex-wrap items-center gap-2 pr-8 text-sm font-black uppercase leading-snug tracking-wider text-[#1E293B]">
            <span className="min-w-0">Thêm sinh viên đăng ký KTX</span>
            {activeSemesterName && <span className="break-words text-[11px] font-semibold normal-case text-[#64748B]">{activeSemesterName}</span>}
            {semesterLoading && <span className="text-[11px] font-semibold normal-case text-[#64748B]">Đang tải học kỳ…</span>}
          </DialogTitle>
        </DialogHeader>
        <form onSubmit={submitCreate} className="space-y-4">
          <div className="grid gap-4 lg:grid-cols-2">
            <section className="space-y-4 rounded-2xl border border-white/80 bg-white/60 p-4 shadow-sm">
              <div className="relative">
                <div className="flex items-end gap-2"><Input label={student ? 'Sinh viên' : 'Họ và tên'} required id="registration-student" value={student ? `${student.student_code} — ${student.full_name}` : studentSearch} onChange={e => clearStudentSelection(e.target.value)} placeholder="Tìm sinh viên hoặc nhập họ tên…" autoComplete="off" readOnly={Boolean(student)} containerClassName="min-w-0 flex-1" />{student && <Button type="button" variant="outline" onClick={() => clearStudentSelection('')} className="mb-0 h-10 shrink-0 whitespace-nowrap px-2 text-xs sm:px-3 sm:text-sm">Chuyển nhập tay</Button>}</div>
                {!student && studentSearch.trim() && <p className="mt-1 px-1 text-xs text-slate-500">Không chọn kết quả: hồ sơ chưa liên kết.</p>}
                {studentOptions.length > 0 && <div className="absolute z-10 mt-1 max-h-48 w-full overflow-auto rounded-xl border border-white/80 bg-white shadow-xl">{studentOptions.map(item => <Button variant="ghost" type="button" key={item._id} onClick={() => selectStudent(item)} className="h-auto w-full justify-start rounded-none px-3 py-2 text-left text-sm"><span className="font-semibold">{item.student_code} — {item.full_name}</span><span className="ml-2 text-xs text-slate-500">{typeof item.class_id === 'object' ? item.class_id?.class_name : ''}</span></Button>)}</div>}
              </div>
              {!student && <Input label="Mã SV" value={createForm.student_code || ''} onChange={e => setCreateForm(f => ({ ...f, student_code: e.target.value }))} placeholder="Nhập mã sinh viên (nếu có)" />}
              <div className="grid gap-4 sm:grid-cols-2">
                <div className="flex w-full flex-col gap-1.5">
                  <label className="flex items-center gap-1 px-1 text-[13px] font-bold text-[#1E293B]">Ngày sinh <span className="text-red-500">*</span></label>
                  <Popover open={calendarOpen} onOpenChange={setCalendarOpen}>
                    <PopoverTrigger asChild>
                        <Button type="button" variant="outline" aria-label="Ngày sinh" disabled={Boolean(student)} className="h-10 w-full justify-between rounded-xl border border-white/70 bg-white/50 px-3 text-sm font-normal text-[#1E293B] hover:bg-white/70"><span className="truncate">{dateLabel(createForm.date_of_birth)}</span><Calendar size={15} aria-hidden="true" className="shrink-0 text-[#64748B]" /></Button>
                    </PopoverTrigger>
                    <PopoverContent className="z-[100] w-auto overflow-hidden border-none bg-transparent p-0 shadow-none" align="start">
                      <CustomCalendar
                        startDate={createForm.date_of_birth ? new Date(`${createForm.date_of_birth}T00:00:00`) : null}
                        endDate={null}
                        onRangeSelect={(start) => setCreateForm(f => ({ ...f, date_of_birth: dateInputValue(start) }))}
                        onRangeConfirm={(start, end) => setCreateForm(f => {
                          const startValue = dateInputValue(start);
                          const endValue = end ? dateInputValue(end) : '';
                          return { ...f, date_of_birth: endValue && startValue === f.date_of_birth ? endValue : startValue };
                        })}
                        onCancel={() => setCalendarOpen(false)}
                        onConfirm={() => setCalendarOpen(false)}
                      />
                    </PopoverContent>
                  </Popover>
                </div>
                <div className="space-y-1.5"><label className="flex items-center gap-1 px-1 text-[13px] font-bold text-[#1E293B]">Giới tính <span className="text-red-500">*</span></label><div className="hidden lg:block"><Select disabled={Boolean(student)} value={createForm.gender} onValueChange={value => setCreateForm(f => ({ ...f, gender: value as CreateForm['gender'], room_type: value === 'Female' ? f.room_type : 'Thường' }))}><SelectTrigger aria-label="Giới tính" className="w-full"><SelectValue placeholder="Chọn giới tính" /></SelectTrigger><SelectContent className="w-[calc(100vw-2rem)] max-w-[280px]"><SelectItem value="Male">Nam</SelectItem><SelectItem value="Female">Nữ</SelectItem><SelectItem value="Other">Khác</SelectItem></SelectContent></Select></div><div className="lg:hidden"><DormitoryChoicePopover ariaLabel="Giới tính" disabled={Boolean(student)} value={createForm.gender} options={[{ value: 'Male', label: 'Nam' }, { value: 'Female', label: 'Nữ' }, { value: 'Other', label: 'Khác' }]} onValueChange={value => setCreateForm(f => ({ ...f, gender: value as CreateForm['gender'], room_type: value === 'Female' ? f.room_type : 'Thường' }))} placeholder="Chọn giới tính" /></div></div>
              </div>
              <Input label="Số điện thoại" required type="tel" value={createForm.phone_number} onChange={e => setCreateForm(f => ({ ...f, phone_number: e.target.value }))} placeholder="Nhập số điện thoại" />
            </section>
            <section className="space-y-4 rounded-2xl border border-white/80 bg-white/60 p-4 shadow-sm">
              <div className="space-y-1.5"><label className="flex items-center gap-1 px-1 text-[13px] font-bold text-[#1E293B]">Loại phòng</label><div className="hidden lg:block"><Select value={createForm.room_type} disabled={createForm.gender !== 'Female'} onValueChange={value => setCreateForm(f => ({ ...f, room_type: value as CreateForm['room_type'] }))}><SelectTrigger aria-label="Loại phòng" className="w-full"><SelectValue /></SelectTrigger><SelectContent className="w-[calc(100vw-2rem)] max-w-[280px]"><SelectItem value="Thường">Thường</SelectItem><SelectItem value="Máy lạnh">Máy lạnh (Ưu tiên cho nữ)</SelectItem></SelectContent></Select></div><div className="lg:hidden"><DormitoryChoicePopover ariaLabel="Loại phòng" disabled={createForm.gender !== 'Female'} value={createForm.room_type} options={[{ value: 'Thường', label: 'Thường' }, { value: 'Máy lạnh', label: 'Máy lạnh (Ưu tiên cho nữ)' }]} onValueChange={value => setCreateForm(f => ({ ...f, room_type: value as CreateForm['room_type'] }))} /></div></div>
              <Input label="Ghi chú" multiline rows={3} value={createForm.notes} onChange={e => setCreateForm(f => ({ ...f, notes: e.target.value }))} />
            </section>
            <ApplicantProfileFields value={createForm.applicant_profile} onChange={value => setCreateForm(f => ({ ...f, applicant_profile: value }))} className="col-span-full" />
          </div>
          {(createError || semesterError) && <p role="alert" aria-live="polite" className="text-sm text-red-600">{createError || semesterError}</p>}
          <DialogFooter className="mt-2 gap-2 border-t border-white/50 pt-4 sm:gap-0"><Button type="button" variant="outline" onClick={() => setCreateOpen(false)} disabled={createSaving} className="w-full sm:w-auto">Hủy</Button><Button type="submit" disabled={createSaving || semesterLoading || Boolean(semesterError) || !createForm.semester} className="w-full sm:w-auto">{createSaving ? 'Đang lưu…' : 'Tạo đăng ký'}</Button></DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  </main>;
}
