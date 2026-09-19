import { expect, test } from 'vitest';
import { rebuildFeedback } from '../rebuild-feedback';
test('confirms an explicitly queued session analysis', () => {
 expect(rebuildFeedback({ status: 'queued', alreadyRunning: false })).toEqual({ tone: 'success', message: 'Session analysis queued' });
});
test('reports an existing analysis without implying another paid pass', () => {
 expect(rebuildFeedback({ status: 'running', alreadyRunning: true })).toEqual({ tone: 'info', message: 'Analysis is already running' });
});
