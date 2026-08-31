const allowedHttpRoutes = [
  { methods: ['GET'], pattern: /^\/system_stats$/ },
  { methods: ['GET'], pattern: /^\/object_info(?:\/.*)?$/ },
  { methods: ['GET', 'POST'], pattern: /^\/prompt$/ },
  { methods: ['GET', 'POST'], pattern: /^\/queue$/ },
  { methods: ['GET', 'POST'], pattern: /^\/history(?:\/.*)?$/ },
  { methods: ['GET'], pattern: /^\/view$/ },
  { methods: ['POST'], pattern: /^\/upload\/(?:image|mask)$/ },
  { methods: ['POST'], pattern: /^\/delete\/image$/ },
  { methods: ['POST'], pattern: /^\/free$/ },
  { methods: ['POST'], pattern: /^\/interrupt$/ },
  { methods: ['GET', 'PATCH'], pattern: /^\/internal\/logs\/raw$/ },
  { methods: ['GET'], pattern: /^\/api\/customnode\/(?:installed|getlist|getmappings)$/ },
  {
    methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'],
    pattern: /^\/comfymobile\/api\/(?:status|backup(?:\/.*)?|chains(?:\/.*)?|custom(?:\/.*)?|files(?:\/.*)?|history(?:\/.*)?|logs(?:\/.*)?|loras(?:\/.*)?|manager(?:\/.*)?|models(?:\/.*)?|queue(?:\/.*)?|reboot|snapshots(?:\/.*)?|translate|translation(?:\/.*)?|videos(?:\/.*)?|workflows(?:\/.*)?)$/,
  },
];

const dangerousRoutes = [
  /^\/comfymobile\/api\/reboot$/,
  /^\/comfymobile\/api\/files\/delete$/,
  /^\/comfymobile\/api\/models\/(?:delete|download|upload)(?:\/.*)?$/,
  /^\/comfymobile\/api\/manager\/queue\/install$/,
  /^\/comfymobile\/api\/videos\/(?:download|upgrade-yt-dlp)$/,
  /^\/comfymobile\/api\/translation\/local\/.*\/install$/,
];

export const authorizeProxyRoute = (pathname, method, config) => {
  const normalizedMethod = method.toUpperCase();
  const matched = allowedHttpRoutes.some(({ methods, pattern }) => (
    methods.includes(normalizedMethod) && pattern.test(pathname)
  ));

  if (!matched) {
    return { allowed: false, status: 404, code: 'route_not_allowed' };
  }

  if (
    !config.allowDangerousActions
    && dangerousRoutes.some((pattern) => pattern.test(pathname))
  ) {
    return { allowed: false, status: 403, code: 'dangerous_action_disabled' };
  }

  return { allowed: true };
};

export const isAllowedWebSocketPath = (pathname) => (
  pathname === '/ws'
  || pathname === '/comfymobile/ws'
  || pathname === '/comfymobile/api/chains/progress'
);

const reservedApiPrefixes = [
  '/api/',
  '/comfymobile/',
  '/system_stats',
  '/object_info',
  '/prompt',
  '/queue',
  '/history',
  '/view',
  '/upload/',
  '/delete/',
  '/free',
  '/interrupt',
  '/internal/',
  '/ws',
];

export const isReservedApiPath = (pathname) => (
  reservedApiPrefixes.some((prefix) => pathname.startsWith(prefix))
);
