/** Conversion worker: keeps large documents off the UI thread. */

import { convertFile } from './core/convert.js';
import { ConversionResult, ConvertOptions } from './core/types.js';

export interface WorkerRequest {
  id: string;
  name: string;
  mime: string;
  lastModified: number;
  buffer: ArrayBuffer;
  options: ConvertOptions;
}

export type WorkerResponse =
  | { type: 'result'; id: string; result: ConversionResult }
  | { type: 'error'; id: string; message: string };

const scope = self as unknown as DedicatedWorkerGlobalScope;

scope.addEventListener('message', (event: MessageEvent<WorkerRequest>) => {
  const request = event.data;
  try {
    const result = convertFile(
      {
        name: request.name,
        bytes: new Uint8Array(request.buffer),
        mime: request.mime,
        lastModified: request.lastModified,
      },
      request.options
    );
    const response: WorkerResponse = { type: 'result', id: request.id, result };
    scope.postMessage(response);
  } catch (err) {
    const response: WorkerResponse = {
      type: 'error',
      id: request.id,
      message: err instanceof Error ? err.message : String(err),
    };
    scope.postMessage(response);
  }
});
