// The environment variables video-review reads: https://bun.com/docs/runtime/environment-variables
declare module 'bun' {
  interface Env {
    GEMINI_API_KEY?: string;
    AZURE_API_KEY?: string;
    AZURE_RESOURCE_NAME?: string;
    ELEVENLABS_API_KEY?: string;
    ELEVENLABS_VOICE_ID?: string;
    XDG_CACHE_HOME?: string;
  }
}
