// ==UserScript==
// @name         ChatGPT Usage Monitor
// @namespace    https://github.com/local/chatgpt-usage-userscript
// @version      0.1.1
// @description  Show local and officially observed ChatGPT subscription/model usage metadata without storing conversation content.
// @author       local
// @match        https://chatgpt.com/*
// @match        https://chat.openai.com/*
// @grant        GM_getValue
// @grant        GM_setValue
// @grant        GM_deleteValue
// @grant        GM_download
// @grant        unsafeWindow
// @run-at       document-start
// @updateURL    https://raw.githubusercontent.com/zyxjeek/ChatGPT-Usage-Plugin/main/dist/chatgpt-usage-monitor.user.js
// @downloadURL  https://raw.githubusercontent.com/zyxjeek/ChatGPT-Usage-Plugin/main/dist/chatgpt-usage-monitor.user.js
// ==/UserScript==

(function() {
	//#region src/parsers/chatgpt.ts
	var CHATGPT_HOSTS = new Set(["chatgpt.com", "chat.openai.com"]);
	var MODEL_KEYS = new Set([
		"model",
		"model_slug",
		"slug",
		"default_model_slug"
	]);
	var PLAN_KEYS = new Set([
		"plan_type",
		"plan_name",
		"account_plan",
		"subscription_plan",
		"product_name"
	]);
	var STATUS_KEYS = new Set([
		"account_status",
		"status",
		"subscription_status"
	]);
	var LIMIT_KEYS = new Set([
		"message_cap",
		"message_limit",
		"cap",
		"limit",
		"max_messages"
	]);
	var REMAINING_KEYS = new Set([
		"remaining",
		"remaining_messages",
		"messages_remaining"
	]);
	var RESET_KEYS = new Set([
		"reset_after",
		"reset_at",
		"resets_at",
		"window_end"
	]);
	function isChatGPTSameOrigin(url) {
		try {
			const parsed = new URL(url, window.location.href);
			return parsed.origin === window.location.origin && CHATGPT_HOSTS.has(parsed.hostname);
		} catch {
			return false;
		}
	}
	function parseChatGPTResponse(observed) {
		if (!isInterestingEndpoint(observed.url) && observed.requestMeta?.model == null) return null;
		const endpointType = classifyEndpoint(observed.url, observed.method, observed.requestMeta?.model ?? null);
		const parsed = {};
		const models = /* @__PURE__ */ new Set();
		if (observed.requestMeta?.model) models.add(observed.requestMeta.model);
		if (isJsonLike(observed.contentType) && observed.responseJson != null) {
			const findings = collectFindings(observed.responseJson);
			for (const model of findings.models) models.add(model);
			if (findings.planName || findings.accountStatus) parsed.plan = {
				planName: findings.planName ?? null,
				accountStatus: findings.accountStatus ?? null,
				source: "official"
			};
			if (findings.limits.length > 0) parsed.limits = findings.limits;
		}
		if (models.size > 0) parsed.models = Array.from(models).sort();
		parsed.request = {
			endpoint: safePath(observed.url),
			method: observed.method,
			status: observed.status,
			ok: observed.ok,
			model: observed.requestMeta?.model ?? firstModelForRequest(models),
			type: endpointType,
			source: endpointType === "message" ? "observed" : "official"
		};
		return hasUsefulData(parsed) ? parsed : null;
	}
	function extractRequestMeta(body) {
		if (body == null) return {
			bodyKind: "none",
			model: null
		};
		if (typeof body === "string") {
			const trimmed = body.trim();
			if (!trimmed) return {
				bodyKind: "none",
				model: null
			};
			if (trimmed.startsWith("{") || trimmed.startsWith("[")) try {
				return {
					bodyKind: "json",
					model: findModelValue(JSON.parse(trimmed))
				};
			} catch {
				return {
					bodyKind: "unknown",
					model: null
				};
			}
			return {
				bodyKind: "form",
				model: extractModelFromText(trimmed)
			};
		}
		if (body instanceof URLSearchParams) return {
			bodyKind: "form",
			model: body.get("model") ?? body.get("model_slug")
		};
		if (typeof FormData !== "undefined" && body instanceof FormData) {
			const model = body.get("model") ?? body.get("model_slug");
			return {
				bodyKind: "form",
				model: typeof model === "string" ? model : null
			};
		}
		return {
			bodyKind: "unknown",
			model: null
		};
	}
	function collectFindings(root) {
		const models = /* @__PURE__ */ new Set();
		const limits = [];
		let planName = null;
		let accountStatus = null;
		const seen = /* @__PURE__ */ new WeakSet();
		function visit(value) {
			if (value == null || typeof value !== "object") return;
			if (seen.has(value)) return;
			seen.add(value);
			if (Array.isArray(value)) {
				for (const item of value) visit(item);
				return;
			}
			const record = value;
			const model = pickString(record, MODEL_KEYS);
			if (model && looksLikeModel(model)) models.add(model);
			planName ??= pickString(record, PLAN_KEYS);
			accountStatus ??= pickString(record, STATUS_KEYS);
			const limit = pickNumber(record, LIMIT_KEYS);
			const remaining = pickNumber(record, REMAINING_KEYS);
			const windowEnd = pickTime(record, RESET_KEYS);
			if (model && (limit !== null || remaining !== null || windowEnd !== null)) limits.push({
				model,
				limit,
				remaining,
				windowEnd
			});
			for (const child of Object.values(record)) visit(child);
		}
		visit(root);
		return {
			models: Array.from(models),
			planName,
			accountStatus,
			limits
		};
	}
	function classifyEndpoint(url, method, requestModel) {
		const path = safePath(url).toLowerCase();
		const normalizedMethod = method.toUpperCase();
		if ((path.includes("conversation") || path.includes("completion")) && normalizedMethod === "POST" && requestModel) return "message";
		if (path.includes("conversation") || path.includes("completion")) return "conversation";
		if (path.includes("models")) return "models";
		if (path.includes("limit") || path.includes("cap")) return "limits";
		if (path.includes("account") || path.includes("subscription") || path.includes("billing")) return "subscription";
		return "unknown";
	}
	function isInterestingEndpoint(url) {
		const path = safePath(url).toLowerCase();
		return [
			"backend-api",
			"conversation",
			"completion",
			"models",
			"account",
			"subscription",
			"billing",
			"limit",
			"cap"
		].some((part) => path.includes(part));
	}
	function hasUsefulData(parsed) {
		return Boolean(parsed.plan || parsed.models?.length || parsed.limits?.length || parsed.request?.type !== "unknown");
	}
	function isJsonLike(contentType) {
		return Boolean(contentType?.includes("application/json") || contentType?.includes("+json"));
	}
	function safePath(url) {
		try {
			const parsed = new URL(url, window.location.href);
			return `${parsed.pathname}${parsed.search}`;
		} catch {
			return url;
		}
	}
	function firstModelForRequest(models) {
		const first = models.values().next();
		return first.done ? null : first.value;
	}
	function pickString(record, keys) {
		for (const [key, value] of Object.entries(record)) if (keys.has(key.toLowerCase()) && typeof value === "string" && value.trim()) return value.trim();
		return null;
	}
	function pickNumber(record, keys) {
		for (const [key, value] of Object.entries(record)) {
			if (!keys.has(key.toLowerCase())) continue;
			if (typeof value === "number" && Number.isFinite(value)) return value;
			if (typeof value === "string" && value.trim() && Number.isFinite(Number(value))) return Number(value);
		}
		return null;
	}
	function pickTime(record, keys) {
		for (const [key, value] of Object.entries(record)) {
			if (!keys.has(key.toLowerCase())) continue;
			if (typeof value === "number" && Number.isFinite(value)) return value > 1e10 ? value : Date.now() + value * 1e3;
			if (typeof value === "string") {
				const parsed = Date.parse(value);
				if (Number.isFinite(parsed)) return parsed;
			}
		}
		return null;
	}
	function findModelValue(root) {
		let found = null;
		const seen = /* @__PURE__ */ new WeakSet();
		function visit(value) {
			if (found || value == null || typeof value !== "object") return;
			if (seen.has(value)) return;
			seen.add(value);
			if (Array.isArray(value)) {
				for (const item of value) visit(item);
				return;
			}
			const record = value;
			found = pickString(record, MODEL_KEYS);
			if (found) return;
			for (const child of Object.values(record)) visit(child);
		}
		visit(root);
		return found;
	}
	function extractModelFromText(text) {
		const match = /(?:model|model_slug)=([^&]+)/i.exec(text);
		return match ? decodeURIComponent(match[1].replace(/\+/g, " ")) : null;
	}
	function looksLikeModel(value) {
		const normalized = value.toLowerCase();
		return normalized.includes("gpt") || normalized.includes("o1") || normalized.includes("o3") || normalized.includes("o4");
	}
	//#endregion
	//#region src/network/interceptor.ts
	function installInterceptors(options) {
		const targetWindow = getPatchWindow();
		const restoreFetch = installFetchInterceptor(targetWindow, options);
		const restoreXhr = installXhrInterceptor(targetWindow, options);
		return () => {
			restoreFetch();
			restoreXhr();
		};
	}
	function installFetchInterceptor(targetWindow, options) {
		const originalFetch = targetWindow.fetch;
		targetWindow.fetch = async (input, init) => {
			const url = getFetchUrl(input);
			const method = getFetchMethod(input, init);
			const requestMeta = extractRequestMeta(init?.body ?? null);
			const response = await originalFetch.call(targetWindow, input, init);
			if (isChatGPTSameOrigin(url)) observeResponse({
				url,
				method,
				response,
				requestMeta,
				options
			});
			return response;
		};
		return () => {
			targetWindow.fetch = originalFetch;
		};
	}
	function installXhrInterceptor(targetWindow, options) {
		const OriginalXhr = targetWindow.XMLHttpRequest;
		class UsageMonitorXHR extends OriginalXhr {
			usageUrl = "";
			usageMethod = "GET";
			usageRequestMeta = {
				bodyKind: "none",
				model: null
			};
			open(method, url, async, username, password) {
				this.usageMethod = method;
				this.usageUrl = String(url);
				super.open(method, url, async ?? true, username ?? void 0, password ?? void 0);
			}
			send(body) {
				this.usageRequestMeta = extractRequestMeta(body ?? null);
				this.addEventListener("loadend", () => {
					if (!isChatGPTSameOrigin(this.usageUrl)) return;
					observeXhr({
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
		targetWindow.XMLHttpRequest = UsageMonitorXHR;
		return () => {
			targetWindow.XMLHttpRequest = OriginalXhr;
		};
	}
	async function observeResponse(args) {
		const { url, method, response, requestMeta, options } = args;
		const contentType = response.headers.get("content-type");
		let responseJson;
		if (contentType?.includes("json")) try {
			responseJson = await response.clone().json();
		} catch (error) {
			debug(options, "Failed to clone JSON response", error);
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
	async function observeXhr(args) {
		const { xhr, url, method, requestMeta, options } = args;
		const contentType = xhr.getResponseHeader("content-type");
		let responseJson;
		if (contentType?.includes("json") && typeof xhr.responseText === "string") try {
			responseJson = JSON.parse(xhr.responseText);
		} catch (error) {
			debug(options, "Failed to parse XHR JSON response", error);
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
	async function emitParsed(observed, options) {
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
	function getFetchUrl(input) {
		if (typeof input === "string") return input;
		if (input instanceof URL) return input.toString();
		return input.url;
	}
	function getFetchMethod(input, init) {
		if (init?.method) return init.method.toUpperCase();
		if (input instanceof Request) return input.method.toUpperCase();
		return "GET";
	}
	function getPatchWindow() {
		if (typeof unsafeWindow !== "undefined" && typeof unsafeWindow.fetch === "function" && typeof unsafeWindow.XMLHttpRequest === "function") return unsafeWindow;
		return window;
	}
	function debug(options, ...args) {
		if (options.debug) console.debug("[ChatGPT Usage Monitor]", ...args);
	}
	//#endregion
	//#region src/data/officialLimits.ts
	var GPT_55_HELP_CENTER_URL = "https://help.openai.com/zh-hans-cn/articles/11909943-gpt-55-in-chatgpt";
	var HOUR_MS = 3600 * 1e3;
	var OFFICIAL_USAGE_LIMITS = [
		{
			id: "gpt-5.5-thinking-plus-business",
			planMatcher: ["plus", "business"],
			modelMatcher: [
				"gpt-5.5 thinking",
				"gpt-5-5-thinking",
				"thinking"
			],
			displayPlan: "Plus / Business",
			displayModel: "GPT-5.5 Thinking 手动选择",
			limit: 3e3,
			windowMs: 168 * HOUR_MS,
			windowLabel: "每周",
			note: "仅统计手动选择 Thinking；Instant 自动切换到 Thinking 不计入该每周限制。",
			sourceUrl: GPT_55_HELP_CENTER_URL
		},
		{
			id: "gpt-5.5-thinking-go",
			planMatcher: ["go"],
			modelMatcher: [
				"gpt-5.5 thinking",
				"gpt-5-5-thinking",
				"thinking"
			],
			displayPlan: "Go",
			displayModel: "GPT-5.5 Thinking",
			limit: 10,
			windowMs: 5 * HOUR_MS,
			windowLabel: "5 小时",
			note: "Go 用户启用 Thinking 后适用。",
			sourceUrl: GPT_55_HELP_CENTER_URL
		},
		{
			id: "gpt-5.5-free",
			planMatcher: ["free", "免费"],
			modelMatcher: [
				"gpt-5.5",
				"gpt-5-5",
				"gpt 5.5",
				"instant"
			],
			displayPlan: "Free",
			displayModel: "GPT-5.5",
			limit: 10,
			windowMs: 5 * HOUR_MS,
			windowLabel: "5 小时",
			note: "达到限制后会自动改用 mini 版本。",
			sourceUrl: GPT_55_HELP_CENTER_URL
		},
		{
			id: "gpt-5.5-plus-go",
			planMatcher: ["plus", "go"],
			modelMatcher: [
				"gpt-5.5",
				"gpt-5-5",
				"gpt 5.5",
				"instant"
			],
			displayPlan: "Plus / Go",
			displayModel: "GPT-5.5",
			limit: 160,
			windowMs: 3 * HOUR_MS,
			windowLabel: "3 小时",
			note: "达到限制后会切换为 mini 版本。",
			sourceUrl: GPT_55_HELP_CENTER_URL
		},
		{
			id: "gpt-5-business-pro",
			planMatcher: ["business", "pro"],
			modelMatcher: [
				"gpt-5",
				"gpt-5.5",
				"gpt-5-5",
				"instant",
				"thinking"
			],
			displayPlan: "Business / Pro",
			displayModel: "GPT-5 系列",
			limit: null,
			windowMs: null,
			windowLabel: "无限制",
			note: "受防滥用护栏约束，异常使用仍可能被临时限制。",
			sourceUrl: GPT_55_HELP_CENTER_URL
		}
	];
	function findOfficialLimit(model, planName) {
		const normalizedModel = normalize(model);
		const normalizedPlan = normalize(planName ?? "");
		return OFFICIAL_USAGE_LIMITS.find((limit) => {
			const planMatches = !normalizedPlan || limit.planMatcher.some((plan) => normalizedPlan.includes(normalize(plan)));
			const modelMatches = limit.modelMatcher.some((candidate) => normalizedModel.includes(normalize(candidate)));
			return planMatches && modelMatches;
		}) ?? null;
	}
	function normalize(value) {
		return value.toLowerCase().replace(/[_.\s]+/g, "-");
	}
	//#endregion
	//#region src/store/usageStore.ts
	var STORE_KEY = "chatgpt-usage-monitor-state";
	var MAX_RECENT = 25;
	var DAY_MS = 1440 * 60 * 1e3;
	var defaultSettings = {
		expanded: false,
		pinned: false,
		compact: false
	};
	function createEmptyState() {
		return {
			version: 1,
			plan: null,
			usages: {},
			recent: [],
			settings: { ...defaultSettings },
			lastUpdatedAt: Date.now()
		};
	}
	var BrowserStorage = class {
		async get(key, fallback) {
			try {
				if (typeof GM_getValue === "function") return await GM_getValue(key, fallback);
			} catch {}
			const raw = localStorage.getItem(key);
			if (!raw) return fallback;
			try {
				return JSON.parse(raw);
			} catch {
				return fallback;
			}
		}
		async set(key, value) {
			try {
				if (typeof GM_setValue === "function") {
					await GM_setValue(key, value);
					return;
				}
			} catch {}
			localStorage.setItem(key, JSON.stringify(value));
		}
		async delete(key) {
			try {
				if (typeof GM_deleteValue === "function") {
					await GM_deleteValue(key);
					return;
				}
			} catch {}
			localStorage.removeItem(key);
		}
	};
	var UsageStore = class extends EventTarget {
		storage;
		state = null;
		constructor(storage = new BrowserStorage()) {
			super();
			this.storage = storage;
		}
		async load() {
			if (this.state) return this.state;
			const loaded = await this.storage.get(STORE_KEY, createEmptyState());
			this.state = normalizeState(loaded);
			return this.state;
		}
		async getState() {
			return this.load();
		}
		async updateSettings(settings) {
			const state = await this.load();
			state.settings = {
				...state.settings,
				...settings
			};
			state.lastUpdatedAt = Date.now();
			await this.persist(state);
			return state;
		}
		async applyParsed(parsed) {
			const state = await this.load();
			const now = Date.now();
			if (parsed.plan || parsed.models?.length) state.plan = {
				planName: parsed.plan?.planName ?? state.plan?.planName ?? null,
				accountStatus: parsed.plan?.accountStatus ?? state.plan?.accountStatus ?? null,
				visibleModels: dedupe([
					...parsed.models ?? [],
					...parsed.plan?.visibleModels ?? [],
					...state.plan?.visibleModels ?? []
				]),
				source: "official",
				updatedAt: now
			};
			for (const limit of parsed.limits ?? []) {
				const key = normalizeModelName(limit.model);
				const existing = state.usages[key] ?? createUsage(key, now, state.plan?.planName);
				state.usages[key] = {
					...existing,
					remaining: limit.remaining ?? existing.remaining,
					limit: limit.limit ?? existing.limit,
					limitLabel: existing.limitLabel,
					windowEnd: limit.windowEnd ?? existing.windowEnd,
					source: "official"
				};
			}
			if (parsed.request) {
				const request = {
					id: `${now}-${Math.random().toString(36).slice(2)}`,
					timestamp: parsed.request.timestamp ?? now,
					endpoint: parsed.request.endpoint,
					method: parsed.request.method,
					status: parsed.request.status,
					ok: parsed.request.ok,
					model: parsed.request.model ? normalizeModelName(parsed.request.model) : null,
					type: parsed.request.type,
					source: parsed.request.source ?? "observed"
				};
				state.recent = [request, ...state.recent].slice(0, MAX_RECENT);
				if (request.type === "message" && request.ok && request.model) {
					const usage = rolloverIfNeeded(state.usages[request.model] ?? createUsage(request.model, request.timestamp, state.plan?.planName), request.timestamp, state.plan?.planName);
					usage.used += 1;
					usage.lastUsedAt = request.timestamp;
					usage.source = usage.source === "official" ? "official" : "observed";
					if (usage.remaining !== null && usage.remaining > 0) usage.remaining -= 1;
					state.usages[request.model] = usage;
				}
			}
			state.lastUpdatedAt = now;
			await this.persist(state);
			return state;
		}
		async clear() {
			await this.storage.delete(STORE_KEY);
			this.state = createEmptyState();
			await this.persist(this.state);
			return this.state;
		}
		async exportJson() {
			const state = await this.load();
			return JSON.stringify(state, null, 2);
		}
		async persist(state) {
			this.state = normalizeState(state);
			await this.storage.set(STORE_KEY, this.state);
			this.dispatchEvent(new CustomEvent("change", { detail: this.state }));
		}
	};
	function normalizeState(input) {
		const usages = Object.fromEntries(Object.entries(input.usages ?? {}).map(([key, usage]) => [key, {
			...usage,
			limitLabel: usage.limitLabel ?? "本地日"
		}]));
		return {
			version: 1,
			plan: input.plan ?? null,
			usages,
			recent: Array.isArray(input.recent) ? input.recent.slice(0, MAX_RECENT) : [],
			settings: {
				...defaultSettings,
				...input.settings ?? {}
			},
			lastUpdatedAt: input.lastUpdatedAt || Date.now()
		};
	}
	function createUsage(model, now, planName) {
		const officialLimit = findOfficialLimit(model, planName);
		const windowMs = officialLimit?.windowMs ?? DAY_MS;
		const windowStart = officialLimit?.windowMs ? alignRollingWindow(now, officialLimit.windowMs) : startOfLocalDay(now);
		return {
			model,
			used: 0,
			remaining: officialLimit?.limit ?? null,
			limit: officialLimit?.limit ?? null,
			limitLabel: officialLimit?.windowLabel ?? "本地日",
			windowStart,
			windowEnd: officialLimit?.windowMs ? windowStart + windowMs : windowStart + DAY_MS,
			lastUsedAt: now,
			source: "observed"
		};
	}
	function rolloverIfNeeded(usage, now, planName) {
		if (usage.windowEnd && now < usage.windowEnd) return usage;
		const fresh = createUsage(usage.model, now, planName);
		return {
			...fresh,
			limit: fresh.limit ?? usage.limit,
			remaining: fresh.limit ?? usage.limit,
			limitLabel: fresh.limitLabel ?? usage.limitLabel,
			source: usage.source
		};
	}
	function startOfLocalDay(timestamp) {
		const date = new Date(timestamp);
		date.setHours(0, 0, 0, 0);
		return date.getTime();
	}
	function alignRollingWindow(timestamp, windowMs) {
		return Math.floor(timestamp / windowMs) * windowMs;
	}
	function normalizeModelName(model) {
		return model.trim().toLowerCase();
	}
	function dedupe(values) {
		return Array.from(new Set(values.map((value) => value.trim()).filter(Boolean))).sort();
	}
	//#endregion
	//#region src/styles.css?inline
	var styles_default = ":host {\n  color-scheme: light dark;\n  --cgum-bg: light-dark(#ffffff, #1f1f1f);\n  --cgum-panel: light-dark(#f7f7f5, #2a2a2a);\n  --cgum-text: light-dark(#202123, #ececf1);\n  --cgum-muted: light-dark(#6b6f76, #a7a7a7);\n  --cgum-border: light-dark(#deded8, #3f3f46);\n  --cgum-accent: #10a37f;\n  --cgum-warning: #d9822b;\n  --cgum-danger: #d14343;\n  --cgum-shadow: 0 18px 50px rgb(0 0 0 / 18%);\n  font-family: ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, \"Segoe UI\", sans-serif;\n}\n\n.cgum-root {\n  position: fixed;\n  right: 18px;\n  bottom: 18px;\n  z-index: 2147483647;\n  color: var(--cgum-text);\n}\n\n.cgum-button,\n.cgum-icon-button,\n.cgum-action {\n  border: 1px solid var(--cgum-border);\n  background: var(--cgum-bg);\n  color: var(--cgum-text);\n  cursor: pointer;\n  font: inherit;\n}\n\n.cgum-button {\n  width: 46px;\n  height: 46px;\n  display: grid;\n  place-items: center;\n  border-radius: 999px;\n  box-shadow: var(--cgum-shadow);\n  font-weight: 700;\n}\n\n.cgum-panel {\n  width: min(380px, calc(100vw - 28px));\n  max-height: min(620px, calc(100vh - 48px));\n  overflow: auto;\n  border: 1px solid var(--cgum-border);\n  border-radius: 8px;\n  background: var(--cgum-bg);\n  box-shadow: var(--cgum-shadow);\n}\n\n.cgum-hidden {\n  display: none;\n}\n\n.cgum-header {\n  display: flex;\n  align-items: center;\n  justify-content: space-between;\n  gap: 12px;\n  padding: 14px 14px 10px;\n  border-bottom: 1px solid var(--cgum-border);\n}\n\n.cgum-title {\n  margin: 0;\n  font-size: 15px;\n  line-height: 1.25;\n}\n\n.cgum-subtitle {\n  margin: 2px 0 0;\n  color: var(--cgum-muted);\n  font-size: 12px;\n}\n\n.cgum-tools {\n  display: flex;\n  gap: 6px;\n}\n\n.cgum-icon-button {\n  width: 30px;\n  height: 30px;\n  display: grid;\n  place-items: center;\n  border-radius: 6px;\n  font-size: 14px;\n}\n\n.cgum-icon-button[aria-pressed=\"true\"] {\n  border-color: color-mix(in srgb, var(--cgum-accent) 55%, var(--cgum-border));\n  color: var(--cgum-accent);\n}\n\n.cgum-body {\n  padding: 12px 14px 14px;\n}\n\n.cgum-section + .cgum-section {\n  margin-top: 14px;\n}\n\n.cgum-section-title {\n  display: flex;\n  align-items: center;\n  justify-content: space-between;\n  margin-bottom: 8px;\n  color: var(--cgum-muted);\n  font-size: 12px;\n  font-weight: 700;\n  text-transform: uppercase;\n}\n\n.cgum-plan {\n  display: grid;\n  grid-template-columns: 1fr auto;\n  gap: 8px;\n  padding: 10px;\n  border-radius: 8px;\n  background: var(--cgum-panel);\n}\n\n.cgum-plan strong {\n  display: block;\n  font-size: 14px;\n}\n\n.cgum-pill {\n  align-self: start;\n  padding: 3px 7px;\n  border: 1px solid var(--cgum-border);\n  border-radius: 999px;\n  color: var(--cgum-muted);\n  font-size: 11px;\n}\n\n.cgum-model {\n  padding: 10px 0;\n  border-bottom: 1px solid var(--cgum-border);\n}\n\n.cgum-model:last-child {\n  border-bottom: 0;\n}\n\n.cgum-model-row {\n  display: flex;\n  align-items: center;\n  justify-content: space-between;\n  gap: 10px;\n  margin-bottom: 7px;\n}\n\n.cgum-model-name {\n  min-width: 0;\n  overflow: hidden;\n  font-size: 14px;\n  font-weight: 650;\n  text-overflow: ellipsis;\n  white-space: nowrap;\n}\n\n.cgum-model-count {\n  color: var(--cgum-muted);\n  font-size: 12px;\n  white-space: nowrap;\n}\n\n.cgum-bar {\n  height: 7px;\n  overflow: hidden;\n  border-radius: 999px;\n  background: color-mix(in srgb, var(--cgum-muted) 18%, transparent);\n}\n\n.cgum-bar-fill {\n  width: var(--value, 0%);\n  height: 100%;\n  border-radius: inherit;\n  background: var(--cgum-accent);\n}\n\n.cgum-meta {\n  display: flex;\n  justify-content: space-between;\n  gap: 12px;\n  margin-top: 6px;\n  color: var(--cgum-muted);\n  font-size: 11px;\n}\n\n.cgum-empty {\n  padding: 14px 10px;\n  border-radius: 8px;\n  background: var(--cgum-panel);\n  color: var(--cgum-muted);\n  font-size: 13px;\n  line-height: 1.45;\n}\n\n.cgum-recent {\n  display: grid;\n  gap: 6px;\n}\n\n.cgum-limits {\n  display: grid;\n  gap: 6px;\n}\n\n.cgum-limit {\n  display: flex;\n  align-items: center;\n  justify-content: space-between;\n  gap: 10px;\n  padding: 8px;\n  border-radius: 8px;\n  background: var(--cgum-panel);\n  font-size: 12px;\n}\n\n.cgum-limit strong {\n  min-width: 0;\n  overflow: hidden;\n  text-overflow: ellipsis;\n  white-space: nowrap;\n}\n\n.cgum-limit span {\n  color: var(--cgum-muted);\n  white-space: nowrap;\n}\n\n.cgum-source {\n  display: inline-block;\n  margin-top: 7px;\n  color: var(--cgum-muted);\n  font-size: 11px;\n  text-decoration: none;\n}\n\n.cgum-record {\n  display: grid;\n  grid-template-columns: 1fr auto;\n  gap: 6px 12px;\n  padding: 8px;\n  border-radius: 8px;\n  background: var(--cgum-panel);\n  font-size: 12px;\n}\n\n.cgum-record span {\n  color: var(--cgum-muted);\n}\n\n.cgum-record-ok {\n  color: var(--cgum-accent);\n}\n\n.cgum-record-fail {\n  color: var(--cgum-danger);\n}\n\n.cgum-actions {\n  display: grid;\n  grid-template-columns: 1fr 1fr;\n  gap: 8px;\n}\n\n.cgum-action {\n  min-height: 34px;\n  border-radius: 6px;\n  font-size: 12px;\n}\n\n.cgum-privacy {\n  color: var(--cgum-muted);\n  font-size: 11px;\n  line-height: 1.45;\n}\n\n.cgum-compact .cgum-recent,\n.cgum-compact .cgum-limits,\n.cgum-compact .cgum-privacy,\n.cgum-compact .cgum-meta {\n  display: none;\n}\n\n@media (max-width: 520px) {\n  .cgum-root {\n    right: 10px;\n    bottom: 10px;\n  }\n\n  .cgum-panel {\n    width: calc(100vw - 20px);\n  }\n}\n";
	//#endregion
	//#region src/utils/dom.ts
	function onReady(callback) {
		if (document.body) {
			callback();
			return;
		}
		document.addEventListener("DOMContentLoaded", callback, { once: true });
	}
	function formatTime(timestamp) {
		if (!timestamp) return "未知";
		return new Intl.DateTimeFormat(void 0, {
			month: "2-digit",
			day: "2-digit",
			hour: "2-digit",
			minute: "2-digit"
		}).format(new Date(timestamp));
	}
	function escapeHtml(value) {
		return value.replace(/[&<>"']/g, (char) => {
			return {
				"&": "&amp;",
				"<": "&lt;",
				">": "&gt;",
				"\"": "&quot;",
				"'": "&#039;"
			}[char] ?? char;
		});
	}
	//#endregion
	//#region src/ui/panel.ts
	var UsagePanel = class {
		store;
		host = document.createElement("div");
		shadow = this.host.attachShadow({ mode: "open" });
		constructor(store) {
			this.store = store;
			this.host.id = "chatgpt-usage-monitor";
			this.shadow.innerHTML = `<style>${styles_default}</style><div class="cgum-root"></div>`;
			document.body.append(this.host);
			this.shadow.addEventListener("click", (event) => {
				this.handleClick(event);
			});
			this.store.addEventListener("change", (event) => {
				const state = event.detail;
				this.render(state);
			});
		}
		async init() {
			this.render(await this.store.getState());
		}
		render(state) {
			const root = this.shadow.querySelector(".cgum-root");
			if (!root) return;
			root.className = `cgum-root${state.settings.compact ? " cgum-compact" : ""}`;
			root.innerHTML = state.settings.expanded || state.settings.pinned ? this.renderPanel(state) : `<button class="cgum-button" data-action="expand" title="ChatGPT 使用情况" aria-label="ChatGPT 使用情况">▦</button>`;
		}
		renderPanel(state) {
			const plan = state.plan;
			const usages = Object.values(state.usages).sort((a, b) => b.lastUsedAt - a.lastUsedAt);
			const recent = state.recent.slice(0, state.settings.compact ? 3 : 6);
			return `
      <section class="cgum-panel" aria-label="ChatGPT 使用情况">
        <header class="cgum-header">
          <div>
            <h2 class="cgum-title">ChatGPT 使用情况</h2>
            <p class="cgum-subtitle">${escapeHtml(plan?.source === "official" ? "官方状态 + 本地观察" : "本地观察统计")}</p>
          </div>
          <div class="cgum-tools">
            <button class="cgum-icon-button" data-action="refresh" title="刷新" aria-label="刷新">↻</button>
            <button class="cgum-icon-button" data-action="compact" title="紧凑模式" aria-label="紧凑模式" aria-pressed="${state.settings.compact}">◱</button>
            <button class="cgum-icon-button" data-action="pin" title="固定面板" aria-label="固定面板" aria-pressed="${state.settings.pinned}">⌖</button>
            <button class="cgum-icon-button" data-action="collapse" title="收起" aria-label="收起">×</button>
          </div>
        </header>
        <div class="cgum-body">
          <section class="cgum-section">
            <div class="cgum-section-title">订阅</div>
            <div class="cgum-plan">
              <div>
                <strong>${escapeHtml(plan?.planName ?? "未知订阅")}</strong>
                <span>${escapeHtml(plan?.accountStatus ?? "状态未知")}</span>
              </div>
              <span class="cgum-pill">${escapeHtml(plan?.source ?? "unknown")}</span>
            </div>
          </section>
          <section class="cgum-section">
            <div class="cgum-section-title">
              <span>模型用量</span>
              <span>${usages.length} 个模型</span>
            </div>
            ${usages.length ? usages.map((usage) => this.renderUsage(usage)).join("") : this.renderEmpty()}
          </section>
          <section class="cgum-section">
            <div class="cgum-section-title">官方限制参考</div>
            <div class="cgum-limits">${OFFICIAL_USAGE_LIMITS.map((limit) => `
              <div class="cgum-limit">
                <strong>${escapeHtml(limit.displayPlan)} · ${escapeHtml(limit.displayModel)}</strong>
                <span>${limit.limit === null ? "无限制" : `${limit.limit} 条 / ${limit.windowLabel}`}</span>
              </div>
            `).join("")}</div>
            <a class="cgum-source" href="https://help.openai.com/zh-hans-cn/articles/11909943-gpt-55-in-chatgpt" target="_blank" rel="noreferrer">来源：OpenAI Help Center</a>
          </section>
          <section class="cgum-section">
            <div class="cgum-section-title">最近请求</div>
            ${recent.length ? `<div class="cgum-recent">${recent.map((record) => `
              <div class="cgum-record">
                <strong>${escapeHtml(record.model ?? record.type)}</strong>
                <b class="${record.ok ? "cgum-record-ok" : "cgum-record-fail"}">${record.status ?? "?"}</b>
                <span>${escapeHtml(record.method)} ${escapeHtml(record.endpoint)}</span>
                <span>${formatTime(record.timestamp)}</span>
              </div>
            `).join("")}</div>` : this.renderEmpty()}
          </section>
          <section class="cgum-section cgum-actions">
            <button class="cgum-action" data-action="export">导出元数据</button>
            <button class="cgum-action" data-action="clear">清空统计</button>
          </section>
          <p class="cgum-section cgum-privacy">仅保存模型、时间、状态码、成功失败和计数等元数据；不保存提示词、回复内容、完整请求体或完整响应体。</p>
        </div>
      </section>
    `;
		}
		renderUsage(usage) {
			const percentage = usage.limit !== null && usage.limit > 0 ? Math.min(100, Math.round(usage.used / usage.limit * 100)) : 0;
			const remaining = usage.remaining === null ? "剩余额度未知" : `约剩 ${usage.remaining}`;
			const windowLabel = usage.limitLabel ?? "当前周期";
			return `
      <div class="cgum-model">
        <div class="cgum-model-row">
          <div class="cgum-model-name" title="${escapeHtml(usage.model)}">${escapeHtml(usage.model)}</div>
          <div class="cgum-model-count">观察到 ${usage.used} 次</div>
        </div>
        <div class="cgum-bar" aria-hidden="true"><div class="cgum-bar-fill" style="--value: ${percentage}%"></div></div>
        <div class="cgum-meta">
          <span>${escapeHtml(remaining)}</span>
          <span>${escapeHtml(windowLabel)} · 重置 ${formatTime(usage.windowEnd)}</span>
        </div>
      </div>
    `;
		}
		renderEmpty() {
			return `<div class="cgum-empty">暂无可显示数据。发送一次消息或刷新页面后，脚本会尝试从 ChatGPT 请求中读取元数据。</div>`;
		}
		async handleClick(event) {
			const target = event.target instanceof Element ? event.target.closest("[data-action]") : null;
			if (!target) return;
			const state = await this.store.getState();
			const action = target.dataset.action;
			if (action === "expand") await this.store.updateSettings({ expanded: true });
			else if (action === "collapse") await this.store.updateSettings({
				expanded: false,
				pinned: false
			});
			else if (action === "pin") await this.store.updateSettings({
				pinned: !state.settings.pinned,
				expanded: true
			});
			else if (action === "compact") await this.store.updateSettings({ compact: !state.settings.compact });
			else if (action === "refresh") this.render(await this.store.getState());
			else if (action === "clear") {
				if (confirm("清空本地 ChatGPT 使用统计？")) await this.store.clear();
			} else if (action === "export") await exportState(await this.store.exportJson());
		}
	};
	async function exportState(json) {
		const blob = new Blob([json], { type: "application/json" });
		const url = URL.createObjectURL(blob);
		const name = `chatgpt-usage-${(/* @__PURE__ */ new Date()).toISOString().slice(0, 10)}.json`;
		try {
			if (typeof GM_download === "function") {
				GM_download({
					url,
					name,
					saveAs: true
				});
				return;
			}
			const anchor = document.createElement("a");
			anchor.href = url;
			anchor.download = name;
			anchor.click();
		} finally {
			setTimeout(() => URL.revokeObjectURL(url), 5e3);
		}
	}
	//#endregion
	//#region src/main.ts
	var DEBUG = localStorage.getItem("chatgpt-usage-monitor-debug") === "1";
	var store = new UsageStore();
	installInterceptors({
		debug: DEBUG,
		onParsed: async (parsed) => {
			await store.applyParsed(parsed);
		}
	});
	window.__CHATGPT_USAGE_MONITOR__ = {
		refresh: async () => {
			await store.getState();
		},
		exportData: async () => {
			const json = await store.exportJson();
			console.info("[ChatGPT Usage Monitor] Metadata export", JSON.parse(json));
		}
	};
	onReady(() => {
		new UsagePanel(store).init();
	});
	//#endregion
})();
