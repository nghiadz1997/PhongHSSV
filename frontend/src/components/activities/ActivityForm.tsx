'use client';

import React, { useState, useEffect, useRef } from 'react';
import { Activity, activityApi } from '@/api/activity-api';
import { authApi, tokenStorage } from '@/api/auth-api';
import { semesterApi, Semester } from '@/api/semester-api';
import { criteriaApi, Criterion } from '@/api/criteria-api';
import { toast } from 'sonner';
import { Save, X, Settings2, Sparkles, Calendar } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/Input';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { CustomCalendar } from '@/components/calendar/CustomCalendar';

interface ActivityFormProps {
  initialData?: Partial<Activity>;
  onSubmit: (data: any) => void;
  onCancel: () => void;
  saving?: boolean;
  mode?: 'create' | 'edit';
}

export default function ActivityForm({ initialData, onSubmit, onCancel, saving = false, mode = initialData ? 'edit' : 'create' }: ActivityFormProps) {
  const isCreateMode = mode === 'create';
  const [formData, setFormData] = useState({
    name: initialData?.name || '',
    code: initialData?.code || '',
    activity_type: initialData?.activity_type || 'club',
    participation_status: initialData?.participation_status || 'published',
    classroom: initialData?.classroom || '',
    description: initialData?.description || '',
    category: initialData?.category || 'other',
    advisor_id: typeof initialData?.advisor_id === 'object' ? initialData.advisor_id?._id : initialData?.advisor_id || '',
    max_members: initialData?.max_members || '',
    founded_date: initialData?.founded_date ? new Date(initialData.founded_date).toISOString().split('T')[0] : '',
    activity_start_date: initialData?.activity_start_date ? new Date(initialData.activity_start_date).toISOString().split('T')[0] : '',
    activity_end_date: initialData?.activity_end_date ? new Date(initialData.activity_end_date).toISOString().split('T')[0] : '',
    semester_id: typeof initialData?.semester_id === 'object' ? initialData.semester_id?._id : initialData?.semester_id || '',
    logo_url: initialData?.logo_url || '',
    cover_url: initialData?.cover_url || '',
    settings: {
      require_registration_for_attendance: initialData?.settings?.require_registration_for_attendance ?? true,
      allow_self_registration: initialData?.settings?.allow_self_registration ?? true,
      require_approval: initialData?.settings?.require_approval ?? true,
      attendance_point_enabled: initialData?.settings?.attendance_point_enabled ?? false,
      point_per_attendance: initialData?.settings?.point_per_attendance || 0,
      criterion_id: initialData?.settings?.criterion_id || '',
    }
  });

  const [teachers, setTeachers] = useState<any[]>([]);
  const [activeSemester, setActiveSemester] = useState<Semester | null>(null);
  const [criteria, setCriteria] = useState<Criterion[]>([]);
  const [loadingOptions, setLoadingOptions] = useState(true);
  const [isCalendarOpen, setIsCalendarOpen] = useState(false);
  const [logoFile, setLogoFile] = useState<File | null>(null);
  const [coverFile, setCoverFile] = useState<File | null>(null);
  const [submitError, setSubmitError] = useState('');
  const [uploading, setUploading] = useState(false);
  const [logoPreviewUrl, setLogoPreviewUrl] = useState('');
  const [coverPreviewUrl, setCoverPreviewUrl] = useState('');
  const logoInputRef = useRef<HTMLInputElement>(null);
  const coverInputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (!logoFile) {
      setLogoPreviewUrl('');
      return;
    }

    const objectUrl = URL.createObjectURL(logoFile);
    setLogoPreviewUrl(objectUrl);
    return () => URL.revokeObjectURL(objectUrl);
  }, [logoFile]);

  useEffect(() => {
    if (!coverFile) {
      setCoverPreviewUrl('');
      return;
    }

    const objectUrl = URL.createObjectURL(coverFile);
    setCoverPreviewUrl(objectUrl);
    return () => URL.revokeObjectURL(objectUrl);
  }, [coverFile]);

  const getDateLabel = () => {
    if (formData.activity_start_date && formData.activity_end_date) {
      const start = new Date(formData.activity_start_date);
      const end = new Date(formData.activity_end_date);
      return `${start.getDate().toString().padStart(2, '0')}/${(start.getMonth() + 1).toString().padStart(2, '0')}/${start.getFullYear()} - ${end.getDate().toString().padStart(2, '0')}/${(end.getMonth() + 1).toString().padStart(2, '0')}/${end.getFullYear()}`;
    }
    if (formData.activity_start_date) {
      const start = new Date(formData.activity_start_date);
      return `Từ ${start.getDate().toString().padStart(2, '0')}/${(start.getMonth() + 1).toString().padStart(2, '0')}/${start.getFullYear()}`;
    }
    return 'Chọn khoảng thời gian diễn ra';
  };

  useEffect(() => {
    async function loadOptions() {
      setLoadingOptions(true);
      try {
        const token = tokenStorage.getAccessToken() || '';
        const [usersData, semestersData, criteriaData] = await Promise.all([
          authApi.getUsers(token).catch(() => []),
          semesterApi.getSemesters().catch(() => []),
          criteriaApi.getCriteria().catch(() => []),
        ]);

        const filteredTeachers = usersData.filter((u: any) => u.role?.role_code === 'TEACHER' || u.role_code === 'TEACHER');
        setTeachers(filteredTeachers);
        
        const currentActiveSemester = semestersData.find((semester) => semester.status === 'active') || null;
        setActiveSemester(currentActiveSemester);
        if (currentActiveSemester) setFormData(prev => ({ ...prev, semester_id: currentActiveSemester._id }));
        setCriteria(criteriaData);
      } catch (err) {
        console.error('Failed to load form options:', err);
        toast.error('Lỗi khi tải danh sách tùy chọn');
      } finally {
        setLoadingOptions(false);
      }
    }
    loadOptions();
  }, []);

  const handleChange = (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement>) => {
    const { name, value } = e.target;
    if (name.startsWith('settings.')) {
      const field = name.split('.')[1];
      setFormData(prev => ({
        ...prev,
        settings: {
          ...prev.settings,
          [field]: value
        }
      }));
    } else {
      setFormData(prev => ({
        ...prev,
        [name]: value
      }));
    }
  };

  const handleCheckboxChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const { name, checked } = e.target;
    if (name.startsWith('settings.')) {
      const field = name.split('.')[1];
      setFormData(prev => ({
        ...prev,
        settings: {
          ...prev.settings,
          [field]: checked
        }
      }));
    }
  };

  const handleFileChange = (kind: 'logo' | 'cover') => (event: React.ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0] || null;
    if (!file) return;
    if (!['image/png', 'image/jpeg', 'image/webp'].includes(file.type) || file.size > 5 * 1024 * 1024) {
      setSubmitError('Tệp ảnh phải là PNG, JPEG hoặc WebP và không vượt quá 5 MB.');
      event.target.value = '';
      return;
    }
    setSubmitError('');
    (kind === 'logo' ? setLogoFile : setCoverFile)(file);
  };

  const clearSelectedMedia = (kind: 'logo' | 'cover') => {
    if (kind === 'logo') {
      setLogoFile(null);
      if (logoInputRef.current) logoInputRef.current.value = '';
    } else {
      setCoverFile(null);
      if (coverInputRef.current) coverInputRef.current.value = '';
    }
    setSubmitError('');
  };

  const handleFormSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (saving || uploading) return;
    setSubmitError('');
    if (!formData.name || !formData.code || !formData.classroom) {
      toast.error('Vui lòng điền đầy đủ các trường bắt buộc');
      return;
    }

    if (!formData.semester_id) {
      setSubmitError('Không tìm thấy học kỳ đang hoạt động. Vui lòng thử lại sau.');
      return;
    }
    setUploading(true);
    const mediaUrls = { logo_url: formData.logo_url, cover_url: formData.cover_url };
    try {
      if (isCreateMode && logoFile) mediaUrls.logo_url = (await activityApi.uploadMedia(logoFile, 'logo')).url;
      if (isCreateMode && coverFile) mediaUrls.cover_url = (await activityApi.uploadMedia(coverFile, 'cover')).url;
    } catch (error) {
      console.error('Failed to upload activity media:', error);
      setSubmitError('Không thể tải ảnh lên. Vui lòng kiểm tra tệp và thử lại.');
      setUploading(false);
      return;
    }
    // Prepare payload
    const payload = {
      ...formData,
      ...mediaUrls,
      participation_status: isCreateMode ? 'published' : formData.participation_status,
      category: formData.activity_type === 'club' ? formData.category : 'other',
      max_members: formData.max_members ? Number(formData.max_members) : undefined,
      founded_date: formData.founded_date ? new Date(formData.founded_date) : undefined,
      activity_start_date: formData.activity_start_date ? new Date(formData.activity_start_date) : undefined,
      activity_end_date: formData.activity_end_date ? new Date(formData.activity_end_date) : undefined,
      semester_id: formData.semester_id || undefined,
      settings: {
        ...formData.settings,
        point_per_attendance: Number(formData.settings.point_per_attendance),
        criterion_id: formData.settings.criterion_id || undefined,
      }
    };

    const normalizedPayload: any = { ...payload };
    if (!formData.advisor_id || formData.advisor_id === '__DEFAULT_ADMIN__') {
      if (isCreateMode) {
        delete normalizedPayload.advisor_id;
      } else {
        normalizedPayload.advisor_id = null;
      }
    }
    onSubmit(normalizedPayload);
    setUploading(false);
  };

  return (
    <form onSubmit={handleFormSubmit} className="space-y-4 max-h-[80vh] overflow-y-auto px-1 pr-2 custom-scrollbar">
      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
        
        {/* Left column: Basic Information */}
        <div className="space-y-3.5 bg-white/45 backdrop-blur-md border border-white/70 p-5 rounded-2xl shadow-sm shadow-slate-300/40">
          <div className="flex items-center gap-2 border-b border-white/50 pb-2.5 mb-1">
            <Sparkles className="text-[#1A73E8]" size={16} />
            <h3 className="text-[12.5px] font-black text-[#1E293B] uppercase tracking-wider">Thông tin chung</h3>
          </div>

          <div className="space-y-3">
            <div className="p-2 rounded-xl border border-blue-100 bg-blue-50/40">
              <div className="text-[12px] font-bold text-[#1E293B]">Cách điểm danh</div>
              <div className="text-[10px] text-[#64748B] font-semibold mb-2">Chọn một trong hai hình thức áp dụng cho hoạt động</div>
              <label className="flex items-center gap-2 text-[11px] font-semibold">
                <input type="radio" name="settings.require_registration_for_attendance" value="true" checked={formData.settings.require_registration_for_attendance} onChange={() => setFormData(prev => ({ ...prev, settings: { ...prev.settings, require_registration_for_attendance: true } }))} />
                Yêu cầu đăng ký trước khi điểm danh
              </label>
              <label className="flex items-center gap-2 text-[11px] font-semibold mt-1">
                <input type="radio" name="settings.require_registration_for_attendance" value="false" checked={!formData.settings.require_registration_for_attendance} onChange={() => setFormData(prev => ({ ...prev, settings: { ...prev.settings, require_registration_for_attendance: false } }))} />
                Không cần đăng ký, vào hoạt động để điểm danh
              </label>
            </div>
            <Input
              label="Tên hoạt động"
              required={!isCreateMode}
              type="text"
              name="name"
              value={formData.name}
              onChange={handleChange}
              placeholder="Ví dụ: Câu lạc bộ IT, Festival Công Nghệ..."
            />

            <div className="grid grid-cols-2 gap-3">
              <Input
                label="Mã hoạt động"
                required
                type="text"
                name="code"
                value={formData.code}
                onChange={handleChange}
                placeholder="Ví dụ: CLB_IT"
                className="uppercase"
              />

              <Select
                value={formData.activity_type}
                onValueChange={(val: any) => setFormData(prev => ({
                  ...prev,
                  activity_type: val,
                  category: val === 'club' ? prev.category : 'other',
                }))}
                label="Thể loại"
              >
                <SelectTrigger className="h-10">
                  <SelectValue placeholder="Chọn thể loại..." />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="club">Câu lạc bộ (Club)</SelectItem>
                  <SelectItem value="event">Sự kiện (Event)</SelectItem>
                  <SelectItem value="activity">Hoạt động (Activity)</SelectItem>
                  <SelectItem value="festival">Lễ hội (Festival)</SelectItem>
                </SelectContent>
              </Select>
            </div>

            <div className="grid grid-cols-2 gap-3">
              {formData.activity_type === 'club' && (
              <Select
                value={formData.category}
                onValueChange={(val: any) => setFormData(prev => ({ ...prev, category: val }))}
                label="Phân loại"
              >
                <SelectTrigger className="h-10">
                  <SelectValue placeholder="Chọn phân loại..." />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="academic">Học thuật</SelectItem>
                  <SelectItem value="sports">Thể thao</SelectItem>
                  <SelectItem value="art">Nghệ thuật</SelectItem>
                  <SelectItem value="volunteer">Tình nguyện</SelectItem>
                  <SelectItem value="technology">Công nghệ</SelectItem>
                  <SelectItem value="other">Khác</SelectItem>
                </SelectContent>
              </Select>
              )}

              {!isCreateMode && <Select
                value={formData.participation_status}
                onValueChange={(val: any) => setFormData(prev => ({ ...prev, participation_status: val }))}
                label="Trạng thái"
              >
                <SelectTrigger className="h-10">
                  <SelectValue placeholder="Chọn trạng thái..." />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="draft">Bản nháp (Draft)</SelectItem>
                  <SelectItem value="published">Đang hoạt động (Published)</SelectItem>
                  <SelectItem value="completed">Đã kết thúc (Completed)</SelectItem>
                  <SelectItem value="cancelled">Đã hủy (Cancelled)</SelectItem>
                </SelectContent>
              </Select>}
            </div>

            <div className="grid grid-cols-2 gap-3">
              <Input
                label="Phòng sinh hoạt"
                required
                type="text"
                name="classroom"
                value={formData.classroom}
                onChange={handleChange}
                placeholder="Ví dụ: Phòng A.102"
              />

              <Input
                label="Thành viên tối đa"
                type="number"
                name="max_members"
                value={formData.max_members}
                onChange={handleChange}
                placeholder="Không giới hạn"
              />
            </div>

            <Input
              label="Mô tả chi tiết"
              multiline
              rows={3}
              name="description"
              value={formData.description}
              onChange={handleChange}
              placeholder="Mô tả về mục tiêu và nội dung hoạt động..."
            />
          </div>
        </div>

        {/* Right column: Advisors & Operations */}
        <div className="space-y-3.5 bg-white/45 backdrop-blur-md border border-white/70 p-5 rounded-2xl shadow-sm shadow-slate-300/40">
          <div className="flex items-center gap-2 border-b border-white/50 pb-2.5 mb-1">
            <Settings2 className="text-[#1A73E8]" size={16} />
            <h3 className="text-[12.5px] font-black text-[#1E293B] uppercase tracking-wider">Vận hành & Thời gian</h3>
          </div>

          <div className="space-y-3">
            <Select
              value={formData.advisor_id}
              onValueChange={(val: string) => setFormData(prev => ({ ...prev, advisor_id: val }))}
              label="Giáo viên phụ trách"
              required
            >
              <SelectTrigger className="h-10">
                <SelectValue placeholder={isCreateMode ? '-- Mặc định là người tạo --' : '-- Chọn cố vấn --'} />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="__DEFAULT_ADMIN__">Không chọn (mặc định tài khoản admin)</SelectItem>
                {teachers.map(t => (
                  <SelectItem key={t._id} value={t._id}>
                    {t.full_name || t.user_name || t.email}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>

            {/* CustomCalendar + Popover Date Picker */}
            <div className="flex flex-col gap-1.5 w-full">
              <label className="text-[13px] font-bold text-[#1E293B] px-1">
                Thời gian diễn ra
              </label>
              <Popover open={isCalendarOpen} onOpenChange={setIsCalendarOpen}>
                <PopoverTrigger asChild>
                  <button
                    type="button"
                    className="flex items-center justify-between w-full h-10 rounded-xl border border-white/70 bg-white/50 backdrop-blur-sm px-3 py-2 text-sm text-[#1E293B] hover:bg-white/70 transition-all duration-150 ease-out cursor-pointer outline-none focus:ring-2 focus:ring-[#1A73E8]/30 focus:border-[#1A73E8]/50 hover:scale-[1.01]"
                  >
                    <span className="truncate">{getDateLabel()}</span>
                    <Calendar size={15} className="text-[#64748B] shrink-0" />
                  </button>
                </PopoverTrigger>
                <PopoverContent className="w-auto p-0 border-none bg-transparent shadow-none z-[100] overflow-hidden" align="start">
                  <CustomCalendar
                    startDate={formData.activity_start_date ? new Date(formData.activity_start_date) : null}
                    endDate={formData.activity_end_date ? new Date(formData.activity_end_date) : null}
                    onRangeSelect={(start, end) => {
                      setFormData(prev => ({
                        ...prev,
                        activity_start_date: start ? start.toISOString().split('T')[0] : '',
                        activity_end_date: end ? end.toISOString().split('T')[0] : ''
                      }));
                    }}
                    onCancel={() => setIsCalendarOpen(false)}
                    onConfirm={() => setIsCalendarOpen(false)}
                  />
                </PopoverContent>
              </Popover>
            </div>

            {isCreateMode ? (
              <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                <div className="space-y-2">
                  <Input ref={logoInputRef} label="Logo" type="file" accept="image/png,image/jpeg,image/webp" onChange={handleFileChange('logo')} />
                  {logoPreviewUrl && (
                    <div className="relative aspect-square w-full overflow-hidden rounded-xl border border-white/70 bg-slate-50 p-2">
                      <img src={logoPreviewUrl} alt="Logo preview" className="h-full w-full object-contain" />
                      <button type="button" aria-label="Remove selected logo" onClick={() => clearSelectedMedia('logo')} className="absolute right-2 top-2 rounded-full bg-slate-900/75 p-1 text-white shadow-sm transition-colors hover:bg-red-600 focus:outline-none focus:ring-2 focus:ring-red-500/50">
                        <X size={14} />
                      </button>
                    </div>
                  )}
                </div>
                <div className="space-y-2">
                  <Input ref={coverInputRef} label="Ảnh bìa" type="file" accept="image/png,image/jpeg,image/webp" onChange={handleFileChange('cover')} />
                  {coverPreviewUrl && (
                    <div className="relative aspect-[16/9] w-full overflow-hidden rounded-xl border border-white/70 bg-slate-50 p-2">
                      <img src={coverPreviewUrl} alt="Cover image preview" className="h-full w-full object-contain" />
                      <button type="button" aria-label="Remove selected cover image" onClick={() => clearSelectedMedia('cover')} className="absolute right-2 top-2 rounded-full bg-slate-900/75 p-1 text-white shadow-sm transition-colors hover:bg-red-600 focus:outline-none focus:ring-2 focus:ring-red-500/50">
                        <X size={14} />
                      </button>
                    </div>
                  )}
                </div>
              </div>
            ) : <div className="grid grid-cols-2 gap-3">
              <Input
                label="Logo URL"
                type="text"
                name="logo_url"
                value={formData.logo_url}
                onChange={handleChange}
                placeholder="https://..."
              />

              <Input
                label="Cover URL"
                type="text"
                name="cover_url"
                value={formData.cover_url}
                onChange={handleChange}
                placeholder="https://..."
              />
            </div>}
          </div>
        </div>
      </div>

      {/* Advanced Settings Section */}
      {formData.settings.require_registration_for_attendance && <div className="bg-white/45 backdrop-blur-md border border-white/70 p-5 rounded-2xl shadow-sm shadow-slate-300/40 space-y-3.5">
        <div className="flex items-center gap-2 border-b border-white/50 pb-2.5 mb-1">
          <Settings2 className="text-[#1A73E8]" size={16} />
          <h3 className="text-[12.5px] font-black text-[#1E293B] uppercase tracking-wider">Cấu hình nâng cao</h3>
        </div>

        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          <div className="space-y-3">
            <div className="flex items-center justify-between p-2 rounded-xl hover:bg-white/30 border border-transparent hover:border-white/40 transition-all duration-150 ease-out">
              <div>
                <label className="text-[12px] font-bold text-[#1E293B] block">
                  Cho phép tự đăng ký
                </label>
                <span className="text-[10px] text-[#64748B] font-semibold">Sinh viên được tự đăng ký tham gia</span>
              </div>
              <input
                type="checkbox"
                name="settings.allow_self_registration"
                checked={formData.settings.allow_self_registration}
                onChange={handleCheckboxChange}
                className="w-4 h-4 text-[#1A73E8] border-white/70 rounded bg-white/50 focus:ring-[#1A73E8]/30 transition-all cursor-pointer"
              />
            </div>

            <div className="flex items-center justify-between p-2 rounded-xl hover:bg-white/30 border border-transparent hover:border-white/40 transition-all duration-150 ease-out">
              <div>
                <label className="text-[12px] font-bold text-[#1E293B] block">
                  Yêu cầu phê duyệt
                </label>
                <span className="text-[10px] text-[#64748B] font-semibold">Phụ trách phải duyệt đơn đăng ký</span>
              </div>
              <input
                type="checkbox"
                name="settings.require_approval"
                checked={formData.settings.require_approval}
                onChange={handleCheckboxChange}
                className="w-4 h-4 text-[#1A73E8] border-white/70 rounded bg-white/50 focus:ring-[#1A73E8]/30 transition-all cursor-pointer"
              />
            </div>
          </div>

          <div className="space-y-3">
            <div className="flex items-center justify-between p-2 rounded-xl hover:bg-white/30 border border-transparent hover:border-white/40 transition-all duration-150 ease-out">
              <div>
                <label className="text-[12px] font-bold text-[#1E293B] block">
                  Tính điểm rèn luyện khi điểm danh
                </label>
                <span className="text-[10px] text-[#64748B] font-semibold">Điểm danh thành công sẽ được cộng điểm trực tiếp</span>
              </div>
              <input
                type="checkbox"
                name="settings.attendance_point_enabled"
                checked={formData.settings.attendance_point_enabled}
                onChange={handleCheckboxChange}
                className="w-4 h-4 text-[#1A73E8] border-white/70 rounded bg-white/50 focus:ring-[#1A73E8]/30 transition-all cursor-pointer"
              />
            </div>

            {formData.settings.attendance_point_enabled && (
              <div className="grid grid-cols-2 gap-3 animate-in fade-in duration-200">
                <Input
                  label="Điểm cộng mỗi buổi"
                  type="number"
                  name="settings.point_per_attendance"
                  value={formData.settings.point_per_attendance}
                  onChange={handleChange}
                  min="0"
                  step="0.5"
                />

                <Select
                  value={formData.settings.criterion_id}
                  onValueChange={(val: string) => setFormData(prev => ({
                    ...prev,
                    settings: {
                      ...prev.settings,
                      criterion_id: val
                    }
                  }))}
                  label="Tiêu chí áp dụng"
                >
                  <SelectTrigger className="h-10">
                    <SelectValue placeholder="-- Chọn tiêu chí --" />
                  </SelectTrigger>
                  <SelectContent>
                    {criteria.map(c => (
                      <SelectItem key={c._id} value={c._id}>
                        {c.criterion_name} (+{c.max_score}đ max)
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
            )}
          </div>
        </div>
      </div>}

      {/* Form Actions */}
      {submitError && <p role="alert" className="text-sm font-medium text-red-600">{submitError}</p>}
      <div className="flex items-center justify-end gap-3 border-t border-white/50 pt-4 mt-2">
        <Button
          type="button"
          onClick={onCancel}
          className="rounded-xl px-4 py-2 border border-white/70 bg-white/40 text-[#1E293B] hover:bg-white/70 hover:scale-[1.01] hover:shadow-sm transition-all duration-150 ease-out cursor-pointer"
          disabled={saving || uploading}
        >
          <X size={15} className="mr-1.5" />
          Hủy bỏ
        </Button>
        <Button
          type="submit"
          className="rounded-xl px-4 py-2 bg-[#1A73E8] border border-[#1A73E8]/80 text-white font-semibold hover:bg-[#1A73E8]/90 hover:scale-[1.01] hover:shadow-md transition-all duration-150 ease-out cursor-pointer"
          disabled={saving || uploading}
        >
          <Save size={15} className="mr-1.5" />
          {uploading ? 'Đang tải ảnh...' : saving ? 'Đang lưu...' : 'Lưu hoạt động'}
        </Button>
      </div>
    </form>
  );
}
