declare function GM_getValue<T>(key: string, defaultValue: T): T | Promise<T>;
declare function GM_setValue<T>(key: string, value: T): void | Promise<void>;
declare function GM_deleteValue(key: string): void | Promise<void>;
declare function GM_download(options: { url: string; name: string; saveAs?: boolean }): void;
declare const unsafeWindow: (Window & typeof globalThis) | undefined;

interface Window {
  __CHATGPT_USAGE_MONITOR__?: {
    refresh: () => Promise<void>;
    exportData: () => Promise<void>;
  };
}
