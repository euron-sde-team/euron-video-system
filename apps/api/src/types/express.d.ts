import type { PlaybackClaims } from "../playback/token.js";

/** Authenticated API key attached by requireApiKey. */
export interface AuthContext {
  apiKeyId: string;
  name: string;
  prefix: string;
  scopes: string[];
  createdAt: Date;
  expiresAt: Date | null;
}

declare global {
  namespace Express {
    interface Request {
      requestId: string;
      auth?: AuthContext;
      playback?: PlaybackClaims & { token: string };
    }
  }
}

export {};
