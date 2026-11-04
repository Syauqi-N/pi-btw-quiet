/**
 * pi-btw-quiet — `/btw` for Pi: ask a side question without disturbing the agent that is working.
 *
 * The side question runs in its own in-memory agent session, seeded with the main session's
 * transcript and restricted to read-only tools, so it can actually look things up (`read`,
 * `grep`, `find`, `ls`) instead of guessing. Nothing it does is ever written back to the main
 * conversation.
 *
 * What makes this one quiet:
 *
 *   - The panel is a widget above the editor, never an overlay. It never calls `setFocus`, so
 *     the main editor keeps the keyboard while the answer streams.
 *   - Panel keys are opt-in (`tab`). Typing a prompt that starts with `f` or `x` reaches the
 *     editor instead of triggering a command.
 *   - `esc` aborts only the side session. The main agent's own `esc` is never intercepted.
 *
 * Usage:
 *   /btw <question>     ask (works while the main agent is streaming)
 *   /btw                close the panel
 *   ctrl+shift+b / f2   close the panel
 *
 * Panel keys, only while the editor is empty so typing is never stolen:
 *   tab                   enter panel key mode
 *   ↑ / ↓ / pgup / pgdn   scroll
 *   shift+← / shift+→     browse earlier side questions
 *   c                     copy        x  clear history
 *   f                     branch the conversation here
 *   esc                   leave key mode, then close
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";

import type { AssistantMessage, Message, Model } from "@earendil-works/pi-ai";
import {
	buildSessionContext,
	convertToLlm,
	copyToClipboard,
	createAgentSession,
	DefaultResourceLoader,
	getAgentDir,
	getMarkdownTheme,
	SessionManager,
	SettingsManager,
	type AgentSession,
	type ExtensionAPI,
	type ExtensionCommandContext,
	type ExtensionContext,
	type ResourceLoader,
	type Theme,
} from "@earendil-works/pi-coding-agent";
import {
	Markdown,
	matchesKey,
	truncateToWidth,
	visibleWidth,
	wrapTextWithAnsi,
	type Component,
	type TUI,
} from "@earendil-works/pi-tui";

const ENTRY_TYPE = "btw";
const WIDGET_KEY = "btw";
const BRANCH_PREFIX = "btw:";
/** How many previous side questions the panel remembers before dropping the oldest. */
const MAX_HISTORY = 20;
const MAX_PANEL_ROWS = 16;
/** Read-only tools only: the side agent may look, never touch. */
const SIDE_TOOLS = ["read", "grep", "find", "ls"];
/** Optional per-user config for the side agent: `~/.pi/agent/btw.json`. */
const CONFIG_FILENAME = "btw.json";
const THINKING_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh", "max"] as const;
type BtwThinkingLevel = (typeof THINKING_LEVELS)[number];

interface Exchange {
	question: string;
	answer: string;
	error?: string;
	/** True when the user stopped the side question with `esc`. */
	aborted?: boolean;
	/** Tool the side agent is currently running, shown while it works. */
	toolName?: string | null;
}

/**
 * Which model the side agent should use.
 *
 * `configured: false` means "follow the main session". A broken config throws instead of
 * silently falling back, so a typo in btw.json is reported rather than quietly ignored.
 */
type ModelResolution = { configured: false } | { configured: true; model: Model<any>; thinking?: BtwThinkingLevel };

const errorMessage = (error: unknown): string => (error instanceof Error ? error.message : String(error));

/** Read `~/.pi/agent/btw.json`, re-read on every ask so edits apply without a restart. */
const readModelResolution = (ctx: ExtensionCommandContext): ModelResolution => {
	const configPath = join(getAgentDir(), CONFIG_FILENAME);
	let raw: string;
	try {
		raw = readFileSync(configPath, "utf8");
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return { configured: false };
		throw new Error(`/btw cannot read ${configPath}: ${errorMessage(error)}`);
	}

	let config: unknown;
	try {
		config = JSON.parse(raw);
	} catch (error) {
		throw new Error(`/btw invalid JSON in ${configPath}: ${errorMessage(error)}`);
	}
	if (typeof config !== "object" || config === null || Array.isArray(config)) {
		throw new Error(`/btw ${configPath} must contain a JSON object`);
	}

	const { model: reference, thinking } = config as { model?: unknown; thinking?: unknown };
	// An empty or missing `model` means "follow the main session".
	if (typeof reference !== "string" || reference.length === 0) return { configured: false };

	if (thinking !== undefined) {
		if (typeof thinking !== "string" || !THINKING_LEVELS.includes(thinking as BtwThinkingLevel)) {
			throw new Error(`/btw invalid "thinking" in ${configPath}: expected one of ${THINKING_LEVELS.join(", ")}`);
		}
	}

	const registry = ctx.modelRegistry;
	let model: Model<any> | undefined;
	if (reference.includes("/")) {
		const slash = reference.indexOf("/");
		model = registry.find(reference.slice(0, slash), reference.slice(slash + 1));
	} else {
		const matches = registry.getAll().filter((candidate) => candidate.id === reference);
		if (matches.length > 1) {
			throw new Error(`/btw ambiguous model id "${reference}" in ${configPath}, use provider/modelId`);
		}
		model = matches[0];
	}
	if (!model) throw new Error(`/btw unknown model "${reference}" in ${configPath}`);
	if (!registry.hasConfiguredAuth(model)) {
		throw new Error(`/btw no API key for ${model.provider}/${model.id}`);
	}

	return {
		configured: true,
		model,
		thinking: typeof thinking === "string" ? (thinking as BtwThinkingLevel) : undefined,
	};
};

interface BtwEntryData {
	model: string;
	exchanges: Exchange[];
}

const SIDE_SYSTEM_PROMPT = [
	"You are a temporary, read-only side agent answering one quick question for the user.",
	"The main agent continues its work uninterrupted; you share its conversation as background context only.",
	"You have read-only tools (read, grep, find, ls) so you may inspect the repository to answer accurately.",
	"Never claim to have modified anything, and never promise to take an action later.",
	"You cannot run commands, edit files, or install anything.",
	"Answer directly and concisely: 1-6 sentences unless the user asks for detail.",
	"Reply in the language the user used.",
].join(" ");

/** Resource loader for the side session: project context and skills, but no extensions. */
const createSideResourceLoader = (ctx: ExtensionCommandContext): ResourceLoader => {
	const promptOptions = ctx.getSystemPromptOptions();
	return new DefaultResourceLoader({
		cwd: ctx.cwd,
		agentDir: getAgentDir(),
		noExtensions: true,
		noPromptTemplates: true,
		noThemes: true,
		systemPrompt: promptOptions.customPrompt,
		appendSystemPrompt: [
			...(promptOptions.appendSystemPrompt ? [promptOptions.appendSystemPrompt] : []),
			SIDE_SYSTEM_PROMPT,
		],
	});
};

/**
 * Main-session transcript projected onto plain model messages.
 *
 * `failure` is set when the transcript could not be read. The caller reports it: an empty
 * seed would otherwise be indistinguishable from "the side agent has no context".
 */
const seedMessages = (ctx: ExtensionContext): { messages: Message[]; failure?: string } => {
	try {
		const context = buildSessionContext(ctx.sessionManager.getEntries(), ctx.sessionManager.getLeafId());
		return { messages: convertToLlm(context.messages) };
	} catch (error) {
		return { messages: [], failure: errorMessage(error) };
	}
};

const textOf = (message: AssistantMessage): string =>
	message.content
		.filter((part): part is { type: "text"; text: string } => part.type === "text")
		.map((part) => part.text)
		.join("");

/** Keep only the newest exchanges, so a long side thread cannot grow without bound. */
const capHistory = (exchanges: Exchange[]): void => {
	if (exchanges.length > MAX_HISTORY) exchanges.splice(0, exchanges.length - MAX_HISTORY);
};

/**
 * Detect and strip tool calls written as *text*.
 *
 * The side agent has real tools, but a model can still emit its native call syntax as plain
 * text (DeepSeek's `<｜｜DSML｜｜>`, Anthropic's `<function_calls>`, generic `<tool_use>`). Showing
 * that markup as an answer is worse than saying nothing was run.
 */
const TOOL_CALL_TEXT = new RegExp(
	[
		"<[\\s]*[｜|]{1,2}[\\s]*DSML[\\s]*[｜|]{1,2}[\\s]*(?:calls?|invoke|parameter)>",
		"</[\\s]*[｜|]{1,2}[\\s]*DSML[\\s]*[｜|]{1,2}[\\s]*(?:calls?|invoke|parameter)>",
		"<\\/?(?:antml:)?(?:function_calls|invoke|parameter)\\b[^>]*>",
		"<\\/?tool_use\\b[^>]*>",
	].join("|"),
	"i",
);

const TOOL_CALL_NOTE =
	"_/btw can't run that: the call above was written as text and nothing was executed. Ask in the main conversation to check._";

const stripToolCallText = (answer: string): string => {
	if (!TOOL_CALL_TEXT.test(answer)) return answer;
	const withoutBlocks = answer
		.replace(
			/<[\s]*[｜|]{1,2}[\s]*DSML[\s]*[｜|]{1,2}[\s]*calls?[\s]*>[\s\S]*?<[\s]*\/[\s]*[｜|]{1,2}[\s]*DSML[\s]*[｜|]{1,2}[\s]*calls?[\s]*>/gi,
			"",
		)
		.replace(/<(?:antml:)?function_calls\b[^>]*>[\s\S]*?<\/(?:antml:)?function_calls>/gi, "")
		.replace(/<tool_use\b[^>]*>[\s\S]*?<\/tool_use>/gi, "")
		.replace(TOOL_CALL_TEXT, "");
	const cleaned = withoutBlocks.replace(/\n{3,}/g, "\n\n").trim();
	return cleaned ? `${cleaned}\n\n${TOOL_CALL_NOTE}` : TOOL_CALL_NOTE;
};

const SPINNER = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];

const elapsed = (startedAt: number): string => {
	const seconds = Math.max(0, Math.round((Date.now() - startedAt) / 1000));
	return seconds < 60 ? `${seconds}s` : `${Math.floor(seconds / 60)}m${seconds % 60}s`;
};

/* -------------------------------------------------------------------------- */
/* Panel rendering                                                            */
/* -------------------------------------------------------------------------- */

/** Every row is painted, so the transcript behind the panel never shows through. */
const paint = (theme: Theme, line: string): string => theme.bg("toolPendingBg", line);

const panelQuestion = (theme: Theme, width: number, question: string, status?: string): string[] => {
	const label = "/btw ";
	const labelWidth = visibleWidth(label);
	const suffix = status ? ` ${status}` : "";
	const lines = wrapTextWithAnsi(question, Math.max(1, width - labelWidth - visibleWidth(suffix)));
	return lines.map((line, index) => {
		if (index > 0) return paint(theme, `${" ".repeat(labelWidth)}${line}`);
		const head = `${theme.fg("accent", theme.bold(label))}${line}${status ? theme.fg("dim", suffix) : ""}`;
		return paint(theme, head + " ".repeat(Math.max(0, width - visibleWidth(head))));
	});
};

const panelGap = (theme: Theme, width: number): string => paint(theme, " ".repeat(width));

const panelHint = (theme: Theme, width: number, hints: string): string => {
	const truncated = truncateToWidth(theme.fg("dim", hints), width, "…");
	return paint(theme, truncated + " ".repeat(Math.max(0, width - visibleWidth(truncated))));
};

/** Answer rows for one exchange, indented two columns. */
const answerRows = (theme: Theme, exchange: Exchange, width: number, busy: boolean): string[] => {
	const textWidth = Math.max(1, width - 2);
	const rows: string[] = [];
	if (exchange.answer) {
		for (const line of new Markdown(exchange.answer, 0, 0, getMarkdownTheme()).render(textWidth)) {
			rows.push(paint(theme, `  ${line}`));
		}
	} else if (busy) {
		rows.push(paint(theme, `  ${theme.fg("dim", exchange.toolName ? `running ${exchange.toolName}…` : "…")}`));
	}
	if (exchange.aborted) {
		for (const line of wrapTextWithAnsi("stopped", textWidth)) {
			rows.push(paint(theme, `  ${theme.fg("dim", line)}`));
		}
	}
	if (exchange.error) {
		for (const line of wrapTextWithAnsi(exchange.error, textWidth)) {
			rows.push(paint(theme, `  ${theme.fg("error", line)}`));
		}
	}
	return rows;
};

/**
 * Live panel above the editor. It never takes focus: keys arrive through a terminal input
 * listener, and only after the user opts in with `tab`.
 */
class BtwPanel implements Component {
	focused = false;
	tui?: TUI;
	private readonly startedAt = Date.now();
	private ticker?: ReturnType<typeof setInterval>;
	private scroll = 0;
	private lastMaxScroll = 0;
	private browse: number | null = null;
	private armed = false;

	constructor(
		private readonly theme: Theme,
		readonly exchanges: Exchange[],
		private readonly modelLabel: string,
		private readonly busyRef: { value: boolean },
	) {}

	touch(): void {
		this.tui?.requestRender();
	}

	startTicking(): void {
		this.ticker ??= setInterval(() => this.touch(), 500);
	}

	private stopTicking(): void {
		if (this.ticker) {
			clearInterval(this.ticker);
			this.ticker = undefined;
		}
	}

	dispose(): void {
		this.stopTicking();
	}

	invalidate(): void {}

	get streaming(): boolean {
		return this.busyRef.value;
	}

	get navigationMode(): boolean {
		return this.armed;
	}

	setNavigationMode(on: boolean): void {
		if (this.armed === on) return;
		this.armed = on;
		this.touch();
	}

	get scrollable(): boolean {
		return this.lastMaxScroll > 0;
	}

	get latest(): Exchange | undefined {
		return this.exchanges[this.exchanges.length - 1];
	}

	private shown(): Exchange | undefined {
		if (this.browse === null) return this.latest;
		return this.exchanges[this.browse];
	}

	scrollBy(delta: number): void {
		const next = Math.max(0, Math.min(this.lastMaxScroll, this.scroll + delta));
		if (next === this.scroll) return;
		this.scroll = next;
		this.touch();
	}

	browseBy(delta: number): void {
		const count = this.exchanges.length;
		if (count <= 1) return;
		const current = this.browse ?? count - 1;
		const next = Math.max(0, Math.min(count - 1, current + delta));
		if (next === current) return;
		this.browse = next === count - 1 ? null : next;
		this.scroll = 0;
		this.touch();
	}

	render(width: number): string[] {
		const { theme } = this;
		const w = Math.max(30, width);
		const busy = this.busyRef.value;
		if (!busy) this.stopTicking();

		const rows = this.tui?.terminal.rows ?? 40;
		const maxRows = Math.max(4, Math.min(MAX_PANEL_ROWS, Math.floor(rows * 0.45)));

		const shown = this.shown();
		const all = shown ? answerRows(theme, shown, w, busy && this.browse === null) : [];
		this.lastMaxScroll = Math.max(0, all.length - maxRows);
		this.scroll = Math.min(this.scroll, this.lastMaxScroll);

		const end = Math.max(0, all.length - this.scroll);
		const start = Math.max(0, end - maxRows);
		const visible = all.slice(start, end);

		const above = start;
		const below = Math.max(0, all.length - end);
		if (above > 0) visible[0] = paint(theme, theme.fg("dim", `  ↑ ${above} more line${above === 1 ? "" : "s"}`));
		if (below > 0) {
			visible[visible.length - 1] = paint(
				theme,
				theme.fg("dim", `  ↓ ${below} more line${below === 1 ? "" : "s"}`),
			);
		}

		const frame = SPINNER[Math.floor(Date.now() / 120) % SPINNER.length] ?? SPINNER[0]!;
		const status = busy ? `${frame} ${elapsed(this.startedAt)}` : undefined;

		const older = this.exchanges.length - 1 - (this.browse ?? this.exchanges.length - 1);
		const hints = this.armed
			? [
					older > 0 ? `shift+←/→ browse · ${older} earlier /btw` : "↑/↓ to scroll",
					shown?.answer ? "c copy" : undefined,
					shown?.answer && !shown.error ? "f branch" : undefined,
					this.exchanges.length > 0 ? "x clear" : undefined,
					"esc back to typing",
				]
					.filter(Boolean)
					.join(" · ")
			: busy
				? "tab to scroll · esc to cancel · keep typing to talk to the main agent"
				: "tab to scroll · esc to close · keep typing to talk to the main agent";

		return [
			...panelQuestion(theme, w, shown?.question ?? "", status),
			panelGap(theme, w),
			...visible,
			panelGap(theme, w),
			panelHint(theme, w, hints),
		];
	}
}

/* -------------------------------------------------------------------------- */
/* Extension                                                                  */
/* -------------------------------------------------------------------------- */

export default function btwExtension(pi: ExtensionAPI) {
	/** One lazily created side session per Pi session; in memory only. */
	let sideSession: AgentSession | undefined;
	let sideSubscribed = false;
	/** Set while a side session is reused across questions, so history keeps flowing. */
	let panel:
		| {
				component: BtwPanel;
				exchanges: Exchange[];
				busy: { value: boolean };
				ctx: ExtensionCommandContext;
				model: string;
				unsubscribe?: () => void;
		  }
		| undefined;

	const notify = (ctx: ExtensionContext, message: string, level: "info" | "warning" | "error" = "info") => {
		try {
			ctx.ui.notify(message, level);
		} catch {
			// The context can be replaced while an ask is in flight.
		}
	};

	const disposeSide = () => {
		try {
			sideSession?.dispose();
		} catch {
			/* already gone */
		}
		sideSession = undefined;
		sideSubscribed = false;
	};

	const closePanel = (): boolean => {
		if (!panel) return false;
		const current = panel;
		panel = undefined;
		current.busy.value = false;
		current.unsubscribe?.();
		current.ctx.ui.setWidget(WIDGET_KEY, undefined);
		current.ctx.ui.setWorkingMessage();
		// Stop whatever the side session is doing; the main agent is unaffected.
		void sideSession?.abort();

		// Closing mid-answer stops the side agent, so record that exchange as stopped. The
		// in-flight `ask()` cannot do it: the panel is already gone by the time it resolves.
		const inflight = current.exchanges[current.exchanges.length - 1];
		if (inflight && !inflight.answer.trim() && !inflight.error && !inflight.aborted) {
			inflight.aborted = true;
		}

		const exchanges = current.exchanges.filter((e) => e.answer.trim() || e.error || e.aborted);
		if (exchanges.length > 0) {
			pi.appendEntry<BtwEntryData>(ENTRY_TYPE, { model: current.model, exchanges });
		}
		return true;
	};

	pi.on("session_shutdown", () => {
		panel?.unsubscribe?.();
		panel = undefined;
		disposeSide();
	});

	pi.on("session_start", () => {
		// A new or resumed session must not reuse the previous side session's transcript.
		disposeSide();
	});

	pi.registerEntryRenderer<BtwEntryData>(ENTRY_TYPE, (entry, { expanded }, theme) => {
		const exchanges = entry.data?.exchanges ?? [];
		return {
			render: (width: number) => {
				const w = Math.max(30, width);
				const out: string[] = [];
				exchanges.forEach((exchange, index) => {
					if (index > 0) out.push(panelGap(theme, w));
					out.push(...panelQuestion(theme, w, exchange.question));
					out.push(panelGap(theme, w));
					const rows = answerRows(theme, exchange, w, false);
					if (!expanded && rows.length > 14) {
						out.push(...rows.slice(0, 14));
						out.push(paint(theme, theme.fg("dim", `  … ${rows.length - 14} more lines`)));
					} else {
						out.push(...rows);
					}
				});
				if (exchanges.length === 0) out.push(paint(theme, theme.fg("dim", "no answer recorded")));
				out.push(panelGap(theme, w));
				out.push(
					panelHint(
						theme,
						w,
						expanded
							? "side question · read-only · not in context"
							: "side question · read-only · not in context · ctrl+o expands",
					),
				);
				return out;
			},
			invalidate: () => {},
		};
	});

	/**
	 * Build the side session once, seeded with the main transcript.
	 *
	 * Returns `undefined` only when there is no usable model; a failure to read the main
	 * transcript is reported and the question still runs, just without that context.
	 */
	const ensureSideSession = async (
		ctx: ExtensionCommandContext,
		resolution: ModelResolution,
	): Promise<AgentSession | undefined> => {
		if (sideSession) return sideSession;
		const model = resolution.configured ? resolution.model : ctx.model;
		if (!model) {
			notify(ctx, "No model selected. Pick one with /model first.", "error");
			return undefined;
		}

		const resourceLoader = createSideResourceLoader(ctx);
		await resourceLoader.reload();

		// Seed the journal, not agent state: createAgentSession restores messages from a
		// non-empty session manager itself, and compaction rebuilds re-read the journal.
		const sessionManager = SessionManager.inMemory(ctx.cwd);
		const seed = seedMessages(ctx);
		for (const message of seed.messages) sessionManager.appendMessage(message);
		// A silent empty seed looks identical to "the side agent forgot everything", so say so.
		if (seed.failure) {
			notify(ctx, `/btw is running without the session transcript: ${seed.failure}`, "warning");
		}

		const created = await createAgentSession({
			model,
			thinkingLevel:
				resolution.configured && resolution.thinking ? resolution.thinking : (ctx.thinkingLevel ?? "medium"),
			tools: SIDE_TOOLS,
			sessionManager,
			resourceLoader,
			// In-memory settings so the side session never touches the user's settings.json.
			settingsManager: SettingsManager.inMemory(),
		});

		sideSession = created.session;
		return sideSession;
	};

	/** Ask one question in the side session and stream its answer into `exchange`. */
	const ask = async (
		ctx: ExtensionCommandContext,
		exchange: Exchange,
		resolution: ModelResolution,
	): Promise<void> => {
		const session = await ensureSideSession(ctx, resolution);
		if (!session) return;

		if (!sideSubscribed) {
			session.subscribe((event) => {
				const current = panel?.exchanges[panel.exchanges.length - 1];
				if (!current) return;
				if (event.type === "message_update" && event.message.role === "assistant") {
					current.answer = textOf(event.message);
					panel?.component.touch();
				} else if (event.type === "tool_execution_start") {
					current.toolName = event.toolName;
					panel?.component.touch();
				} else if (event.type === "tool_execution_end") {
					current.toolName = null;
					panel?.component.touch();
				}
			});
			sideSubscribed = true;
		}

		// A pinned model is never re-synced to the main session; an unpinned one follows it.
		const target = resolution.configured ? resolution.model : ctx.model;
		try {
			if (target && (session.model?.provider !== target.provider || session.model?.id !== target.id)) {
				await session.setModel(target);
			}
			session.setThinkingLevel(
				resolution.configured && resolution.thinking ? resolution.thinking : (ctx.thinkingLevel ?? "medium"),
			);
		} catch {
			// Keep whatever the side session already uses.
		}

		try {
			await session.prompt(exchange.question);
		} catch (error) {
			exchange.toolName = null;
			exchange.error = errorMessage(error);
			return;
		}

		exchange.toolName = null;

		// `prompt()` resolves normally even when the run was aborted, so read the outcome
		// from the last assistant message instead of guessing from an empty answer.
		const last = [...session.messages].reverse().find((message) => message.role === "assistant");
		if (last && last.role === "assistant" && last.stopReason === "aborted") {
			exchange.aborted = true;
		} else if (last && last.role === "assistant" && last.stopReason === "error") {
			exchange.error = last.errorMessage ?? "The side agent returned an error.";
		}

		if (!exchange.answer.trim() && !exchange.error && !exchange.aborted) {
			exchange.error = "The side agent returned an empty answer.";
		}
		exchange.answer = stripToolCallText(exchange.answer);
	};

	const attachKeys = (ctx: ExtensionCommandContext): (() => void) =>
		ctx.ui.onTerminalInput((data) => {
			const current = panel;
			if (!current) return undefined;

			// Never steal keys while the user is typing a real prompt.
			if (ctx.ui.getEditorText().trim().length > 0) return undefined;

			if (matchesKey(data, "escape")) {
				if (current.component.navigationMode) {
					current.component.setNavigationMode(false);
					return { consume: true };
				}
				closePanel();
				return { consume: true };
			}
			if (matchesKey(data, "tab")) {
				current.component.setNavigationMode(true);
				return { consume: true };
			}
			if (!current.component.navigationMode) return undefined;

			if (matchesKey(data, "up")) {
				current.component.scrollBy(1);
				return { consume: true };
			}
			if (matchesKey(data, "down")) {
				current.component.scrollBy(-1);
				return { consume: true };
			}
			if (matchesKey(data, "pageUp")) {
				current.component.scrollBy(10);
				return { consume: true };
			}
			if (matchesKey(data, "pageDown")) {
				current.component.scrollBy(-10);
				return { consume: true };
			}
			if (matchesKey(data, "shift+left")) {
				current.component.browseBy(-1);
				return { consume: true };
			}
			if (matchesKey(data, "shift+right")) {
				current.component.browseBy(1);
				return { consume: true };
			}
			if (matchesKey(data, "c")) {
				void (async () => {
					const text = current.exchanges
						.map((e) => e.answer.trim())
						.filter(Boolean)
						.join("\n\n");
					if (!text) {
						notify(ctx, "Nothing to copy yet", "warning");
						return;
					}
					try {
						await copyToClipboard(text);
						notify(ctx, "Copied side answer");
					} catch (error) {
						notify(ctx, `Copy failed: ${error instanceof Error ? error.message : String(error)}`, "error");
					}
				})();
				return { consume: true };
			}
			if (matchesKey(data, "x")) {
				current.exchanges.length = 0;
				current.component.touch();
				notify(ctx, "Cleared side question history");
				return { consume: true };
			}
			if (matchesKey(data, "f")) {
				void branchHere(ctx);
				return { consume: true };
			}
			return undefined;
		});

	/**
	 * `f`: branch the conversation and move into the branch. The branch is a real session,
	 * so the side answer comes along; the original is untouched and reachable with `/resume`.
	 */
	const branchHere = async (ctx: ExtensionCommandContext): Promise<void> => {
		const current = panel;
		if (!current) return;
		const shown = current.exchanges[current.exchanges.length - 1];
		if (!shown?.answer) return;

		const sessionFile = ctx.sessionManager.getSessionFile();
		const leafId = ctx.sessionManager.getLeafId();
		if (!sessionFile || !leafId) {
			notify(ctx, "Cannot branch before the first conversation turn", "warning");
			return;
		}

		// Snapshot before the switch: everything here dies with the old runtime.
		const originalId = ctx.sessionManager.getSessionId();
		const exchanges = current.exchanges.filter((e) => e.answer.trim() || e.error || e.aborted);
		const modelLabel = current.model;
		const question = shown.question;
		const answer = shown.answer;

		notify(ctx, "Branching…");
		try {
			const manager = SessionManager.open(sessionFile);
			const forkedPath = manager.createBranchedSession(leafId);
			if (!forkedPath) {
				notify(ctx, "Could not branch the conversation", "error");
				return;
			}

			const branch = SessionManager.open(forkedPath);
			branch.appendCustomMessageEntry<BtwEntryData>(ENTRY_TYPE, answer, true, { model: modelLabel, exchanges });
			branch.appendSessionInfo(`${BRANCH_PREFIX}${originalId} · ${question.slice(0, 48)}`);

			panel = undefined;
			current.busy.value = false;
			current.unsubscribe?.();
			current.ctx.ui.setWidget(WIDGET_KEY, undefined);
			current.ctx.ui.setWorkingMessage();

			await ctx.switchSession(forkedPath, {
				withSession: async (fresh) => {
					fresh.ui.notify(`Branched to a new session. Use /resume ${originalId} to go back.`, "info");
				},
			});
		} catch (error) {
			notify(ctx, `Failed to branch: ${error instanceof Error ? error.message : String(error)}`, "error");
		}
	};

	/** Session id recorded in a btw branch name, or undefined outside a branch. */
	const branchOrigin = (name: string | undefined): string | undefined => {
		if (!name?.startsWith(BRANCH_PREFIX)) return undefined;
		const id = name.slice(BRANCH_PREFIX.length).trim().split(" · ")[0]?.trim();
		return id || undefined;
	};

	/** Inside a btw branch: jump back to the session it was branched from. */
	const returnToOrigin = async (ctx: ExtensionCommandContext): Promise<boolean> => {
		const originId = branchOrigin(ctx.sessionManager.getSessionName());
		if (!originId) return false;

		notify(ctx, `Returning to ${originId}…`);
		try {
			await ctx.switchSession(originId, {
				withSession: async (fresh) => {
					fresh.ui.notify("Back in the original session", "info");
				},
			});
		} catch (error) {
			notify(
				ctx,
				`Could not switch back automatically. Use /resume. ${error instanceof Error ? error.message : String(error)}`,
				"warning",
			);
		}
		return true;
	};

	/** Ask a side question. Never forks, never switches session, never touches the main run. */
	const askSide = async (ctx: ExtensionCommandContext, question: string): Promise<void> => {
		// Re-read btw.json on every ask so edits apply without a restart. A broken config is
		// reported and the question is dropped; it never silently falls back to another model.
		let resolution: ModelResolution;
		try {
			resolution = readModelResolution(ctx);
		} catch (error) {
			notify(ctx, errorMessage(error), "error");
			return;
		}

		const model = resolution.configured ? resolution.model : ctx.model;
		if (!model) {
			notify(ctx, "No model selected. Pick one with /model first.", "error");
			return;
		}

		const exchange: Exchange = { question, answer: "", toolName: null };
		const label = `${model.provider}/${model.id}`;

		// Reuse an open panel so follow-ups continue the same side thread.
		if (panel) {
			panel.exchanges.push(exchange);
			capHistory(panel.exchanges);
			panel.busy.value = true;
			panel.component.touch();
			try {
				await ask(ctx, exchange, resolution);
			} finally {
				panel && (panel.busy.value = false);
				panel?.component.touch();
			}
			return;
		}

		const exchanges: Exchange[] = [exchange];
		const busy = { value: true };
		const component = new BtwPanel(ctx.ui.theme, exchanges, label, busy);
		panel = { component, exchanges, busy, ctx, model: label };

		ctx.ui.setWidget(
			WIDGET_KEY,
			(tui) => {
				component.tui = tui;
				component.startTicking();
				return component;
			},
			{ placement: "aboveEditor" },
		);
		panel.unsubscribe = attachKeys(ctx);

		try {
			await ask(ctx, exchange, resolution);
		} finally {
			if (panel?.component === component) {
				busy.value = false;
				component.touch();
			}
		}
	};

	pi.registerCommand("btw", {
		description: "Ask a side question without disturbing the running agent",
		handler: async (args, ctx: ExtensionCommandContext) => {
			const question = args.trim();
			if (question) {
				await askSide(ctx, question);
				return;
			}
			if (closePanel()) return;
			if (await returnToOrigin(ctx)) return;
			notify(ctx, "Usage: /btw <question>");
		},
	});

	for (const key of ["ctrl+shift+b", "f2"] as const) {
		pi.registerShortcut(key, {
			description: "Close a running /btw side question",
			handler: async (ctx) => {
				if (closePanel()) return;
				notify(ctx, "Nothing open. Ask with /btw <question>");
			},
		});
	}
}
