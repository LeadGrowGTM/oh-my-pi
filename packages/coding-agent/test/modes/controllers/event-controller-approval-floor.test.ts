import { afterEach, beforeAll, describe, expect, it, vi } from "bun:test";
import { Type } from "@oh-my-pi/omptype/typebox";
import type { AgentTool } from "@oh-my-pi/pi-agent-core";
import { resetSettingsForTest, Settings, settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { EventController } from "@oh-my-pi/pi-coding-agent/modes/controllers/event-controller";
import type { AgentSessionEvent } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { cfgToolsApproval, cfgToolsApprovalMode } from "@oh-my-pi/pi-coding-agent/tools/settings";
import * as titleGenerator from "@oh-my-pi/pi-coding-agent/utils/title-generator";
import { initTheme } from "@oh-my-pi/pi-tui/theme";
import { createInteractiveModeContext } from "../../helpers/interactive-mode-context";

beforeAll(async () => {
	await initTheme();
});

afterEach(() => {
	vi.restoreAllMocks();
	resetSettingsForTest();
});

describe("interactive approval floor attention", () => {
	it("signals attention for a floor prompt despite yolo and per-tool allow, then returns to working", async () => {
		await Settings.init({ inMemory: true, cwd: process.cwd() });
		cfgToolsApprovalMode.override(settings, "yolo");
		cfgToolsApproval.override(settings, { bash: "allow" });
		const titleState = vi.spyOn(titleGenerator, "setTerminalTitleState").mockImplementation(() => {});
		const tool = {
			name: "bash",
			label: "Bash",
			description: "Execute command",
			parameters: Type.Object({ command: Type.String() }),
			strict: true,
			approval: "exec",
			execute: async () => ({ content: [{ type: "text" as const, text: "ok" }] }),
		} as AgentTool;
		const ctx = createInteractiveModeContext({
			viewSession: { getToolByName: () => tool, getApprovalFloor: () => "always-ask" },
		});
		const controller = new EventController(ctx);
		await controller.handleEvent({
			type: "tool_execution_start",
			toolCallId: "floor-bash",
			toolName: "bash",
			args: { command: "echo hello" },
		} as Extract<AgentSessionEvent, { type: "tool_execution_start" }>);
		expect(titleState).toHaveBeenCalledWith("attention");

		await controller.handleEvent({
			type: "tool_execution_end",
			toolCallId: "floor-bash",
			toolName: "bash",
			result: { content: [{ type: "text", text: "ok" }] },
			isError: false,
		} as Extract<AgentSessionEvent, { type: "tool_execution_end" }>);
		expect(titleState).toHaveBeenCalledWith("working");
	});
});
