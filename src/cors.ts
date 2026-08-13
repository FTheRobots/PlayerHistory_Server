import type { CorsOptions } from 'cors';

const LOCAL_ORIGIN = /^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/i;

/** CORS for remote admin clients (browser, portable exe, reverse proxy). */
export function createCorsOptions(corsOrigins: string[], corsAllowAll: boolean): CorsOptions {
  if (corsAllowAll) {
    return {
      origin(origin, callback) {
        // Reflect the request origin so credentials work from any client host.
        callback(null, origin ?? true);
      },
      credentials: true,
    };
  }

  return {
    origin(origin, callback) {
      if (!origin) {
        callback(null, true);
        return;
      }
      if (corsOrigins.includes(origin) || LOCAL_ORIGIN.test(origin)) {
        callback(null, true);
        return;
      }
      callback(new Error(`CORS blocked origin: ${origin}`));
    },
    credentials: true,
  };
}
