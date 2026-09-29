export const adminRoutes = {
  threadCreate: { method: 'POST', path: '/admin/rpc/ThreadCreate' },
  threadReconcile: { method: 'POST', path: '/admin/rpc/ThreadReconcile' },
  runtimeStatus: { method: 'POST', path: '/admin/rpc/RuntimeStatus' },
  commandsSync: { method: 'POST', path: '/admin/commands-sync' },
  configGet: { method: 'GET', path: '/admin/config' },
  configPut: { method: 'PUT', path: '/admin/config' },
} as const
