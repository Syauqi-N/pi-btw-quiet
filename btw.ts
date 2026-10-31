/**
 * /btw — ask a side question without disturbing the running agent.
 *
 * A side question is NOT a fork. It is a separate model call that receives the session
 * transcript as read-only context, so the main conversation keeps running, keeps its own
 * model call, and is never branched, aborted, or modified.
 *
 * The panel is non-modal and never takes focus: you can keep typing into the main editor
 * while the side answer streams. Panel keys are opt-in (press tab) so the first letter of
 * a normal prompt is never mistaken for a panel command.
 *
 * Usage:
 *   /btw <question>     ask a side question (also works while the main agent streams)
 *   /btw                close the panel, or leave a btw branch
 *   ctrl+shift+b / f2   same as /btw with no question
 *
 * Panel keys, only while the editor is empty so typing is never stolen:
 *   tab                   enter panel key mode
 *   ↑ / ↓ / pgup / pgdn   scroll
 *   shift+← / shift+→     browse earlier side questions
 *   c                     copy        x  clear history
 *   f                     branch the conversation here
 *   esc                   leave key mode, then close
 */

import type { Api, AssistantMessage, Message, Model } from "@earendil-works/pi-ai";
import {
	convertToLlm,
	copyToClipboard,
	getMarkdownTheme,
	sessionEntryToContextMessages,
	type ExtensionAPI,
	type ExtensionCommandContext,
	type ExtensionContext,
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
/** Prefix for a btw branch's session name, holding the session it was branched from. */
const BRANCH_PREFIX = "btw:";
const MAX_CONTEXT_CHARS = 600_000;
const MAX_PANEL_ROWS = 16;
/** How many previous side questions the panel remembers (Claude Code keeps 5). */
const MAX_HISTORY = 5;

interface Exchange {
	question: string;
	answer: string;
	error?: string;
}

interface BtwEntryData {
	model: string;
	exchanges: Exchange[];
}

const sideSystemPrompt = (cwd: string, hasTranscript: boolean): string =>
	[
		'You are answering a side question ("/btw") about an ongoing coding session.',
		"",
		hasTranscript
			? "The conversation below is the user's real session with another assistant. You are a separate, read-only helper."
			: "The session has no messages yet, so you have no transcript. Answer from general knowledge and say so if it matters.",
		"",
		"CRITICAL CONSTRAINTS:",
		"- You have NO tools available. You cannot read files, run commands, search, or take any action.",
		"- Do NOT write tool calls or tool output as text (for example invoke, function_calls, or DSML blocks). Nothing you write here is executed.",
		"- This is a one-off response: there is no follow-up turn.",
		"- You can only use information already present in the conversation below.",
		'- NEVER say "Let me check", "I will now", "Let me try", or promise any action.',
		"- If answering needs reading files, running commands, or searching, say it cannot be checked from a side question and suggest asking in the main conversation.",
		"",
		"Other rules:",
		"- Answer directly and concisely: 1-6 sentences unless the user asks for detail.",
		"- Ground the answer in the conversation below and cite concrete files, commands, errors, and decisions when relevant.",
		"- If the question implies a change, explain what you would do and where, without claiming to have done it.",
		"- Reply in the language the user used.",
		"- Never tell the user to re-send or re-run the main task.",
		"",
		`Working directory: ${cwd}`,
	].join("\n");

/**
 * Detect and strip tool calls the model wrote as *text*.
 *
 * A side question has no tools, but models still sometimes emit their native tool-call
 * syntax: DeepSeek's `<｜｜DSML｜｜invoke>`, Anthropic's `<function_calls>`/`<invoke>`,
 * or generic `<tool_use>` blocks. Claude Code handles this by replacing the answer with a
 * fixed note; we strip the blocks and append the same kind of note, so the user sees a
 * clean answer instead of markup.
 */
const TOOL_CALL_TEXT = new RegExp(
	[
		// DeepSeek / Hermes DSML, with or without the full-width pipes.
		"<[\\s]*[｜|]{1,2}[\\s]*DSML[\\s]*[｜|]{1,2}[\\s]*(?:calls?|invoke|parameter)>",
		"</[\\s]*[｜|]{1,2}[\\s]*DSML[\\s]*[｜|]{1,2}[\\s]*(?:calls?|invoke|parameter)>",
		// Anthropic-style and generic function-call blocks.
		"<\\/?(?:antml:)?(?:function_calls|invoke|parameter)\\b[^>]*>",
		"<\\/?tool_use\\b[^>]*>",
	].join("|"),
	"i",
);

const TOOL_CALL_NOTE =
	"_/btw can't run tools: any tool calls or tool output shown above were not executed. Ask in the main conversation to check._";

const stripToolCallText = (answer: string): string => {
	if (!TOOL_CALL_TEXT.test(answer)) return answer;
	// Drop whole blocks first, then any stray marker left behind.
	const withoutBlocks = answer
		.replace(/<[\s]*[｜|]{1,2}[\s]*DSML[\s]*[｜|]{1,2}[\s]*calls?[\s]*>[\s\S]*?<[\s]*\/[\s]*[｜|]{1,2}[\s]*DSML[\s]*[｜|]{1,2}[\s]*calls?[\s]*>/gi, "")
		.replace(/<(?:antml:)?function_calls\b[^>]*>[\s\S]*?<\/(?:antml:)?function_calls>/gi, "")
		.replace(/<tool_use\b[^>]*>[\s\S]*?<\/tool_use>/gi, "")
		.replace(TOOL_CALL_TEXT, "");
	const cleaned = withoutBlocks.replace(/\n{3,}/g, "\n\n").trim();
	return cleaned ? `${cleaned}\n\n${TOOL_CALL_NOTE}` : TOOL_CALL_NOTE;
};

const textOf = (message: AssistantMessage): string =>
	message.content
		.filter((part): part is { type: "text"; text: string } => part.type === "text")
		.map((part) => part.text)
		.join("");

/** Session transcript as plain LLM messages, trimmed to a character budget. */
const buildContextMessages = (ctx: ExtensionContext): Message[] => {
	let messages: Message[];
	try {
		const entries = ctx.sessionManager.buildContextEntries();
		messages = convertToLlm(entries.flatMap((entry) => sessionEntryToContextMessages(entry)));
	} catch {
		return [];
	}

	const cleaned = messages.filter((message) => {
		if (message.role === "system") return false; // we supply our own system prompt
		if (message.role === "user" || message.role === "assistant") {
			return typeof message.content === "string"
				? message.content.trim().length > 0
				: message.content.length > 0;
		}
		return true;
	});

	const weight = (message: Message) => JSON.stringify(message.content).length;
	const total = cleaned.reduce((sum, message) => sum + weight(message), 0);
	if (total <= MAX_CONTEXT_CHARS) return cleaned;

	let start = 0;
	let remaining = total;
	while (start < cleaned.length && remaining > MAX_CONTEXT_CHARS) {
		remaining -= weight(cleaned[start]!);
		start++;
	}
	while (start < cleaned.length && cleaned[start]!.role !== "user") start++;
	return cleaned.slice(start);
};

const emptyUsage = () => ({
	input: 0,
	output: 0,
	cacheRead: 0,
	cacheWrite: 0,
	total: 0,
	totalTokens: 0,
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
});

const resolveModel = (ctx: ExtensionContext): { model: Model<Api> | undefined; label: string } => {
	const current = ctx.model;
	if (current) return { model: current, label: `${current.provider}/${current.id}` };
	const fallback = ctx.modelRegistry.getAvailable()[0];
	if (fallback) return { model: fallback, label: `${fallback.provider}/${fallback.id}` };
	return { model: undefined, label: "no model" };
};

/**
 * One side question: its own model call, main transcript as read-only context.
 * Request failures land on `exchange.error`; this never throws for them.
 */
const runSideQuestion = async (
	ctx: ExtensionContext,
	model: Model<Api>,
	reasoning: string | undefined,
	history: Message[],
	baseContext: Message[],
	exchange: Exchange,
	controller: AbortController,
	onUpdate: () => void,
): Promise<void> => {
	let finalMessage: AssistantMessage | undefined;
	try {
		const stream = ctx.modelRegistry.streamSimple(
			model,
			{
				systemPrompt: sideSystemPrompt(ctx.cwd, baseContext.length > 0),
				messages: [...baseContext, ...history],
			},
			{
				signal: controller.signal,
				reasoning: reasoning && reasoning !== "off" ? (reasoning as never) : undefined,
			},
		);

		for await (const event of stream) {
			switch (event.type) {
				case "text_delta":
					exchange.answer = textOf(event.partial);
					onUpdate();
					break;
				case "text_end":
					exchange.answer = textOf(event.partial);
					break;
				case "done":
					finalMessage = event.message;
					break;
				case "error":
					throw new Error(event.error.errorMessage || `request ${event.reason}`);
				default:
					break;
			}
		}

		if (finalMessage) exchange.answer = textOf(finalMessage) || exchange.answer;
		// Models without tools sometimes write the call as text; never show raw markup.
		exchange.answer = stripToolCallText(exchange.answer);
		if (!exchange.answer.trim()) throw new Error("The model returned an empty answer.");

		const assistant: Message =
			finalMessage && textOf(finalMessage).trim()
				? finalMessage
				: {
						role: "assistant",
						content: [{ type: "text", text: exchange.answer }],
						api: model.api,
						provider: model.provider,
						model: model.id,
						usage: emptyUsage(),
						stopReason: "stop",
						timestamp: Date.now(),
					};
		history.push(assistant);
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		if (controller.signal.aborted) {
			if (!exchange.answer.trim()) exchange.error = "cancelled";
		} else {
			exchange.error = message;
		}
	}
};

const SPINNER = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];

const elapsed = (startedAt: number): string => {
	const seconds = Math.max(0, Math.round((Date.now() - startedAt) / 1000));
	return seconds < 60 ? `${seconds}s` : `${Math.floor(seconds / 60)}m${seconds % 60}s`;
};

/**
 * Panel chrome, matching Claude Code: no box border, a `/btw` header, an indented answer,
 * and a dim key-hint row. Every row is painted so the transcript behind it never shows.
 */
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
const answerRows = (theme: Theme, exchange: Exchange, width: number, streaming: boolean): string[] => {
	const textWidth = Math.max(1, width - 2);
	const rows: string[] = [];
	if (exchange.answer) {
		for (const line of new Markdown(exchange.answer, 0, 0, getMarkdownTheme()).render(textWidth)) {
			rows.push(paint(theme, `  ${line}`));
		}
	} else if (streaming) {
		rows.push(paint(theme, `  ${theme.fg("dim", "…")}`));
	}
	if (exchange.error) {
		for (const line of wrapTextWithAnsi(exchange.error, textWidth)) {
			rows.push(paint(theme, `  ${theme.fg("error", line)}`));
		}
	}
	return rows;
};

/**
 * Live panel above the editor. It never takes focus: keys reach it through a terminal input
 * listener, and only while the main editor is empty, so typing is never stolen.
 */
class BtwPanel implements Component {
	focused = false;
	tui?: TUI;
	private readonly startedAt = Date.now();
	private ticker?: ReturnType<typeof setInterval>;
	private scroll = 0;
	private lastMaxScroll = 0;
	private browse: number | null = null;
	/**
	 * Panel keys are opt-in. Without this, the first letter of a normal prompt ("fix the
	 * bug…") would be eaten as the `f` fork command, which is exactly the bug where the
	 * session forked instead of the user typing.
	 */
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

	/** The exchange currently shown: the browsed one, else the newest. */
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

	/** Step through earlier side questions, like Claude Code's shift+←/→ browse. */
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
		const streaming = this.busyRef.value;
		if (!streaming) this.stopTicking();

		const rows = this.tui?.terminal.rows ?? 40;
		const maxRows = Math.max(4, Math.min(MAX_PANEL_ROWS, Math.floor(rows * 0.45)));

		const shown = this.shown();
		const all = shown ? answerRows(theme, shown, w, streaming && this.browse === null) : [];
		this.lastMaxScroll = Math.max(0, all.length - maxRows);
		this.scroll = Math.min(this.scroll, this.lastMaxScroll);

		const end = Math.max(0, all.length - this.scroll);
		const start = Math.max(0, end - maxRows);
		const visible = all.slice(start, end);

		const above = start;
		const below = Math.max(0, all.length - end);
		if (above > 0) visible[0] = paint(theme, theme.fg("dim", `  ↑ ${above} more line${above === 1 ? "" : "s"}`));
		if (below > 0) {
			visible[visible.length - 1] = paint(theme, theme.fg("dim", `  ↓ ${below} more line${below === 1 ? "" : "s"}`));
		}

		const frame = SPINNER[Math.floor(Date.now() / 120) % SPINNER.length] ?? SPINNER[0]!;
		const status = streaming ? `${frame} ${elapsed(this.startedAt)}` : undefined;

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
			: streaming
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

export default function btwExtension(pi: ExtensionAPI) {
	let panel:
		| {
				component: BtwPanel;
				exchanges: Exchange[];
				history: Message[];
				controller: AbortController;
				busy: { value: boolean };
				ctx: ExtensionCommandContext;
				model: string;
				unsubscribe?: () => void;
		  }
		| undefined;

	/** Write what the panel answered into the transcript, then drop the panel. */
	const closePanel = (): boolean => {
		if (!panel) return false;
		const current = panel;
		panel = undefined;
		current.controller.abort();
		current.busy.value = false;
		current.unsubscribe?.();
		current.ctx.ui.setWidget(WIDGET_KEY, undefined);
		current.ctx.ui.setWorkingMessage();

		const exchanges = current.exchanges.filter((e) => e.answer.trim() || e.error);
		if (exchanges.length > 0) {
			pi.appendEntry<BtwEntryData>(ENTRY_TYPE, { model: current.model, exchanges });
		}
		return true;
	};

	pi.on("session_shutdown", () => {
		panel?.controller.abort();
		panel?.unsubscribe?.();
		panel = undefined;
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
						expanded ? "side question · not in context" : "side question · not in context · ctrl+o expands",
					),
				);
				return out;
			},
			invalidate: () => {},
		};
	});

	/** `c`: copy the shown answer. */
	const copyShown = async (ctx: ExtensionCommandContext): Promise<void> => {
		const text = panel?.exchanges
			.map((e) => e.answer.trim())
			.filter(Boolean)
			.join("\n\n");
		if (!text) {
			ctx.ui.notify("Nothing to copy yet", "warning");
			return;
		}
		try {
			await copyToClipboard(text);
			ctx.ui.notify("Copied side answer", "info");
		} catch (error) {
			ctx.ui.notify(`Copy failed: ${error instanceof Error ? error.message : String(error)}`, "error");
		}
	};

	/**
	 * `f`: branch the conversation and move into the branch, like Claude Code's
	 * `branchAndResume` (`t.resume(sessionId, ..., "fork")`).
	 *
	 * The branch is a real session in the same terminal, seeded with the side question and
	 * its answer, so you can keep working from it. The original session is untouched and
	 * reachable again with `/resume`.
	 */
	const forkIntoBranch = async (ctx: ExtensionCommandContext): Promise<void> => {
		const current = panel;
		if (!current) return;
		const shown = current.exchanges[current.exchanges.length - 1];
		if (!shown?.answer) return;

		const sessionFile = ctx.sessionManager.getSessionFile();
		const leafId = ctx.sessionManager.getLeafId();
		if (!sessionFile || !leafId) {
			ctx.ui.notify("Cannot branch before the first conversation turn", "warning");
			return;
		}

		// Snapshot before the switch: everything here dies with the old runtime.
		const originalId = ctx.sessionManager.getSessionId();
		const originalName = ctx.sessionManager.getSessionName();
		const exchanges = current.exchanges.filter((e) => e.answer.trim() || e.error);
		const modelLabel = current.model;
		const question = shown.question;
		const answer = shown.answer;

		ctx.ui.notify("Branching…", "info");
		try {
			const { SessionManager } = await import("@earendil-works/pi-coding-agent");
			const manager = SessionManager.open(sessionFile);
			const forkedPath = manager.createBranchedSession(leafId);
			if (!forkedPath) {
				ctx.ui.notify("Could not branch the conversation", "error");
				return;
			}

			// Seed the branch with the side question so it is visible in the new session and
			// never replayed to the model.
			const branch = SessionManager.open(forkedPath);
			branch.appendCustomMessageEntry<BtwEntryData>(ENTRY_TYPE, answer, true, { model: modelLabel, exchanges });
			// The name carries the origin session so `/btw` can jump back in one step.
			branch.appendSessionInfo(`${BRANCH_PREFIX}${originalId} · ${question.slice(0, 48)}`);

			// Leave the panel behind; its content now lives in the branch.
			panel = undefined;
			current.controller.abort();
			current.busy.value = false;
			current.unsubscribe?.();
			current.ctx.ui.setWidget(WIDGET_KEY, undefined);
			current.ctx.ui.setWorkingMessage();

			await ctx.switchSession(forkedPath, {
				withSession: async (fresh) => {
					fresh.ui.notify(
						`Branched to a new session. Use /resume ${originalId}${originalName ? ` (${originalName})` : ""} to go back.`,
						"info",
					);
				},
			});
		} catch (error) {
			ctx.ui.notify(`Failed to branch: ${error instanceof Error ? error.message : String(error)}`, "error");
		}
	};

	/** Session id recorded in a btw branch name, or undefined outside a branch. */
	const branchOrigin = (name: string | undefined): string | undefined => {
		if (!name?.startsWith(BRANCH_PREFIX)) return undefined;
		const rest = name.slice(BRANCH_PREFIX.length).trim();
		const id = rest.split(" · ")[0]?.trim();
		return id || undefined;
	};

	/**
	 * Inside a btw branch: jump back to the session it was branched from.
	 * Mirrors Claude Code telling the user `/resume <original>` after a fork.
	 */
	const returnToOrigin = async (ctx: ExtensionCommandContext): Promise<boolean> => {
		const originId = branchOrigin(ctx.sessionManager.getSessionName());
		if (!originId) return false;

		const sessionDir = ctx.sessionManager.getSessionDir();
		ctx.ui.notify(`Returning to ${originId}…`, "info");
		try {
			// pi resolves a partial session id against the session directory.
			await ctx.switchSession(originId, {
				withSession: async (fresh) => {
					fresh.ui.notify("Back in the original session", "info");
				},
			});
		} catch (error) {
			ctx.ui.notify(
				`Could not switch back automatically. Use /resume and pick the session in ${sessionDir}. ${
					error instanceof Error ? error.message : String(error)
				}`,
				"warning",
			);
		}
		return true;
	};

	/** `x`: forget the panel's history without touching the transcript. */
	const clearHistory = (ctx: ExtensionCommandContext): void => {
		if (!panel) return;
		panel.exchanges.length = 0;
		panel.history.length = 0;
		panel.component.touch();
		ctx.ui.notify("Cleared side question history", "info");
	};

	const attachKeys = (ctx: ExtensionCommandContext): (() => void) =>
		ctx.ui.onTerminalInput((data) => {
			const current = panel;
			if (!current) return undefined;

			// Never steal keys while the user is typing a real prompt.
			if (ctx.ui.getEditorText().trim().length > 0) return undefined;

			if (matchesKey(data, "escape")) {
				// In navigation mode, esc only leaves the panel's key mode.
				if (current.component.navigationMode) {
					current.component.setNavigationMode(false);
					return { consume: true };
				}
				// One esc closes the panel, aborting a question that is still streaming. The
				// abort is scoped to the side request, so the main agent is never interrupted.
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
				void copyShown(ctx);
				return { consume: true };
			}
			if (matchesKey(data, "f")) {
				void forkIntoBranch(ctx);
				return { consume: true };
			}
			if (matchesKey(data, "x")) {
				clearHistory(ctx);
				return { consume: true };
			}
			return undefined;
		});

	/** Ask a side question. Never forks, never switches session, never touches the main run. */
	const askSide = async (ctx: ExtensionCommandContext, question: string): Promise<void> => {
		const { model, label } = resolveModel(ctx);
		if (!model) {
			ctx.ui.notify("No model selected. Pick one with /model first.", "error");
			return;
		}

		// Reuse an open panel so follow-ups keep their own thread.
		const reuse = panel;
		const exchange: Exchange = { question, answer: "" };
		const controller = new AbortController();
		const busy = { value: true };

		if (reuse) {
			reuse.controller.abort();
			reuse.controller = controller;
			reuse.busy.value = true;
			reuse.exchanges.push(exchange);
			reuse.history.push({ role: "user", content: [{ type: "text", text: question }], timestamp: Date.now() });
			reuse.component.touch();

			await runSideQuestion(
				ctx,
				model,
				ctx.thinkingLevel,
				reuse.history,
				buildContextMessages(ctx),
				exchange,
				controller,
				() => reuse.component.touch(),
			);
			reuse.busy.value = false;
			reuse.component.touch();
			return;
		}

		const exchanges: Exchange[] = [exchange];
		// A closing assistant turn keeps the side question as its own message. Two
		// consecutive user messages get merged by providers, and the model then answers the
		// older one instead of the question that was just asked.
		const history: Message[] = [
			{
				role: "assistant",
				content: [{ type: "text", text: "(end of the main conversation)" }],
				api: model.api,
				provider: model.provider,
				model: model.id,
				usage: emptyUsage(),
				stopReason: "stop",
				timestamp: Date.now(),
			},
			{ role: "user", content: [{ type: "text", text: question }], timestamp: Date.now() },
		];
		const component = new BtwPanel(ctx.ui.theme, exchanges, label, busy);

		panel = { component, exchanges, history, controller, busy, ctx, model: label };

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

		await runSideQuestion(
			ctx,
			model,
			ctx.thinkingLevel,
			history,
			buildContextMessages(ctx),
			exchange,
			controller,
			() => component.touch(),
		);

		if (panel?.component !== component) return;
		busy.value = false;
		component.touch();
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
			// In a btw branch with no question: leave the branch.
			if (await returnToOrigin(ctx)) return;
			ctx.ui.notify("Usage: /btw <question>", "info");
		},
	});

	for (const key of ["ctrl+shift+b", "f2"] as const) {
		pi.registerShortcut(key, {
			description: "Close a running /btw side question",
			// Shortcut contexts have no session-control methods, so this only closes the
			// panel. Leaving a branch needs `/btw`, which does get a command context.
			handler: async (ctx) => {
				if (closePanel()) return;
				ctx.ui.notify("Nothing open. Ask with /btw <question>", "info");
			},
		});
	}
}
