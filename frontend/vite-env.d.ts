/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly VITE_API_BASE: string;
  readonly VITE_AUTH_MODE: 'sso' | 'dev';
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}

declare global {
  let IS_TEST: boolean | undefined;
}
