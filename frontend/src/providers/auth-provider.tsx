"use client";
import React, { createContext, useContext, useEffect, useState, useCallback, useRef } from 'react';
import { useRouter, usePathname } from 'next/navigation';
import { tokenStorage, authApi } from '@/api/auth-api';
import { synchronizedRefreshToken } from '@/api/http-client';
import { toast } from 'sonner';
import { isStudentRole, isTeacherRole } from '@/utils/role.util';
import { API_ORIGIN } from '@/api/config';

interface UserInfo {
  id: string;
  user_name?: string;
  username?: string;
  display_name?: string;
  role?: string;
  roleName?: string;
  roleCode?: string;
  roles?: any[];
  roleCodes?: string[];
  permissions?: string[];
  studentId?: string;
  classId?: string;
  impersonation?: {
    id: string;
    expires_at: string;
  };
}

interface AuthContextType {
  user: UserInfo | null;
  isAuthenticated: boolean;
  isLoading: boolean;
  permissions: string[];
  logout: () => void;
  checkAuth: () => void;
  hasPermission: (permission: string) => boolean;
  hasAnyPermission: (...permissions: string[]) => boolean;
  hasAllPermissions: (...permissions: string[]) => boolean;
  forceLogoutAfterRestore: (reason?: string) => Promise<void>;
}

const AuthContext = createContext<AuthContextType | undefined>(undefined);


export function AuthProvider({ children }: { children: React.ReactNode }) {
  const [user, setUser] = useState<UserInfo | null>(null);
  const [permissions, setPermissions] = useState<string[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [recoveryError, setRecoveryError] = useState(false);
  const router = useRouter();
  const pathname = usePathname();
  const currentPath = useRef(pathname); currentPath.current = pathname;
  const previousPath = useRef<string | null>(null);
  const pending = useRef<{ identity: string; promise: Promise<void> } | null>(null);
  const generation = useRef(0);
  const isPublicRoute = ['/login', '/register', '/forgot-password', '/reset-password', '/access'].includes(pathname) || pathname.startsWith('/public');

  const clearState = useCallback(() => {
    generation.current++;
    tokenStorage.clearLocalAuth();
    setUser(null); setPermissions([]); setRecoveryError(false); setIsLoading(false);
  }, []);

  const checkAuth = useCallback(() => {
    if (currentPath.current === '/access') {
      setIsLoading(false); return Promise.resolve();
    }
    if (tokenStorage.isLoggedOut()) { clearState(); return Promise.resolve(); }
    const identity = tokenStorage.getAuthIdentity();
    if (pending.current?.identity === identity) return pending.current.promise;
    const version = generation.current;
    const active = () => version === generation.current && identity === tokenStorage.getAuthIdentity();
    const promise = (async () => {
      const cached = tokenStorage.getUser();
      if (cached && active()) { setUser(cached); setPermissions(cached.permissions || []); }
      try {
        let token = tokenStorage.getAccessToken();
        if (!token) token = (await synchronizedRefreshToken()).access_token;
        if (!active()) return;
        let response = await fetch(API_ORIGIN + '/api/auth/me', {
          headers: { Authorization: 'Bearer ' + token }, signal: AbortSignal.timeout(10000),
        });
        if (!active()) return;
        if (response.status === 401) {
          token = (await synchronizedRefreshToken()).access_token;
          if (!active()) return;
          response = await fetch(API_ORIGIN + '/api/auth/me', {
            headers: { Authorization: 'Bearer ' + token }, signal: AbortSignal.timeout(10000),
          });
        }
        if (!response.ok) throw Object.assign(new Error('Không thể xác minh phiên'), { status: response.status });
        const data = await response.json();
        if (!active()) return;
        const serverRole = typeof data.role === 'string' ? data.role : data.role?.name;
        const next: UserInfo = { ...data, id: data.id,
          username: data.username || data.user_name, role: data.roleName || serverRole,
          roleName: data.roleName || serverRole, roleCode: data.roleCode || data.role?.role_code,
          permissions: data.permissions || [], impersonation: data.impersonation || cached?.impersonation };
        if (isStudentRole(next)) {
          let studentResponse = await fetch(API_ORIGIN + '/api/students/me', {
            headers: { Authorization: 'Bearer ' + token }, signal: AbortSignal.timeout(10000),
          });
          if (studentResponse.status === 401) {
            token = (await synchronizedRefreshToken()).access_token;
            if (!active()) return;
            studentResponse = await fetch(API_ORIGIN + '/api/students/me', {
              headers: { Authorization: 'Bearer ' + token }, signal: AbortSignal.timeout(10000),
            });
          }
          if (!studentResponse.ok) throw Object.assign(new Error('Không thể tải hồ sơ'), { status: studentResponse.status });
          const student = await studentResponse.json();
          next.studentId = student._id; next.classId = typeof student.class_id === 'object' ? student.class_id?._id : student.class_id;
        }
        if (!active()) return;
        tokenStorage.setAccessToken(token!); tokenStorage.setUser(next);
        setUser(next); setPermissions(next.permissions || []); setRecoveryError(false);
      } catch (error: any) {
        if (!active()) return;
        if (error?.status === 401) { tokenStorage.clearTokens(); clearState(); }
        else if (error?.name !== 'AbortError') setRecoveryError(true);
      } finally {
        if (active()) setIsLoading(false);
      }
    })();
    pending.current = { identity, promise };
    void promise.finally(() => { if (pending.current?.promise === promise) pending.current = null; });
    return promise;
  }, [clearState]);

  useEffect(() => {
    const previous = previousPath.current; previousPath.current = pathname;
    if (previous === null || previous === '/access') void checkAuth();
  }, [pathname, checkAuth]);
  useEffect(() => {
    const refresh = () => { void checkAuth(); };
    const storage = (event: StorageEvent) => {
      if (event.key === 'auth_restore_epoch') { tokenStorage.clearTokens(); clearState(); return; }
      if (sessionStorage.getItem('auth_child') === 'true') return;
      if (event.key?.startsWith('auth_epoch_') || event.key === 'auth_session_id') {
        clearState(); void checkAuth();
      }
    };
    window.addEventListener('storage', storage);
    window.addEventListener('online', refresh);
    window.addEventListener('focus', refresh);
    window.addEventListener('authorization-denied', refresh);
    window.addEventListener('auth-session-ended', clearState);
    const timer = setInterval(refresh, 5 * 60 * 1000);
    return () => {
      clearInterval(timer);
      window.removeEventListener('storage', storage);
      window.removeEventListener('online', refresh);
      window.removeEventListener('focus', refresh);
      window.removeEventListener('authorization-denied', refresh);
      window.removeEventListener('auth-session-ended', clearState);
    };
  }, [checkAuth, clearState]);

  useEffect(() => {
    if (isLoading || recoveryError || pathname === '/access') return;
    if (!user && !isPublicRoute) router.push('/login');
    else if (user && isPublicRoute) router.push(isStudentRole(user) || isTeacherRole(user) ? '/students/tasks' : '/');
  }, [user, isLoading, recoveryError, pathname, isPublicRoute, router]);

  const logout = useCallback(async () => {
    const id = tokenStorage.getSessionId();
    tokenStorage.clearTokens(); clearState(); router.push('/login');
    try { await authApi.logout(id); toast.success('Đã đăng xuất thành công'); }
    catch { toast.error('Đã khóa phiên trên trình duyệt. Chưa thể xác nhận đăng xuất với máy chủ.'); }
  }, [clearState, router]);
  const forceLogoutAfterRestore = useCallback(async () => {
    localStorage.setItem('auth_restore_epoch', String(Date.now()));
    await logout();
  }, [logout]);
  const hasPermission = useCallback((p: string) => isAdminUser(user) || permissions.includes(p), [user, permissions]);
  const hasAnyPermission = useCallback((...ps: string[]) => isAdminUser(user) || ps.some(p => permissions.includes(p)), [user, permissions]);
  const hasAllPermissions = useCallback((...ps: string[]) => isAdminUser(user) || ps.every(p => permissions.includes(p)), [user, permissions]);
  return <AuthContext.Provider value={{ user, isAuthenticated: !!user, isLoading, permissions, logout, checkAuth,
    hasPermission, hasAnyPermission, hasAllPermissions, forceLogoutAfterRestore }}>
    {isLoading ? <div role="status" className="flex min-h-screen items-center justify-center">Đang kiểm tra phiên đăng nhập...</div> : <>
      {recoveryError && <div role="alert" className="bg-amber-50 p-3 text-center text-amber-900">
        Chưa thể xác minh phiên đăng nhập. Kiểm tra kết nối và thử lại.
        <button className="ml-3 underline" onClick={() => void checkAuth()}>Thử lại</button>
      </div>}
      {(!recoveryError || user || isPublicRoute) && children}
    </>}
  </AuthContext.Provider>;
}

export function useAuth() {
  const context = useContext(AuthContext);
  if (context === undefined) {
    throw new Error("useAuth must be used within an AuthProvider");
  }
  return context;
}

export function isAdminUser(user: UserInfo | null): boolean {
  if (!user) return false;
  return (
    user.roleCode === "ADMIN" ||
    user.role === "Admin" ||
    user.roleName === "Admin" ||
    user.roleCodes?.includes("ADMIN") === true ||
    user.permissions?.includes("ADMIN_FULL") === true ||
    user.permissions?.includes("admin") === true
  );
}
