import { extractRequestMeta, isChatGPTSameOrigin, parseChatGPTResponse } from "../parsers/chatgpt";
import type { ObservedResponse, ParsedChatGPTResponse } from "../types";

export type ParsedHandler = (parsed: ParsedChatGPTResponse) => void | Promise<void>;

export interface InterceptorOptions {
  onParsed: ParsedHandler;
  debug?: boolean;
}

type BrowserGlobal = Window & typeof globalThis;

export function installInterceptors(options: InterceptorOptions): () => void {
  const targetWindow = getPatchWindow();
  const restoreFetch = installFetchInterceptor(targetWindow, options);
  const restoreXhr = installXhrInterceptor(targetWindow, options);

  return () => {
    restoreFetch();
    restoreXhr();
  };
}

function installFetchInterceptor(targetWindow: BrowserGlobal, options: InterceptorOptions): () => void {
  const originalFetch = targetWindow.fetch;

  targetWindow.fetch = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url = getFetchUrl(input);
    const method = getFetchMethod(input, init);
    const requestMeta = extractRequestMeta(init?.body ?? null);
    const response = await originalFetch.call(targetWindow, input, init);

    if (isChatGPTSameOrigin(url)) {
      observeResponse({
        url,
        method,
        response,
        requestMeta,
        options
      });
    }

    return response;
  };

  return () => {
    targetWindow.fetch = originalFetch;
  };
}

function installXhrInterceptor(targetWindow: BrowserGlobal, options: InterceptorOptions): () => void {
  const OriginalXhr: typeof XMLHttpRequest = targetWindow.XMLHttpRequest;

  class UsageMonitorXHR extends OriginalXhr {
    private usageUrl = "";
    private usageMethod = "GET";
    private usageRequestMeta: ObservedResponse["requestMeta"] = { bodyKind: "none", model: null };

    open(method: string, url: string | URL, async?: boolean, username?: string | null, password?: string | null): void {
      this.usageMethod = method;
      this.usageUrl = String(url);
      super.open(method, url, async ?? true, username ?? undefined, password ?? undefined);
    }

    send(body?: Document | XMLHttpRequestBodyInit | null): void {
      this.usageRequestMeta = extractRequestMeta(body ?? null);
      this.addEventListener("loadend", () => {
        if (!isChatGPTSameOrigin(this.usageUrl)) {
          return;
        }

        void observeXhr({
          xhr: this,
          url: this.usageUrl,
          method: this.usageMethod,
          requestMeta: this.usageRequestMeta,
          options
        });
      });

      super.send(body);
    }
  }

  targetWindow.XMLHttpRequest = UsageMonitorXHR as unknown as typeof XMLHttpRequest;

  return () => {
    targetWindow.XMLHttpRequest = OriginalXhr;
  };
}

async function observeResponse(args: {
  url: string;
  method: string;
  response: Response;
  requestMeta: ObservedResponse["requestMeta"];
  options: InterceptorOptions;
}): Promise<void> {
  const { url, method, response, requestMeta, options } = args;
  const contentType = response.headers.get("content-type");
  let responseJson: unknown;

  if (contentType?.includes("json")) {
    try {
      responseJson = await response.clone().json();
    } catch (error) {
      debug(options, "Failed to clone JSON response", error);
    }
  }

  await emitParsed({
    url,
    method,
    status: response.status,
    ok: response.ok,
    contentType,
    responseJson,
    requestMeta
  }, options);
}

async function observeXhr(args: {
  xhr: XMLHttpRequest;
  url: string;
  method: string;
  requestMeta: ObservedResponse["requestMeta"];
  options: InterceptorOptions;
}): Promise<void> {
  const { xhr, url, method, requestMeta, options } = args;
  const contentType = xhr.getResponseHeader("content-type");
  let responseJson: unknown;

  if (contentType?.includes("json") && typeof xhr.responseText === "string") {
    try {
      responseJson = JSON.parse(xhr.responseText) as unknown;
    } catch (error) {
      debug(options, "Failed to parse XHR JSON response", error);
    }
  }

  await emitParsed({
    url,
    method,
    status: xhr.status || null,
    ok: xhr.status >= 200 && xhr.status < 400,
    contentType,
    responseJson,
    requestMeta
  }, options);
}

async function emitParsed(observed: ObservedResponse, options: InterceptorOptions): Promise<void> {
  try {
    const parsed = parseChatGPTResponse(observed);
    if (!parsed) {
      debug(options, "Ignored response", observed.url);
      return;
    }

    await options.onParsed(parsed);
  } catch (error) {
    debug(options, "Failed to parse observed response", error);
  }
}

function getFetchUrl(input: RequestInfo | URL): string {
  if (typeof input === "string") {
    return input;
  }
  if (input instanceof URL) {
    return input.toString();
  }
  return input.url;
}

function getFetchMethod(input: RequestInfo | URL, init?: RequestInit): string {
  if (init?.method) {
    return init.method.toUpperCase();
  }
  if (input instanceof Request) {
    return input.method.toUpperCase();
  }
  return "GET";
}

function getPatchWindow(): BrowserGlobal {
  if (
    typeof unsafeWindow !== "undefined" &&
    typeof unsafeWindow.fetch === "function" &&
    typeof unsafeWindow.XMLHttpRequest === "function"
  ) {
    return unsafeWindow;
  }

  return window as BrowserGlobal;
}

function debug(options: InterceptorOptions, ...args: unknown[]): void {
  if (options.debug) {
    console.debug("[ChatGPT Usage Monitor]", ...args);
  }
}
