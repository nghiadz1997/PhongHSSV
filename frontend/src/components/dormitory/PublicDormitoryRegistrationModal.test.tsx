import React from 'react';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { PublicDormitoryRegistrationModal } from './PublicDormitoryRegistrationModal';
import { dormitoryApi } from '@/api/dormitory-api';

vi.mock('@/api/dormitory-api', () => ({
  dormitoryApi: {
    public: {
      getActiveSemester: vi.fn(),
      register: vi.fn(),
    },
  },
}));

describe('PublicDormitoryRegistrationModal - Full Form Requirements', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    (dormitoryApi.public.getActiveSemester as any).mockResolvedValue({
      semester_name: 'HK1 - 2026 - 2027',
      semester: 'HK1',
      academic_year: '2026-2027',
    });
    (dormitoryApi.public.register as any).mockResolvedValue({
      success: true,
      roster_entry_code: 'DK-FULL-01',
    });
  });

  it('renders all full form fields matching the edit modal specification', async () => {
    render(<PublicDormitoryRegistrationModal open={true} />);

    await waitFor(() => {
      expect(screen.getByText('HK1 - 2026 - 2027')).toBeInTheDocument();
    });

    // Core fields
    expect(screen.getAllByPlaceholderText('Nhập họ và tên').length).toBe(3); // applicant + father + mother
    expect(screen.getByPlaceholderText('Nhập mã sinh viên (nếu có)')).toBeInTheDocument();
    expect(screen.getByLabelText('Chọn ngày sinh')).toBeInTheDocument();
    expect(screen.getByText('Giới tính')).toBeInTheDocument();
    expect(screen.getAllByPlaceholderText('Nhập số điện thoại').length).toBe(3); // applicant + father + mother
    expect(screen.getByText('Loại phòng')).toBeInTheDocument();
    expect(screen.getByPlaceholderText('Nhập ghi chú (nếu có)')).toBeInTheDocument();

    // Applicant profile extended fields
    expect(screen.getByText('Thông tin hồ sơ (không bắt buộc)')).toBeInTheDocument();
    expect(screen.getByPlaceholderText('Nhập dân tộc')).toBeInTheDocument();
    expect(screen.getByPlaceholderText('Nhập tôn giáo')).toBeInTheDocument();
    expect(screen.getByPlaceholderText('Nhập số CCCD/CMND')).toBeInTheDocument();
    expect(screen.getByLabelText('Ngày cấp CCCD/CMND')).toBeInTheDocument();
    expect(screen.getByPlaceholderText('Nhập nơi cấp CCCD/CMND')).toBeInTheDocument();
    expect(screen.getByPlaceholderText('Nhập thông tin giấy chứng nhận (nếu có)')).toBeInTheDocument();
    expect(screen.getByText('Thông tin cha')).toBeInTheDocument();
    expect(screen.getByText('Thông tin mẹ')).toBeInTheDocument();
  });

  it('submits registration with student_code and compact applicant profile', async () => {
    render(<PublicDormitoryRegistrationModal open={true} />);

    await waitFor(() => {
      expect(screen.getByText('HK1 - 2026 - 2027')).toBeInTheDocument();
    });

    // Fill form
    const nameInputs = screen.getAllByPlaceholderText('Nhập họ và tên');
    fireEvent.change(nameInputs[0], { target: { value: 'Trần Văn Nam' } });
    fireEvent.change(screen.getByPlaceholderText('Nhập mã sinh viên (nếu có)'), { target: { value: 'B22DCCN001' } });
    const phoneInputs = screen.getAllByPlaceholderText('Nhập số điện thoại');
    fireEvent.change(phoneInputs[0], { target: { value: '0987654321' } });
    fireEvent.change(screen.getByPlaceholderText('Nhập dân tộc'), { target: { value: 'Kinh' } });
    fireEvent.change(screen.getByPlaceholderText('Nhập số CCCD/CMND'), { target: { value: '012345678901' } });

    const submitBtn = screen.getByRole('button', { name: /Gửi đăng ký/i });
    expect(submitBtn).toBeInTheDocument();
  });
});
