import type { EditorView } from '@codemirror/view';

import { AgentReviewHostRegistry } from '@/services/AgentReviewHostRegistry';

describe('AgentReviewHostRegistry', () => {
	it('registers live editors by project and path and removes them on dispose', () => {
		const registry = new AgentReviewHostRegistry();
		const view = {} as EditorView;

		const dispose = registry.registerEditor({
			projectId: 'project-1',
			path: 'main.tex',
			view,
			fileId: 'file-1',
			isEditingFile: true,
			isViewOnly: false,
		});

		expect(registry.getEditorView('project-1', 'main.tex')).toBe(view);
		expect(registry.listEditors('project-1')).toEqual([
			{
				projectId: 'project-1',
				path: 'main.tex',
				fileId: 'file-1',
				isEditingFile: true,
				isViewOnly: false,
			},
		]);

		dispose();
		expect(registry.getEditorView('project-1', 'main.tex')).toBeNull();
		expect(registry.listEditors()).toEqual([]);
	});

	it('does not let an old disposer remove a replacement editor', () => {
		const registry = new AgentReviewHostRegistry();
		const first = {} as EditorView;
		const second = {} as EditorView;

		const disposeFirst = registry.registerEditor({
			projectId: 'project-1',
			path: 'main.tex',
			view: first,
			isEditingFile: false,
			isViewOnly: false,
		});
		registry.registerEditor({
			projectId: 'project-1',
			path: 'main.tex',
			view: second,
			isEditingFile: false,
			isViewOnly: false,
		});

		disposeFirst();
		expect(registry.getEditorView('project-1', 'main.tex')).toBe(second);
	});
});
