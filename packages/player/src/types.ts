/** Error contract shared by both engines. `isAuth` = a 401/403 on a playlist or key. */
export interface PlayerError {
  code?: number;
  message: string;
  isAuth: boolean;
}

/** What the player loads. Both URLs already carry the viewer's playback token. */
export interface PlayerSource {
  manifestUrl: string;
  thumbnailsUrl?: string;
}
