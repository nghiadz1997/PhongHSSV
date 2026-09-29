'use client';

import React, { useEffect, useState } from 'react';
import { useRouter, usePathname } from 'next/navigation';
import { useAuth, isAdminUser } from '@/providers/auth-provider';
import { authApi } from '@/api/auth-api';
import { systemApi } from '@/api/system-api';
import { toast } from 'sonner';
import { Settings } from 'lucide-react';
import { 
  getModuleIdByPath, 
  subscribeModuleMaintenanceUpdates,
  getMaintenanceStatesWithCache
} from '@/utils/module-maintenance.util';

interface RouteGuardProps {
  /** Permission code required to access this route (e.g. 'view_users', 'STUDENT_READ') */
  requiredPermission?: string;
  /** Multiple permission codes — user must have ALL to access */
  requiredPermissions?: string[];
  /** Multiple permission codes — user must have at least ONE to access */
  anyPermission?: string[];
  /** Redirect path when permission denied. Default: previous page or /select-module */
  fallbackPath?: string;
  /** Custom forbidden message */
  forbiddenMessage?: string;
  /** If true, also check dynamic route-permission mappings from DB */
  useDynamicMapping?: boolean;
  /** If true, fail closed when DB mapping API fails */
  failClosed?: boolean;
  children: React.ReactNode;
}

// Cache route-permission mappings to avoid repeated API calls
let cachedMappings: any[] | null = null;
let cacheTimestamp = 0;
const CACHE_TTL = 60_000; // 60 seconds

async function fetchRouteMappings(token?: string): Promise<any[]> {
  const now = Date.now();
  if (cachedMappings && (now - cacheTimestamp) < CACHE_TTL) {
    return cachedMappings;
  }
  try {
    const data = await authApi.getRoutePermissionsPublic(token);
    cachedMappings = data;
    cacheTimestamp = now;
    return data;
  } catch {
    return cachedMappings || [];
  }
}

/**
 * RouteGuard — Frontend Route Guard component for permission-based access control.
 * 
 * Supports TWO modes:
 * 1. Static mode: pass requiredPermission/requiredPermissions/anyPermission as props
 * 2. Dynamic mode: set useDynamicMapping={true} to auto-read from DB mappings (managed via Admin UI)
 * 
 * Usage (Static):
 *   <RouteGuard requiredPermission="view_users">
 *     <PermissionsPage />
 *   </RouteGuard>
 * 
 * Usage (Dynamic — reads from Admin-configured DB):
 *   <RouteGuard useDynamicMapping>
 *     <StudentsPage />
 *   </RouteGuard>
 */
export function RouteGuard({
  requiredPermission,
  requiredPermissions,
  anyPermission,
  fallbackPath,
  forbiddenMessage = 'Bạn không có quyền truy cập trang này',
  useDynamicMapping = false,
  failClosed = false,
  children,
}: RouteGuardProps) {
  const { user, isLoading, hasPermission, hasAnyPermission, hasAllPermissions } = useAuth();
  const router = useRouter();
  const pathname = usePathname();
  const [dynamicCheckDone, setDynamicCheckDone] = useState(!useDynamicMapping);
  const [dynamicAllowed, setDynamicAllowed] = useState(true);
  const [isUnderMaintenance, setIsUnderMaintenance] = useState(false);
  const [maintenanceCheckDone, setMaintenanceCheckDone] = useState(false);
  const [refreshTrigger, setRefreshTrigger] = useState(0);

  // Invalidate cache and trigger reload on update event
  useEffect(() => {
    const handleUpdate = () => {
      invalidateRoutePermissionCache();
      setRefreshTrigger((prev) => prev + 1);
    };
    if (typeof window !== 'undefined') {
      window.addEventListener('route-permissions-updated', handleUpdate);
      return () => window.removeEventListener('route-permissions-updated', handleUpdate);
    }
  }, []);

  // Maintenance mode check
  useEffect(() => {
    if (typeof window === 'undefined') return;

    let cancelled = false;

    if (isLoading) {
      setMaintenanceCheckDone(false);
      return;
    }

    if (!user || isAdminUser(user)) {
      setIsUnderMaintenance(false);
      setMaintenanceCheckDone(true);
      return;
    }

    const moduleId = getModuleIdByPath(pathname);
    if (!moduleId) {
      setIsUnderMaintenance(false);
      setMaintenanceCheckDone(true);
      return;
    }

    const applyStates = (states: Record<string, boolean>) => {
      if (cancelled) return;
      setIsUnderMaintenance(states[moduleId] === true);
      setMaintenanceCheckDone(true);
    };

    const checkMaintenance = async () => {
      try {
        const states = await getMaintenanceStatesWithCache();
        applyStates(states);
      } catch (error) {
        console.error('Failed to load module maintenance states:', error);
        if (!cancelled) {
          setIsUnderMaintenance(false);
          setMaintenanceCheckDone(true);
        }
      }
    };

    checkMaintenance();

    const unsubscribe = subscribeModuleMaintenanceUpdates(applyStates);
    const handleFocus = () => checkMaintenance();
    window.addEventListener('focus', handleFocus);
    const intervalId = window.setInterval(checkMaintenance, 30000);

    return () => {
      cancelled = true;
      unsubscribe();
      window.removeEventListener('focus', handleFocus);
      window.clearInterval(intervalId);
    };
  }, [pathname, user, isLoading]);

  // Dynamic mapping check
  useEffect(() => {
    if (!useDynamicMapping || !user || isLoading) return;

    (async () => {
      if (isAdminUser(user)) {
        setDynamicAllowed(true);
        setDynamicCheckDone(true);
        return;
      }

      const isSensitive =
        pathname === '/system' ||
        pathname.startsWith('/system/') ||
        pathname === '/permissions' ||
        pathname.startsWith('/permissions/');
      try {
        const { tokenStorage } = await import('@/api/auth-api');
        const token = tokenStorage.getAccessToken() || '';
        const mappings = await fetchRouteMappings(token);
        const match = mappings.find(
          (m: any) => m.route_path === pathname && m.is_active !== false
        );

        if (!match || !match.permissions || match.permissions.length === 0) {
          if (failClosed || isSensitive) {
            setDynamicAllowed(false);
          } else {
            setDynamicAllowed(true);
          }
          setDynamicCheckDone(true);
          return;
        }

        const requiredCodes = match.permissions.map((p: any) => p.code || p);

        if (isAdminUser(user)) {
          setDynamicAllowed(true);
        } else if (match.check_type === 'any') {
          setDynamicAllowed(hasAnyPermission(...requiredCodes));
        } else {
          setDynamicAllowed(hasAllPermissions(...requiredCodes));
        }
      } catch (err) {
        if (failClosed || isSensitive) {
          setDynamicAllowed(false); // Fail closed
        } else {
          setDynamicAllowed(true); // Fail open
        }
      } finally {
        setDynamicCheckDone(true);
      }
    })();
  }, [useDynamicMapping, user, isLoading, pathname, failClosed, refreshTrigger]);

  // Compute static permission check (no hooks, just logic)
  let isStaticAllowed = true;
  if (user) {
    if (requiredPermission) {
      isStaticAllowed = hasPermission(requiredPermission);
    } else if (requiredPermissions && requiredPermissions.length > 0) {
      isStaticAllowed = hasAllPermissions(...requiredPermissions);
    } else if (anyPermission && anyPermission.length > 0) {
      isStaticAllowed = hasAnyPermission(...anyPermission);
    }
  }

  // Check if this path is a student self-profile detail route
  const isStudentSelfProfileRoute = () => {
    if (!user || !user.studentId) return false;
    const parts = pathname.split('/');
    if (parts.length === 4 && parts[1] === 'students') {
      const routeStudentId = parts[3];
      return routeStudentId === user.studentId;
    }
    return false;
  };

  // Final decision
  const isAllowed = (isStaticAllowed && dynamicAllowed) || isStudentSelfProfileRoute();

  // Redirect effect — MUST be declared before any early returns
  useEffect(() => {
    if (!isLoading && dynamicCheckDone && maintenanceCheckDone && !isAllowed && user && !isUnderMaintenance) {
      toast.error(forbiddenMessage, {
        id: 'permission-denied-toast',
        description: 'Liên hệ quản trị viên để được cấp quyền truy cập.',
        duration: 3000,
      });
      router.replace(fallbackPath || '/');
    }
  }, [isAllowed, isLoading, dynamicCheckDone, maintenanceCheckDone, user, isUnderMaintenance]);

  // --- All hooks above, early returns below ---

  if (isLoading || !dynamicCheckDone || !maintenanceCheckDone) {
    return (
      <div className="flex h-full w-full items-center justify-center p-8">
        <div className="h-8 w-8 animate-spin rounded-full border-3 border-blue-600 border-t-transparent"></div>
      </div>
    );
  }

  if (isUnderMaintenance) {
    return (
      <div className="flex flex-col items-center justify-center min-h-[70vh] p-6 text-center select-none animate-in fade-in duration-300">
        <div className="relative flex items-center justify-center mb-6">
          <div className="absolute inset-0 rounded-full bg-red-500/10 blur-xl w-20 h-20 animate-pulse"></div>
          <div className="w-16 h-16 rounded-2xl bg-red-50 border border-red-100 flex items-center justify-center text-red-500 shadow-sm relative z-10 animate-spin" style={{ animationDuration: '6s' }}>
            <Settings size={28} />
          </div>
        </div>
        
        <h3 className="text-xl font-bold text-slate-800 leading-tight">Phân hệ đang bảo trì</h3>
        <p className="text-sm text-slate-400 font-medium mt-2 max-w-sm">
          Hệ thống đang tiến hành nâng cấp kỹ thuật cho phân hệ này. Vui lòng quay lại sau ít phút.
        </p>

        <button
          onClick={() => router.replace('/')}
          className="mt-6 px-5 py-2 text-xs font-bold text-white bg-slate-800 hover:bg-slate-700 active:scale-95 rounded-xl transition-all shadow-sm cursor-pointer"
        >
          Quay lại Trang chủ
        </button>
      </div>
    );
  }

  if (!user) return null; // AuthProvider handles redirect to /login

  if (!isAllowed) {
    return null; // Ẩn hoàn toàn — không hiển thị gì
  }

  return <>{children}</>;
}

/**
 * usePermission — Hook for checking permissions inside components.
 * 
 * Usage:
 *   const { canView, canCreate, canDelete } = usePermission({
 *     view: 'STUDENT_READ',
 *     create: 'STUDENT_CREATE',
 *     delete: 'delete_course',
 *   });
 * 
 *   {canCreate && <Button>Thêm mới</Button>}
 */
export function usePermission(permissionMap: Record<string, string>) {
  const { hasPermission } = useAuth();
  
  const result: Record<string, boolean> = {};
  for (const [key, code] of Object.entries(permissionMap)) {
    result[key] = hasPermission(code);
  }
  return result;
}

/**
 * Utility to invalidate cached route-permission mappings.
 * Call this after admin creates/updates/deletes a route mapping.
 */
export function invalidateRoutePermissionCache() {
  cachedMappings = null;
  cacheTimestamp = 0;
}
