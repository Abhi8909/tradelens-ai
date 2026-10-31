import { parentPort } from 'node:worker_threads';
import { summarizeDashboard } from '../../../../packages/core/src/mtf/dashboard.ts';
parentPort?.on('message', ({ id, input }: { id: number; input: Parameters<typeof summarizeDashboard> }) => {
  try {
    const result = summarizeDashboard(...input);
    parentPort?.postMessage({ id, result: { ...result, rows: result.rows.map(row => ({ ...row, snapshot: { ...row.snapshot, dailyInterest: [], exits: [] } })) } });
  } catch { parentPort?.postMessage({ id, error: 'Could not calculate portfolio' }); }
});
