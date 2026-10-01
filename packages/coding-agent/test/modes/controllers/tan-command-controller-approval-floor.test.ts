import { describe, expect, it, vi } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { AgentToolContext } from "@oh-my-pi/pi-agent-core";
import { getBundledModel } from "@oh-my-pi/pi-catalog/models";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { TanCommandController } from "@oh-my-pi/pi-coding-agent/modes/controllers/tan-command-controller";
import type { InteractiveModeContext } from "@oh-my-pi/pi-coding-agent/modes/types";
import { AgentRegistry } from "@oh-my-pi/pi-coding-agent/registry/agent-registry";
import * as sdkModule from "@oh-my-pi/pi-coding-agent/sdk";
import { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { removeSyncWithRetries } from "@oh-my-pi/pi-utils";

const realCreateAgentSession = sdkModule.createAgentSession;

type JobRun = (context: {
	jobId: string;
	signal: AbortSignal;
	reportProgress: (text: string, details?: Record<string, unknown>) => Promise<void>;
}) => Promise<string>;

async function exerciseTan(floor: "always-ask" | undefined): Promise<void> {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "omp-tan-floor-"));
	const cwd = path.join(root, "workspace");
	const agentDir = path.join(root, "agent");
	fs.mkdirSync(cwd, { recursive: true });
	fs.mkdirSync(agentDir, { recursive: true });
	const authStorage = await AuthStorage.create(":memory:");
	const settings = Settings.isolated({
		"async.enabled": false,
		"autolearn.enabled": false,
		"compaction.enabled": false,
		"secrets.enabled": false,
		"task.enableLsp": false,
		"tools.approvalMode": "yolo",
		"tools.approval": { write: "allow" },
	});
	const model = getBundledModel("openai", "gpt-4o-mini");
	if (!model) throw new Error("Missing bundled test model");
	const modelRegistry = new ModelRegistry(authStorage, path.join(agentDir, "models.yml"), {
		settings,
		cacheDbPath: path.join(agentDir, "models.db"),
		fetch: async () => {
			throw new Error("Network is forbidden in this test");
		},
	});
	const parentManager = SessionManager.create(cwd, path.join(root, "sessions"));
	parentManager.appendMessage({ role: "user", content: "Parent context", timestamp: Date.now() });
	const registry = new AgentRegistry();
	const registrySpy = vi.spyOn(AgentRegistry, "global").mockReturnValue(registry);
	let run: JobRun | undefined;
	let childId: string | undefined;
	let probeFinished = false;
	let restorePrompt: (() => void) | undefined;
	const markers = floor
		? [path.join(cwd, "blocked-ordinary.txt"), path.join(cwd, "blocked-granted.txt")]
		: [path.join(cwd, "written.txt")];
	const payload = "tan write reached the filesystem\n";
	const factorySpy = vi.spyOn(sdkModule, "createAgentSession").mockImplementation(async options => {
		if (!options) throw new Error("Tan did not provide child options");
		childId = options.agentId;
		const created = await realCreateAgentSession({
			...options,
			agentDir,
			restrictToolNames: true,
			skipPythonPreflight: true,
			skills: [],
			rules: [],
			contextFiles: [],
			promptTemplates: [],
			slashCommands: [],
			workspaceTree: { rootPath: cwd, rendered: ".\n", truncated: false, totalLines: 1, agentsMdFiles: [] },
		});
		const promptSpy = vi.spyOn(created.session, "prompt").mockImplementation(async () => {
			const write = created.session.getToolByName("write");
			if (!write) throw new Error("Real child did not install write");
			for (const [index, marker] of markers.entries()) {
				const args = { path: marker, content: payload };
				const context = index === 1
					? ({ settings: options.settings, autoApprove: true, xdevApproved: true, acpApprovedArgs: args } as AgentToolContext)
					: undefined;
				const execution = write.execute(`tan-floor-write-${index}`, args, undefined, undefined, context);
				if (floor) {
					await expect(execution).rejects.toThrow();
					expect(fs.existsSync(marker)).toBe(false);
				} else {
					await execution;
					expect(fs.readFileSync(marker, "utf8")).toBe(payload);
				}
			}
			probeFinished = true;
			return true;
		});
		restorePrompt = () => promptSpy.mockRestore();
		return created;
	});
	const ctx = {
		settings,
		sessionManager: parentManager,
		session: {
			model,
			modelRegistry,
			sessionId: parentManager.getSessionId(),
			agent: { promptCacheKey: undefined },
			isStreaming: false,
			asyncJobManager: {
				register: (_type: string, _label: string, callback: JobRun) => {
					run = callback;
					return "tan-floor-job";
				},
			},
			configuredThinkingLevel: () => undefined,
			systemPrompt: ["Isolated approval regression"],
			getEnabledToolNames: () => ["write"],
			getAgentId: () => "approval-test-parent",
			getApprovalFloor: () => floor,
			sendCustomMessage: async () => {},
		},
		showStatus: () => {},
		showWarning: () => {},
		showError: (message: string) => {
			throw new Error(message);
		},
		rebuildChatFromMessages: () => {},
	} as unknown as InteractiveModeContext;
	try {
		await new TanCommandController(ctx).start("Write the isolated marker");
		if (!run) throw new Error("Tan did not register its job");
		await run({ jobId: "tan-floor-job", signal: new AbortController().signal, reportProgress: async () => {} });
		if (!probeFinished) throw new Error("Tan never executed the tool probe");
		for (const marker of markers) {
			if (floor) expect(fs.existsSync(marker)).toBe(false);
			else expect(fs.readFileSync(marker, "utf8")).toBe(payload);
		}
	} finally {
		restorePrompt?.();
		if (childId) registry.unregister(childId);
		factorySpy.mockRestore();
		registrySpy.mockRestore();
		await parentManager.close();
		authStorage.close();
		removeSyncWithRetries(root);
	}
}

describe("Tan child approval floor", () => {
	it("blocks an inherited always-ask floor despite caller approval grants", async () => {
		await exerciseTan("always-ask");
	}, 30_000);

	it("permits the same child write without a parent floor", async () => {
		await exerciseTan(undefined);
	}, 30_000);
});
