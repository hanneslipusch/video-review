// The environment variables video-review reads: https://bun.com/docs/runtime/environment-variables
declare module 'bun' {
  interface Env {
    GEMINI_API_KEY?: string;
    XDG_CACHE_HOME?: string;
  }
}
