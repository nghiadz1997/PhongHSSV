'use client';

import { useEffect, useState } from 'react';
import { Calendar, CheckCircle2, Loader2 } from 'lucide-react';
import { ApplicantProfile, dormitoryApi, PublicDormitoryRegistrationInput, PublicDormitorySemester } from '@/api/dormitory-api';
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/Input';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { CustomCalendar } from '@/components/calendar/CustomCalendar';

type FormState = {
  full_name: string;
  student_code?: string;
  date_of_birth: string;
  gender: '' | PublicDormitoryRegistrationInput['gender'];
  phone_number: string;
  room_type: 'Thường' | 'Máy lạnh';
  notes?: string;
  qr_room_id?: string;
  applicant_profile: ApplicantProfile;
};

export const emptyApplicantProfile = (): ApplicantProfile => ({ ethnicity: '', religion: '', citizen_id_number: '', citizen_id_issue_date: '', citizen_id_issue_place: '', permanent_address: '', priority_certificate_details: '', father: { full_name: '', age: '', permanent_address: '', contact_address: '', occupation: '', phone_number: '' }, mother: { full_name: '', age: '', permanent_address: '', contact_address: '', occupation: '', phone_number: '' } });
export const compactApplicantProfile = (profile: ApplicantProfile): ApplicantProfile | undefined => {
  const compactParent = (parent?: ApplicantProfile['father']) => parent && Object.values(parent).some(value => String(value ?? '').trim()) ? Object.fromEntries(Object.entries(parent).filter(([, value]) => String(value ?? '').trim())) : undefined;
  const fields = Object.fromEntries(Object.entries(profile).filter(([key, value]) => key !== 'father' && key !== 'mother' && String(value ?? '').trim()));
  const father = compactParent(profile.father); const mother = compactParent(profile.mother);
  return Object.keys(fields).length || father || mother ? { ...fields, ...(father ? { father } : {}), ...(mother ? { mother } : {}) } : undefined;
};
const emptyForm: FormState = { full_name: '', student_code: '', date_of_birth: '', gender: '', phone_number: '', room_type: 'Thường', notes: '', applicant_profile: emptyApplicantProfile() };

const toDateValue = (date: Date | null) => date ? `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}` : '';
const dateLabel = (value: string) => value ? new Date(`${value}T00:00:00`).toLocaleDateString('vi-VN') : 'Chọn ngày sinh';
const issueDateLabel = (value: string) => value ? new Date(`${value}T00:00:00`).toLocaleDateString('vi-VN') : 'Chọn ngày cấp';
export const publicRoomTypeForGender = (gender: FormState['gender'], requested: FormState['room_type'] = 'Thường') => gender === 'Female' ? requested : 'Thường';
export const buildPublicRegistrationPayload = (form: FormState): PublicDormitoryRegistrationInput => ({
  full_name: form.full_name.trim(),
  student_code: form.student_code?.trim() || undefined,
  date_of_birth: form.date_of_birth,
  gender: form.gender as PublicDormitoryRegistrationInput['gender'],
  phone_number: form.phone_number.trim(),
  notes: form.notes?.trim() || undefined,
  room_type: publicRoomTypeForGender(form.gender, form.room_type),
  qr_room_id: form.qr_room_id,
  applicant_profile: compactApplicantProfile(form.applicant_profile),
});

export function ApplicantProfileFields({ value, onChange, className = '' }: { value: ApplicantProfile; onChange: (value: ApplicantProfile) => void; className?: string }) {
  const [issueDateCalendarOpen, setIssueDateCalendarOpen] = useState(false);
  const set = (key: Exclude<keyof ApplicantProfile, 'father' | 'mother'>, next: string) => onChange({ ...value, [key]: next });
  const setParent = (parent: 'father' | 'mother', key: string, next: string) => onChange({ ...value, [parent]: { ...value[parent], [key]: next } });
  const parentFields = (parent: 'father' | 'mother', label: string) => <section className="space-y-3 rounded-xl border border-white/80 bg-white/50 p-3"><h3 className="text-sm font-bold text-[#1E293B]">{label}</h3><div className="grid gap-3 sm:grid-cols-2"><Input label="Họ và tên" value={value[parent]?.full_name || ''} onChange={e => setParent(parent, 'full_name', e.target.value)} placeholder="Nhập họ và tên" /><Input label="Tuổi" type="number" min="0" value={String(value[parent]?.age || '')} onChange={e => setParent(parent, 'age', e.target.value)} placeholder="Nhập tuổi" /><Input label="Nghề nghiệp" value={value[parent]?.occupation || ''} onChange={e => setParent(parent, 'occupation', e.target.value)} placeholder="Nhập nghề nghiệp" /><Input label="Số điện thoại" type="tel" value={value[parent]?.phone_number || ''} onChange={e => setParent(parent, 'phone_number', e.target.value)} placeholder="Nhập số điện thoại" /><Input label="Địa chỉ thường trú" value={value[parent]?.permanent_address || ''} onChange={e => setParent(parent, 'permanent_address', e.target.value)} placeholder="Nhập địa chỉ thường trú" containerClassName="sm:col-span-2" /><Input label="Địa chỉ liên hệ" value={value[parent]?.contact_address || ''} onChange={e => setParent(parent, 'contact_address', e.target.value)} placeholder="Nhập địa chỉ liên hệ" containerClassName="sm:col-span-2" /></div></section>;
  return <section className={`space-y-4 rounded-2xl border border-white/80 bg-gradient-to-br from-[#EBF2FA]/60 to-white/60 p-4 ${className}`}><h2 className="text-sm font-black text-[#1E293B]">Thông tin hồ sơ (không bắt buộc)</h2><div className="grid gap-3 sm:grid-cols-2"><Input label="Dân tộc" value={value.ethnicity || ''} onChange={e => set('ethnicity', e.target.value)} placeholder="Nhập dân tộc" /><Input label="Tôn giáo" value={value.religion || ''} onChange={e => set('religion', e.target.value)} placeholder="Nhập tôn giáo" /><Input label="Số CCCD/CMND" value={value.citizen_id_number || ''} onChange={e => set('citizen_id_number', e.target.value)} placeholder="Nhập số CCCD/CMND" /><div className="space-y-1.5"><label className="flex items-center gap-1 px-1 text-[13px] font-bold text-[#1E293B]">Ngày cấp CCCD/CMND</label><Popover open={issueDateCalendarOpen} onOpenChange={setIssueDateCalendarOpen}><PopoverTrigger asChild><Button type="button" variant="outline" aria-label="Ngày cấp CCCD/CMND" className="h-10 w-full justify-between rounded-xl border-white/90 bg-white/70 px-3 text-sm font-normal"><span>{issueDateLabel(value.citizen_id_issue_date || '')}</span><Calendar size={15} /></Button></PopoverTrigger><PopoverContent className="z-[100] w-auto border-none bg-transparent p-0 shadow-none" align="start"><CustomCalendar startDate={value.citizen_id_issue_date ? new Date(`${value.citizen_id_issue_date}T00:00:00`) : null} endDate={null} onRangeSelect={() => undefined} onRangeConfirm={start => set('citizen_id_issue_date', toDateValue(start))} onCancel={() => setIssueDateCalendarOpen(false)} onConfirm={() => setIssueDateCalendarOpen(false)} /></PopoverContent></Popover></div><Input label="Nơi cấp CCCD/CMND" value={value.citizen_id_issue_place || ''} onChange={e => set('citizen_id_issue_place', e.target.value)} placeholder="Nhập nơi cấp CCCD/CMND" /><Input label="Địa chỉ thường trú" value={value.permanent_address || ''} onChange={e => set('permanent_address', e.target.value)} placeholder="Nhập địa chỉ thường trú" /><Input label="Thông tin giấy chứng nhận ưu tiên" multiline rows={2} value={value.priority_certificate_details || ''} onChange={e => set('priority_certificate_details', e.target.value)} placeholder="Nhập thông tin giấy chứng nhận (nếu có)" containerClassName="sm:col-span-2" /></div><div className="grid gap-4 lg:grid-cols-2">{parentFields('father', 'Thông tin cha')}{parentFields('mother', 'Thông tin mẹ')}</div></section>;
}

export function PublicDormitoryRegistrationModal({ qrRoomId, open = true, onOpenChange }: { qrRoomId?: string; open?: boolean; onOpenChange?: (open: boolean) => void }) {
  const [form, setForm] = useState<FormState>({ ...emptyForm, qr_room_id: qrRoomId });
  const [semester, setSemester] = useState<PublicDormitorySemester | null>(null);
  const [semesterError, setSemesterError] = useState('');
  const [error, setError] = useState('');
  const [saving, setSaving] = useState(false);
  const [successCode, setSuccessCode] = useState('');
  const [calendarOpen, setCalendarOpen] = useState(false);

  useEffect(() => {
    setForm(current => ({ ...current, qr_room_id: qrRoomId }));
  }, [qrRoomId]);

  useEffect(() => {
    let cancelled = false;
    dormitoryApi.public.getActiveSemester().then(value => { if (!cancelled) setSemester(value); }).catch(err => { if (!cancelled) setSemesterError(err?.message || 'Không thể tải học kỳ active.'); });
    return () => { cancelled = true; };
  }, []);

  const setField = <K extends keyof FormState>(key: K, value: FormState[K]) => setForm(current => ({ ...current, [key]: value }));
  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    if (saving || successCode) return;
    setError('');
    const birth = form.date_of_birth ? new Date(`${form.date_of_birth}T00:00:00`) : null;
    if (!semester || semesterError) return setError('Chưa xác định được học kỳ active. Vui lòng thử lại sau.');
    if (!form.full_name.trim() || !form.date_of_birth || !birth || Number.isNaN(birth.getTime()) || birth >= new Date()) return setError('Vui lòng nhập họ tên và ngày sinh hợp lệ trong quá khứ.');
    if (!form.gender || !form.phone_number.trim()) return setError('Vui lòng nhập giới tính và số điện thoại.');
    if (!/^[0-9+().\s-]{8,20}$/.test(form.phone_number.trim())) return setError('Số điện thoại không hợp lệ.');
    const payload = buildPublicRegistrationPayload(form);
    try {
      setSaving(true);
      const result = await dormitoryApi.public.register(payload);
      if (!result.success) { setError(result.message || 'Không thể hoàn tất đăng ký.'); return; }
      setSuccessCode(result.roster_entry_code || '');
    } catch (err: any) {
      setError(err?.message || 'Không thể gửi đăng ký. Vui lòng thử lại.');
    } finally { setSaving(false); }
  };

  return <div className="flex min-h-screen items-center justify-center bg-gradient-to-br from-[#EBF2FA] via-white to-[#DCE6F1] p-4">
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[calc(100dvh-1rem)] w-[calc(100%-1rem)] max-w-4xl overflow-y-auto overscroll-contain rounded-2xl border border-white/80 bg-gradient-to-br from-[#EBF2FA] to-[#DCE6F1] p-4 shadow-2xl shadow-slate-300/40 backdrop-blur-md sm:max-h-[90vh] sm:p-6 sm:max-w-4xl">
        {successCode ? <div className="py-8 text-center"><CheckCircle2 className="mx-auto mb-4 h-14 w-14 text-emerald-600" /><DialogTitle className="text-xl font-black text-[#1E293B]">Đăng ký thành công</DialogTitle><p className="mt-2 text-sm text-slate-600">Mã đăng ký của bạn</p><p className="my-4 rounded-xl bg-white/70 px-4 py-3 font-mono text-xl font-black text-blue-700">{successCode}</p><p className="text-xs text-slate-500">Vui lòng lưu mã để tra cứu với bộ phận quản lý KTX.</p></div> : <>
           <DialogHeader className="mb-4 border-b border-white/60 pb-3"><DialogTitle className="flex flex-wrap items-center gap-2 pr-8 text-sm font-black uppercase leading-snug tracking-wider text-[#1E293B]"><span className="min-w-0">Đăng ký KTX</span>{semester && <span className="break-words text-[11px] font-semibold normal-case text-[#64748B]">{semester.semester_name}</span>}</DialogTitle></DialogHeader>
          <form onSubmit={submit} className="space-y-4">
            <div className="grid gap-4 sm:grid-cols-2">
              <Input label="Họ và tên" required value={form.full_name} onChange={e => setField('full_name', e.target.value)} placeholder="Nhập họ và tên" />
              <Input label="Mã SV" value={form.student_code || ''} onChange={e => setField('student_code', e.target.value)} placeholder="Nhập mã sinh viên (nếu có)" />
              <div className="space-y-1.5"><label className="flex items-center gap-1 px-1 text-[13px] font-bold text-[#1E293B]">Ngày sinh <span className="text-red-500">*</span></label><Popover open={calendarOpen} onOpenChange={setCalendarOpen}><PopoverTrigger asChild><Button type="button" variant="outline" aria-label="Chọn ngày sinh" className="h-10 w-full justify-between rounded-xl border-white/90 bg-white/70 px-3 text-sm font-normal"><span className="truncate">{dateLabel(form.date_of_birth)}</span><Calendar size={15} aria-hidden="true" /></Button></PopoverTrigger><PopoverContent className="z-[100] w-auto overflow-hidden border-none bg-transparent p-0 shadow-none" align="start"><CustomCalendar startDate={form.date_of_birth ? new Date(`${form.date_of_birth}T00:00:00`) : null} endDate={null} onRangeSelect={(start) => setField('date_of_birth', toDateValue(start))} onRangeConfirm={(start) => setField('date_of_birth', toDateValue(start))} onCancel={() => setCalendarOpen(false)} onConfirm={() => setCalendarOpen(false)} /></PopoverContent></Popover></div>
              <div className="space-y-1.5"><label className="flex items-center gap-1 px-1 text-[13px] font-bold text-[#1E293B]">Giới tính <span className="text-red-500">*</span></label><Select value={form.gender} onValueChange={value => setForm(current => ({ ...current, gender: value as FormState['gender'], room_type: value === 'Female' ? current.room_type : 'Thường' }))}><SelectTrigger aria-label="Giới tính" className="w-full bg-white/70"><SelectValue placeholder="Chọn giới tính" /></SelectTrigger><SelectContent className="w-[calc(100vw-2rem)] max-w-[280px]"><SelectItem value="Male">Nam</SelectItem><SelectItem value="Female">Nữ</SelectItem><SelectItem value="Other">Khác</SelectItem></SelectContent></Select></div>
              <Input label="Số điện thoại" required type="tel" value={form.phone_number} onChange={e => setField('phone_number', e.target.value)} placeholder="Nhập số điện thoại" />
              <div className="space-y-1.5"><label className="px-1 text-[13px] font-bold text-[#1E293B]">Loại phòng</label><Select value={form.room_type} disabled={form.gender !== 'Female'} onValueChange={value => setField('room_type', value as FormState['room_type'])}><SelectTrigger aria-label="Loại phòng" className="w-full bg-white/70"><SelectValue /></SelectTrigger><SelectContent className="w-[calc(100vw-2rem)] max-w-[280px]"><SelectItem value="Thường">Thường</SelectItem><SelectItem value="Máy lạnh">Máy lạnh (Ưu tiên cho nữ)</SelectItem></SelectContent></Select></div>
              <Input label="Ghi chú" multiline rows={3} value={form.notes || ''} onChange={e => setField('notes', e.target.value)} placeholder="Nhập ghi chú (nếu có)" containerClassName="sm:col-span-2" />
              <ApplicantProfileFields value={form.applicant_profile} onChange={value => setField('applicant_profile', value)} className="sm:col-span-2" />
            </div>
             {(error || semesterError) && <p role="alert" aria-live="polite" className="text-sm text-red-600">{error || semesterError}</p>}
             <DialogFooter className="mt-2 gap-2 border-t border-white/50 pt-4 sm:gap-0"><Button type="button" variant="outline" onClick={() => onOpenChange?.(false)} disabled={saving} className="w-full sm:w-auto">Hủy</Button><Button type="submit" disabled={saving || !semester || Boolean(semesterError)} className="w-full sm:w-auto">{saving ? <><Loader2 className="mr-2 h-4 w-4 animate-spin" />Đang gửi…</> : 'Gửi đăng ký'}</Button></DialogFooter>
          </form>
        </>}
      </DialogContent>
    </Dialog>
  </div>;
}
