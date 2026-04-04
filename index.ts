/**
 * pi-mnemosyne — Local persistent memory for the pi AI agent.
 *
 * Gives the agent memory that persists across sessions using Mnemosyne,
 * a local document store with hybrid search (BM25 + vector similarity).
 * All ML inference runs locally via ONNX Runtime. No cloud APIs required.
 *
 * Features:
 * - Core memories (tagged `core`) injected into the system prompt at session start
 * - memory_recall / memory_recall_global tools for on-demand search
 * - memory_store / memory_store_global tools with optional `core` tagging
 * - memory_delete tool for removing outdated memories
 * - Cache invalidation: core memory cache refreshed only when dirty
 */

import * as path from "node:path";
import * as fs from "node:fs";
import type {ExtensionAPI} from "@mariozechner/pi-coding-agent";
import {Type} from "@sinclair/typebox";

export default function mnemosyneExtension(pi: ExtensionAPI): void {
	let projectName = "";
	let projectCwd = "";

	// ── Debug support ────────────────────────────────────────────────
	let debugEnabled = false;
	const debugLog: string[] = [];

	function debug(message: string): void {
		const timestamp = new Date().toISOString();
		const line = `[${timestamp}] ${message}`;
		debugLog.push(line);
		if (debugEnabled) {
			try {
				const debugPath = path.join(projectCwd || ".", ".mnemosyne-debug.log");
				fs.appendFileSync(debugPath, line + "\n", "utf-8");
			} catch { /* best effort */ }
		}
	}

	function writeDebugPrompt(fullPrompt: string): void {
		if (!debugEnabled) return;
		try {
			const debugInfo = [
				"=== Mnemosyne Debug Info ===",
				`Timestamp: ${new Date().toISOString()}`,
				`Project Name: ${projectName}`,
				`Project CWD: ${projectCwd}`,
				`Cache Valid: ${cacheValid}`,
				`Cached Core Block Length: ${cachedCoreBlock.length}`,
				`Debug Log (last 50 entries):`,
				...debugLog.slice(-50),
				"",
				"=== System Prompt ===",
				fullPrompt,
			].join("\n");
			fs.writeFileSync(
				path.join(projectCwd, ".mnemosyne-debug-prompt.txt"),
				debugInfo,
				"utf-8",
			);
		} catch { /* best effort */ }
	}

	// ── Core memory cache ─────────────────────────────────────────────
	let cachedCoreBlock = "";
	let cacheValid = false;

	// ── Helper: execute mnemosyne CLI ─────────────────────────────────

	async function mnemosyne(...args: string[]): Promise<string> {
		debug(`exec: mnemosyne ${args.join(" ")}`);
		try {
			const result = await pi.exec("mnemosyne", args, { cwd: projectCwd });
			debug(`exec result: code=${result.code} stdout=${result.stdout.length}bytes stderr=${result.stderr.length}bytes`);

			if (result.code !== 0) {
				const errMsg = result.stderr.trim() || `mnemosyne ${args[0]} failed (exit ${result.code})`;
				// Exit code 127 = command not found in shell
				if (result.code === 127 || errMsg.includes("not found") || errMsg.includes("ENOENT") || errMsg.includes("No such file")) {
					debug(`ERROR: mnemosyne binary not found`);
					return "Error: mnemosyne binary not found. Install it: https://github.com/gandazgul/mnemosyne#quick-start";
				}
				debug(`ERROR: ${errMsg}`);
				throw new Error(errMsg);
			}

			// mnemosyne writes output to stderr, use whichever has content
			return result.stdout || result.stderr;
		} catch (e: unknown) {
			const msg = e instanceof Error ? e.message : String(e);
			debug(`CATCH: ${msg}`);
			if (
				msg.includes("not found") ||
				msg.includes("ENOENT") ||
				msg.includes("No such file")
			) {
				return "Error: mnemosyne binary not found. Install it: https://github.com/gandazgul/mnemosyne#quick-start";
			}
			throw e;
		}
	}

	// ── Helper: fetch and format core memories ────────────────────────

	async function fetchCoreMemories(): Promise<string> {
		debug(`fetchCoreMemories: projectName=${projectName}, cwd=${projectCwd}`);
		const sections: string[] = [];

		// Fetch project core memories
		try {
			const localCore = await mnemosyne(
				"list", "--name", projectName, "--tag", "core", "--format", "plain",
			);
			const trimmed = localCore.trim();
			debug(`project core: ${trimmed.length} chars, starts with: ${JSON.stringify(trimmed.substring(0, 80))}`);
			if (trimmed && !trimmed.startsWith("No documents")) {
				sections.push(`Project Core Memories (${projectName}):\n\n${trimmed}`);
			}
		} catch (e) {
			debug(`project core error: ${e instanceof Error ? e.message : String(e)}`);
		}

		// Fetch global core memories
		try {
			const globalCore = await mnemosyne(
				"list", "--global", "--tag", "core", "--format", "plain",
			);
			const trimmed = globalCore.trim();
			debug(`global core: ${trimmed.length} chars, starts with: ${JSON.stringify(trimmed.substring(0, 80))}`);
			if (trimmed && !trimmed.startsWith("No documents")) {
				sections.push(`Global Core Memories:\n\n${trimmed}`);
			}
		} catch (e) {
			debug(`global core error: ${e instanceof Error ? e.message : String(e)}`);
		}

		const memoriesBlock = sections.length > 0
			? `\n\n${sections.join("\n\n")}`
			: "";

		return `\n\n${memoriesBlock}

When to use memory:
- Search memory when past context would help answer the user's request.
- Store concise summaries of important decisions, preferences, and patterns.
- Delete outdated memories when new decisions contradict them.
- Use **core** for facts that should always be in context (project architecture, key conventions, user preferences).
- Use **global** variants for cross-project preferences (coding style, tool choices).
- At the end of a session, store any relevant memories for future sessions.`;
	}

	// ── Helper: refresh cache if needed ───────────────────────────────

	async function ensureCacheValid(): Promise<void> {
		if (cacheValid) return;
		cachedCoreBlock = await fetchCoreMemories();
		cacheValid = true;
	}

	function invalidateCache(): void {
		cacheValid = false;
	}

	// ── Session start: init collection + load core memories ──────────

	pi.on("session_start", async (_event, ctx) => {
		projectCwd = ctx.cwd;

		// Check for debug flag file
		try {
			fs.accessSync(path.join(projectCwd, ".mnemosyne-debug"));
			debugEnabled = true;
			// Clear previous debug log file
			try { fs.writeFileSync(path.join(projectCwd, ".mnemosyne-debug.log"), "", "utf-8"); } catch { /* ok */ }
		} catch {
			debugEnabled = false;
		}

		debug(`session_start: cwd=${projectCwd}, debugEnabled=${debugEnabled}`);

		// Resolve project name from cwd basename
		const rawName = path.basename(projectCwd);
		projectName = rawName === "global" ? "default" : (rawName || "default");

		debug(`project: name=${projectName}`);

		// Auto-init the project collection (idempotent)
		try {
			await mnemosyne("init", "--name", projectName);
		} catch (e) {
			debug(`init error: ${e instanceof Error ? e.message : String(e)}`);
		}

		// Pre-fetch core memories
		invalidateCache();
		await ensureCacheValid();
		debug(`session_start complete: cacheValid=${cacheValid}, coreBlockLength=${cachedCoreBlock.length}`);
	});

	// ── Before agent start: inject core memories into system prompt ──

	pi.on("before_agent_start", async (event) => {
		await ensureCacheValid();

		const fullPrompt = event.systemPrompt + cachedCoreBlock;

		debug(`before_agent_start: systemPrompt=${event.systemPrompt.length}chars, coreBlock=${cachedCoreBlock.length}chars, total=${fullPrompt.length}chars`);
		writeDebugPrompt(fullPrompt);

		return {
			systemPrompt: fullPrompt,
		};
	});

	// ── Tools ─────────────────────────────────────────────────────────

	pi.registerTool({
		name: "memory_recall",
		label: "Memory Recall",
		description:
			"Search project memory for relevant context, past decisions, and preferences. Use this at the start of conversations and whenever past context would help.",
		promptSnippet: "Search project memory for past context and decisions",
		parameters: Type.Object({
			query: Type.String({ description: "Semantic search query" }),
		}),

		async execute(_toolCallId, params) {
			// Quote the query to prevent SQLite FTS errors with hyphens and special characters
			const safeQuery = `"${params.query.replaceAll('"', '""')}"`;
			const result = await mnemosyne(
				"search", "--name", projectName, "--format", "plain", safeQuery,
			);
			return {
				content: [{ type: "text", text: result.trim() || "No memories found." }],
			};
		},
	});

	pi.registerTool({
		name: "memory_recall_global",
		label: "Memory Recall Global",
		description:
			"Search global memory for cross-project preferences, decisions and patterns.",
		promptSnippet: "Search global memory for cross-project preferences",
		parameters: Type.Object({
			query: Type.String({ description: "Semantic search query" }),
		}),

		async execute(_toolCallId, params) {
			const safeQuery = `"${params.query.replaceAll('"', '""')}"`;
			const result = await mnemosyne(
				"search", "--global", "--format", "plain", safeQuery,
			);
			return {
				content: [{ type: "text", text: result.trim() || "No global memories found." }],
			};
		},
	});

	pi.registerTool({
		name: "memory_store",
		label: "Memory Store",
		description:
			"Store a project memory: a decision, preference, or important context. One concise concept per memory. Set core=true for critical context that should always be available in every session (use sparingly).",
		promptSnippet: "Store a project-scoped memory (decision, preference, context)",
		promptGuidelines: [
			"Use memory_store to save important decisions, preferences, and context for future sessions.",
			"Set core=true only for critical, always-relevant context (like project architecture or key conventions). Core memories are injected into every prompt, so keep them lean.",
		],
		parameters: Type.Object({
			content: Type.String({ description: "Concise memory to store" }),
			core: Type.Optional(Type.Boolean({
				description: "If true, this memory is always injected into context (like AGENTS.md). Use sparingly.",
			})),
		}),

		async execute(_toolCallId, params) {
			const args = ["add", "--name", projectName];
			if (params.core) {
				args.push("--tag", "core");
			}
			args.push(params.content);

			const result = await mnemosyne(...args);

			if (params.core) {
				invalidateCache();
			}

			return {
				content: [{ type: "text", text: result.trim() }],
			};
		},
	});

	pi.registerTool({
		name: "memory_store_global",
		label: "Memory Store Global",
		description:
			"Store a cross-project memory: personal preferences, coding style, tool choices. Set core=true for critical cross-project context that should always be available.",
		promptSnippet: "Store a cross-project memory (coding style, tool choices)",
		parameters: Type.Object({
			content: Type.String({ description: "Global memory to store" }),
			core: Type.Optional(Type.Boolean({
				description: "If true, this memory is always injected into context. Use sparingly.",
			})),
		}),

		async execute(_toolCallId, params) {
			// Ensure the global collection exists
			try {
				await mnemosyne("init", "--global");
			} catch {
				// Already exists — fine
			}

			const args = ["add", "--global"];
			if (params.core) {
				args.push("--tag", "core");
			}
			args.push(params.content);

			const result = await mnemosyne(...args);

			if (params.core) {
				invalidateCache();
			}

			return {
				content: [{ type: "text", text: result.trim() }],
			};
		},
	});

	pi.registerTool({
		name: "memory_delete",
		label: "Memory Delete",
		description:
			"Delete an outdated or incorrect memory by its document ID (shown in [brackets] in recall/list results).",
		promptSnippet: "Delete an outdated memory by document ID",
		parameters: Type.Object({
			id: Type.Number({ description: "Document ID to delete" }),
		}),

		async execute(_toolCallId, params) {
			const result = await mnemosyne("delete", String(params.id));

			// Invalidate cache since we don't know if the deleted memory was core
			invalidateCache();

			return {
				content: [{ type: "text", text: result.trim() }],
			};
		},
	});
}
