import type { EditorView } from '@codemirror/view';

import { createNamedLogger } from '@/logging';
import {
	acceptReviewById,
	getReviewChunks,
	rejectReviewById,
} from '../extensions/codemirror/ReviewExtension';
import { fileStoreService } from './FileStoreService';
import { agentReviewHostRegistry } from './AgentReviewHostRegistry';
import { reviewService } from './ReviewService';
import {
	collectAnnotationTagRanges,
	stripAnnotationTags,
} from '../utils/annotationTagUtils';
import { isBinaryFile } from '../utils/fileUtils';

const moduleLog = createNamedLogger('AgentBridgeService');
const BRIDGE_PROTOCOL_VERSION = 1;

type BridgeMethod =
	| 'project.getContext'
	| 'project.listFiles'
	| 'document.readFile'
	| 'review.stageChangeSet'
	| 'review.applyChangeSet';

type BrowserToSidecarMethod =
	| 'review.setHunkDecision'
	| 'review.setFileDecision'
	| 'review.setAllDecision'
	| 'review.addFeedback';

interface BridgeRequest {
	version: number;
	id: string;
	projectId: string;
	method: BridgeMethod;
	params: Record<string, unknown>;
}

interface BridgeResponse {
	version: number;
	id: string;
	ok: boolean;
	result?: unknown;
	error?: { code: string; message: string; retryHint?: string };
}

interface AgentChangeHunk {
	id: string;
	oldText: string;
	newText: string;
	anchor: { start: number; end: number };
	status: string;
	nativeReviewId?: string;
}

interface AgentChangeFile {
	id: string;
	path: string;
	baseHash: string;
	hunks: AgentChangeHunk[];
}

interface AgentChangeSet {
	id: string;
	actor: { provider: string; displayName: string };
	files: AgentChangeFile[];
}

interface StagedFile {
	expectedContent: string;
	nativeReviewIds: Map<string, string>;
}

class AgentBridgeRequestError extends Error {
	constructor(
		readonly code: string,
		message: string,
		readonly retryHint?: string,
	) {
		super(message);
	}
}

class TeXlyreAgentRequestHandler {
	private readonly staged = new Map<string, Map<string, StagedFile>>();
	private readonly nativeReviews = new Map<
		string,
		{ changeSetId: string; fileId: string; hunkId: string }
	>();

	getNativeReviewMapping(
		nativeReviewId: string,
	): { changeSetId: string; fileId: string; hunkId: string } | undefined {
		return this.nativeReviews.get(nativeReviewId);
	}

	async handle(request: BridgeRequest): Promise<BridgeResponse> {
		try {
			if (request.version !== BRIDGE_PROTOCOL_VERSION) {
				throw new AgentBridgeRequestError(
					'INVALID_STATE',
					`Unsupported bridge protocol version: ${request.version}`,
				);
			}

			const result = await this.dispatch(request);
			return {
				version: BRIDGE_PROTOCOL_VERSION,
				id: request.id,
				ok: true,
				result,
			};
		} catch (error) {
			const normalized =
				error instanceof AgentBridgeRequestError
					? error
					: new AgentBridgeRequestError('INVALID_STATE', String(error));
			return {
				version: BRIDGE_PROTOCOL_VERSION,
				id: request.id,
				ok: false,
				error: {
					code: normalized.code,
					message: normalized.message,
					...(normalized.retryHint ? { retryHint: normalized.retryHint } : {}),
				},
			};
		}
	}

	private async dispatch(request: BridgeRequest): Promise<unknown> {
		const projectId = this.currentProjectId();
		if (request.projectId && request.projectId !== projectId) {
			throw new AgentBridgeRequestError(
				'INVALID_STATE',
				`The requested project is not active: ${request.projectId}`,
			);
		}

		switch (request.method) {
			case 'project.getContext':
				return {
					projectId,
					title: projectId,
					activeFile: agentReviewHostRegistry.listEditors(projectId)[0]?.path,
					reviewSupport: 'native-tracked-changes',
					capabilities: [
						'read_file',
						'list_files',
						'propose_changes',
						'get_change_set',
						'human_review',
						'apply_approved',
					],
				};
			case 'project.listFiles':
				return { files: await this.listTextFiles() };
			case 'document.readFile':
				return this.readFile(
					this.requireString(request.params.path, 'path'),
					projectId,
				);
			case 'review.stageChangeSet':
				return this.stageChangeSet(request.params.changeSet, projectId);
			case 'review.applyChangeSet':
				return this.applyChangeSet(request.params.changeSet, projectId);
			default:
				throw new AgentBridgeRequestError(
					'INVALID_STATE',
					`Unsupported browser bridge method: ${request.method}`,
				);
		}
	}

	private currentProjectId(): string {
		const projectId =
			fileStoreService.getCurrentProjectId() ||
			agentReviewHostRegistry.listEditors()[0]?.projectId;
		if (!projectId) {
			throw new AgentBridgeRequestError(
				'FILE_NOT_FOUND',
				'No active TeXlyre project is connected.',
				'Open a TeXlyre project and an editor before calling MCP tools.',
			);
		}
		return projectId;
	}

	private async listTextFiles(): Promise<string[]> {
		const files = await fileStoreService.getAllFiles(false, false, false);
		return files
			.filter(
				(file) =>
					file.type === 'file' && !file.isBinary && !isBinaryFile(file.name),
			)
			.map((file) => file.path)
			.sort((a, b) => a.localeCompare(b));
	}

	private async readFile(path: string, projectId: string) {
		const safePath = normalizeProjectPath(path);
		const view = this.requireEditor(projectId, safePath);
		const content = visibleText(view.state.doc.toString());
		return { path: safePath, content, hash: await sha256Text(content) };
	}

	private async stageChangeSet(
		value: unknown,
		projectId: string,
	): Promise<{ nativeReviewIds: Record<string, string> }> {
		const changeSet = requireChangeSet(value);
		const pending: Array<{
			view: EditorView;
			path: string;
			changes: Array<{ from: number; to: number; insert: string }>;
			staged: StagedFile;
		}> = [];
		const nativeReviewIds: Record<string, string> = {};

		for (const file of changeSet.files) {
			const path = normalizeProjectPath(file.path);
			const view = this.requireEditor(projectId, path);
			if (this.registrationIsViewOnly(projectId, path)) {
				throw new AgentBridgeRequestError(
					'PERMISSION_DENIED',
					`The live editor is read-only: ${path}`,
				);
			}

			const rawBefore = view.state.doc.toString();
			const visibleBefore = visibleText(rawBefore);
			if ((await sha256Text(visibleBefore)) !== file.baseHash) {
				throw new AgentBridgeRequestError(
					'BASE_HASH_MISMATCH',
					`The live editor changed before staging: ${path}`,
					'Read the file again and create a new proposal.',
				);
			}

			const rawChanges = file.hunks.map((hunk) => {
				const offsets = visibleToRawOffsets(
					rawBefore,
					hunk.anchor.start,
					hunk.anchor.end,
				);
				if (rawBefore.slice(offsets.from, offsets.to) !== hunk.oldText) {
					throw new AgentBridgeRequestError(
						'EDIT_TARGET_NOT_FOUND',
						`The proposal target is not present in the live editor: ${path}`,
					);
				}

				const tags = reviewService.createReview(
					hunk.oldText,
					`${changeSet.actor.displayName} (${changeSet.actor.provider})`,
				);
				nativeReviewIds[hunk.id] = tags.reviewId;
				this.nativeReviews.set(tags.reviewId, {
					changeSetId: changeSet.id,
					fileId: file.id,
					hunkId: hunk.id,
				});
				return {
					from: offsets.from,
					to: offsets.to,
					insert: `${tags.openTag}${hunk.newText}${tags.closeTag}`,
				};
			});

			const expectedContent = applyVisibleHunks(visibleBefore, file.hunks);
			pending.push({
				view,
				path,
				changes: rawChanges,
				staged: {
					expectedContent,
					nativeReviewIds: new Map(
						file.hunks.map((hunk) => [hunk.id, nativeReviewIds[hunk.id]]),
					),
				},
			});
		}

		for (const item of pending) {
			item.view.dispatch({
				changes: [...item.changes].sort((a, b) => b.from - a.from),
			});
		}

		this.staged.set(
			changeSet.id,
			new Map(pending.map((item) => [item.path, item.staged])),
		);
		return { nativeReviewIds };
	}

	private async applyChangeSet(
		value: unknown,
		projectId: string,
	): Promise<null> {
		const changeSet = requireChangeSet(value);
		const staged = this.staged.get(changeSet.id);
		if (!staged) {
			throw new AgentBridgeRequestError(
				'CHANGESET_STALE',
				'The staged proposal is no longer connected to this TeXlyre session.',
			);
		}

		for (const file of changeSet.files) {
			const path = normalizeProjectPath(file.path);
			const view = this.requireEditor(projectId, path);
			const stagedFile = staged.get(path);
			if (!stagedFile) {
				throw new AgentBridgeRequestError(
					'CHANGESET_STALE',
					`Missing staged file: ${path}`,
				);
			}
			if (
				(await sha256Text(visibleText(view.state.doc.toString()))) !==
				(await sha256Text(stagedFile.expectedContent))
			) {
				throw new AgentBridgeRequestError(
					'CHANGESET_STALE',
					`The live document changed while reviewing ${path}.`,
					'Read the file again and create a new proposal.',
				);
			}
			const nativeIds = new Set(
				getReviewChunks(view.state).map((chunk) => chunk.id),
			);
			for (const hunk of file.hunks) {
				const nativeId =
					hunk.nativeReviewId ?? stagedFile.nativeReviewIds.get(hunk.id);
				if (!nativeId || !nativeIds.has(nativeId)) {
					throw new AgentBridgeRequestError(
						'CHANGESET_STALE',
						`Native review hunk disappeared: ${hunk.id}`,
					);
				}
			}
		}

		for (const file of changeSet.files) {
			const path = normalizeProjectPath(file.path);
			const view = this.requireEditor(projectId, path);
			for (const hunk of file.hunks) {
				const nativeId =
					hunk.nativeReviewId ?? staged.get(path)?.nativeReviewIds.get(hunk.id);
				if (!nativeId)
					throw new AgentBridgeRequestError(
						'INVALID_STATE',
						`Hunk ${hunk.id} has no native review id.`,
					);
				const ok =
					hunk.status === 'accepted'
						? acceptReviewById(view, nativeId)
						: rejectReviewById(view, nativeId);
				if (!ok)
					throw new AgentBridgeRequestError(
						'CHANGESET_STALE',
						`Native review hunk disappeared: ${hunk.id}`,
					);
				this.nativeReviews.delete(nativeId);
			}
		}

		this.staged.delete(changeSet.id);
		return null;
	}

	private requireEditor(projectId: string, path: string): EditorView {
		const view = agentReviewHostRegistry.getEditorView(projectId, path);
		if (!view) {
			throw new AgentBridgeRequestError(
				'FILE_NOT_FOUND',
				`The file must be open in a live TeXlyre editor: ${path}`,
				'Open the target file in TeXlyre and retry.',
			);
		}
		return view;
	}

	private registrationIsViewOnly(projectId: string, path: string): boolean {
		return (
			agentReviewHostRegistry.getEditor(projectId, path)?.isViewOnly ?? true
		);
	}

	private requireString(value: unknown, name: string): string {
		if (typeof value !== 'string' || !value) {
			throw new AgentBridgeRequestError(
				'INVALID_STATE',
				`${name} is required.`,
			);
		}
		return value;
	}
}

export class BrowserAgentBridgeClient {
	private running = false;
	private abortController: AbortController | null = null;

	constructor(
		private readonly baseUrl: string,
		private readonly token?: string,
		private readonly handler = new TeXlyreAgentRequestHandler(),
	) {}

	getNativeReviewMapping(
		nativeReviewId: string,
	): { changeSetId: string; fileId: string; hunkId: string } | undefined {
		return this.handler.getNativeReviewMapping(nativeReviewId);
	}

	start(): void {
		if (this.running) return;
		this.running = true;
		this.abortController = new AbortController();
		void this.pollLoop(this.abortController.signal);
	}

	stop(): void {
		this.running = false;
		this.abortController?.abort();
		this.abortController = null;
	}

	async call(
		projectId: string,
		method: BrowserToSidecarMethod,
		params: Record<string, unknown>,
	): Promise<unknown> {
		const id =
			globalThis.crypto?.randomUUID?.() ??
			`browser-${Date.now()}-${Math.random().toString(16).slice(2)}`;
		const response = await fetch(`${this.baseUrl}/bridge/call`, {
			method: 'POST',
			headers: { ...this.headers(), 'content-type': 'application/json' },
			body: JSON.stringify({
				version: BRIDGE_PROTOCOL_VERSION,
				id,
				projectId,
				method,
				params,
			}),
		});
		let message: BridgeResponse | undefined;
		try {
			message = (await response.json()) as BridgeResponse;
		} catch {
			throw new Error(`Bridge call returned invalid JSON: ${response.status}`);
		}
		if (!response.ok || !message.ok) {
			throw new Error(
				message.error?.message ?? `Bridge call failed: ${response.status}`,
			);
		}
		return message.result;
	}

	private async pollLoop(signal: AbortSignal): Promise<void> {
		while (this.running && !signal.aborted) {
			const projectId = fileStoreService.getCurrentProjectId();
			if (!projectId) {
				await delay(1000);
				continue;
			}

			try {
				const response = await fetch(
					`${this.baseUrl}/bridge/poll?projectId=${encodeURIComponent(projectId)}`,
					{ headers: this.headers(), signal },
				);
				if (response.status === 204) continue;
				if (!response.ok)
					throw new Error(`Bridge poll failed: ${response.status}`);
				const request = (await response.json()) as BridgeRequest;
				const result = await this.handler.handle(request);
				await fetch(`${this.baseUrl}/bridge/respond`, {
					method: 'POST',
					headers: { ...this.headers(), 'content-type': 'application/json' },
					body: JSON.stringify(result),
					signal,
				});
			} catch (error) {
				if (!signal.aborted) {
					moduleLog.warn('TeXlyre local bridge is unavailable:', error);
					await delay(1000);
				}
			}
		}
	}

	private headers(): HeadersInit {
		return this.token ? { authorization: `Bearer ${this.token}` } : {};
	}
}

type HumanActor = {
	kind: 'human';
	userId: string;
	displayName: string;
};

class AgentBridgeService {
	private client: BrowserAgentBridgeClient | null = null;
	private humanActor: HumanActor | null = null;

	setHumanActor(actor: HumanActor | null): void {
		this.humanActor = actor;
	}

	notifyReviewDecision(
		nativeReviewId: string,
		decision: 'accepted' | 'rejected',
	): void {
		const mapping = this.client?.getNativeReviewMapping(nativeReviewId);
		if (!mapping || !this.client || !this.humanActor) return;

		const projectId =
			fileStoreService.getCurrentProjectId() ||
			agentReviewHostRegistry.listEditors()[0]?.projectId;
		if (!projectId) return;

		void this.client
			.call(projectId, 'review.setHunkDecision', {
				changeSetId: mapping.changeSetId,
				hunkId: mapping.hunkId,
				decision,
				actor: this.humanActor,
			})
			.catch((error) => {
				moduleLog.warn(
					'Could not sync the native review decision to the agent sidecar:',
					error,
				);
			});
	}

	start(): void {
		if (this.client) return;
		const url = import.meta.env.VITE_TEXLYRE_AGENT_BRIDGE_URL as
			| string
			| undefined;
		if (!url) return;
		const token = import.meta.env.VITE_TEXLYRE_AGENT_BRIDGE_TOKEN as
			| string
			| undefined;
		this.client = new BrowserAgentBridgeClient(url.replace(/\/$/, ''), token);
		this.client.start();
	}

	stop(): void {
		this.client?.stop();
		this.client = null;
	}
}

export const agentBridgeService = new AgentBridgeService();

function visibleText(raw: string): string {
	return stripAnnotationTags(raw, ['comment', 'review']);
}

function visibleToRawOffsets(
	raw: string,
	start: number,
	end: number,
): { from: number; to: number } {
	const hidden = collectAnnotationTagRanges(raw, ['comment', 'review']);
	const map: number[] = [0];
	let rangeIndex = 0;
	for (let rawIndex = 0; rawIndex < raw.length; rawIndex++) {
		while (rangeIndex < hidden.length && rawIndex >= hidden[rangeIndex].to)
			rangeIndex++;
		const insideHidden =
			rangeIndex < hidden.length &&
			rawIndex >= hidden[rangeIndex].from &&
			rawIndex < hidden[rangeIndex].to;
		if (!insideHidden) map.push(rawIndex + 1);
	}
	const from = map[start];
	const to = map[end];
	if (from === undefined || to === undefined || start > end) {
		throw new AgentBridgeRequestError(
			'EDIT_TARGET_NOT_FOUND',
			'Could not map the proposal anchor into the live editor.',
		);
	}
	return { from, to };
}

function applyVisibleHunks(
	content: string,
	hunks: readonly AgentChangeHunk[],
): string {
	let next = content;
	for (const hunk of [...hunks].sort(
		(a, b) => b.anchor.start - a.anchor.start,
	)) {
		if (next.slice(hunk.anchor.start, hunk.anchor.end) !== hunk.oldText) {
			throw new AgentBridgeRequestError(
				'EDIT_TARGET_NOT_FOUND',
				'A proposal hunk no longer matches the live document.',
			);
		}
		next = `${next.slice(0, hunk.anchor.start)}${hunk.newText}${next.slice(hunk.anchor.end)}`;
	}
	return next;
}

function requireChangeSet(value: unknown): AgentChangeSet {
	if (!value || typeof value !== 'object') {
		throw new AgentBridgeRequestError(
			'INVALID_STATE',
			'changeSet is required.',
		);
	}
	const changeSet = value as Partial<AgentChangeSet>;
	if (!changeSet.id || !Array.isArray(changeSet.files) || !changeSet.actor) {
		throw new AgentBridgeRequestError(
			'INVALID_STATE',
			'changeSet requires id, actor, and files.',
		);
	}
	return changeSet as AgentChangeSet;
}

function normalizeProjectPath(path: string): string {
	if (
		!path ||
		path.includes('\\') ||
		path.startsWith('/') ||
		path.split('/').includes('..')
	) {
		throw new AgentBridgeRequestError(
			'INVALID_PATH',
			`Invalid project path: ${path}`,
		);
	}
	return path;
}

async function sha256Text(text: string): Promise<string> {
	const digest = await crypto.subtle.digest(
		'SHA-256',
		new TextEncoder().encode(text),
	);
	return [...new Uint8Array(digest)]
		.map((byte) => byte.toString(16).padStart(2, '0'))
		.join('');
}

function delay(milliseconds: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, milliseconds));
}
