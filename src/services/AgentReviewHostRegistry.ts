import type { EditorView } from '@codemirror/view';

export const AGENT_REVIEW_HOST_CHANGED_EVENT =
	'texlyre-agent-review-host-changed';

export interface AgentReviewEditorRegistration {
	projectId: string;
	path: string;
	view: EditorView;
	fileId?: string;
	documentId?: string;
	isEditingFile: boolean;
	isViewOnly: boolean;
}

export interface AgentReviewEditorSnapshot {
	projectId: string;
	path: string;
	fileId?: string;
	documentId?: string;
	isEditingFile: boolean;
	isViewOnly: boolean;
}

type AgentReviewHostListener = (
	editors: readonly AgentReviewEditorSnapshot[],
) => void;

/**
 * Registry for the live editor instances that an AgentBridge may address.
 *
 * This deliberately owns no review semantics and does not mutate editor
 * content. It only makes the already-mounted CodeMirror/Yjs editor addressable
 * by project id and file path. Review staging remains the responsibility of
 * the TeXlyre-native adapter.
 */
export class AgentReviewHostRegistry {
	private readonly editors = new Map<string, AgentReviewEditorRegistration>();
	private readonly listeners = new Set<AgentReviewHostListener>();

	registerEditor(registration: AgentReviewEditorRegistration): () => void {
		if (!registration.projectId || !registration.path) {
			throw new Error(
				'Agent review editor registration requires projectId and path',
			);
		}

		const key = this.key(registration.projectId, registration.path);
		const previous = this.editors.get(key);
		this.editors.set(key, registration);
		this.publish();

		let disposed = false;
		return () => {
			if (disposed) return;
			disposed = true;

			// Do not remove a newer editor that reused the same project/path key.
			if (this.editors.get(key) === registration) {
				this.editors.delete(key);
				this.publish();
			} else if (previous && !this.editors.has(key)) {
				this.editors.set(key, previous);
				this.publish();
			}
		};
	}

	getEditor(
		projectId: string,
		path: string,
	): AgentReviewEditorRegistration | null {
		return this.editors.get(this.key(projectId, path)) ?? null;
	}

	getEditorView(projectId: string, path: string): EditorView | null {
		return this.getEditor(projectId, path)?.view ?? null;
	}

	listEditors(projectId?: string): readonly AgentReviewEditorSnapshot[] {
		return [...this.editors.values()]
			.filter((editor) => !projectId || editor.projectId === projectId)
			.map(({ view: _view, ...snapshot }) => snapshot)
			.sort((a, b) =>
				a.projectId === b.projectId
					? a.path.localeCompare(b.path)
					: a.projectId.localeCompare(b.projectId),
			);
	}

	subscribe(listener: AgentReviewHostListener): () => void {
		this.listeners.add(listener);
		listener(this.listEditors());
		return () => this.listeners.delete(listener);
	}

	private key(projectId: string, path: string): string {
		return `${projectId}\u0000${path}`;
	}

	private publish(): void {
		const editors = this.listEditors();
		for (const listener of this.listeners) listener(editors);

		if (typeof document !== 'undefined') {
			document.dispatchEvent(
				new CustomEvent(AGENT_REVIEW_HOST_CHANGED_EVENT, {
					detail: { editors },
				}),
			);
		}
	}
}

export const agentReviewHostRegistry = new AgentReviewHostRegistry();
