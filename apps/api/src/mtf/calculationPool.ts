import { Worker } from 'node:worker_threads';
import type { summarizeDashboard } from '../../../../packages/core/src/mtf/dashboard.ts';
/** Bounded CPU isolation: another user's valuation cannot block the HTTP event loop. */
export class CalculationPool {
  #worker: Worker | null = null; #id = 0;
  #pending = new Map<number, { resolve: (value: ReturnType<typeof summarizeDashboard>) => void; reject: (error: Error) => void; timer: ReturnType<typeof setTimeout> }>();
  calculate(input: Parameters<typeof summarizeDashboard>): Promise<ReturnType<typeof summarizeDashboard>> {
    if (this.#pending.size >= 20) return Promise.reject(new Error('Portfolio calculator busy'));
    if (!this.#worker) {
      const worker = new Worker(new URL('./calculationWorker.ts', import.meta.url)); this.#worker = worker;
      worker.on('message', message => { const pending = this.#pending.get(message.id); if (!pending) return; clearTimeout(pending.timer); this.#pending.delete(message.id); if (message.error) pending.reject(new Error(message.error)); else pending.resolve(message.result); });
      const fail = () => { if (this.#worker !== worker) return; this.#worker = null; for (const pending of this.#pending.values()) { clearTimeout(pending.timer); pending.reject(new Error('Portfolio calculator unavailable')); } this.#pending.clear(); };
      worker.on('error', fail); worker.on('exit', fail); worker.unref();
    }
    const id = ++this.#id;
    return new Promise((resolve,reject) => { const timer = setTimeout(() => { this.#pending.delete(id); reject(new Error('Portfolio calculation timed out')); }, 30_000); this.#pending.set(id,{resolve,reject,timer}); this.#worker!.postMessage({id,input}); });
  }
  async close() { await this.#worker?.terminate(); this.#worker = null; }
}
