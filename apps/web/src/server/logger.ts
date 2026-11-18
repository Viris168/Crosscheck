import 'server-only';
import pino from 'pino';

// Structured logs. Add reviewId / repoId as fields; never log tokens, keys or code.
export const logger = pino({
  level: process.env.LOG_LEVEL ?? (process.env.NODE_ENV === 'production' ? 'info' : 'debug'),
  redact: {
    paths: [
      '*.token',
      '*.accessToken',
      '*.refreshToken',
      '*.authorization',
      '*.password',
      '*.secret',
      'req.headers.authorization',
      'req.headers.cookie',
    ],
    censor: '[redacted]',
  },
});
