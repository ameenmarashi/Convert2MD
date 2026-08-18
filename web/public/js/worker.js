/** Conversion worker: keeps large documents off the UI thread. */
import { convertFile } from './core/convert.js';
const scope = self;
scope.addEventListener('message', (event) => {
    const request = event.data;
    try {
        const result = convertFile({
            name: request.name,
            bytes: new Uint8Array(request.buffer),
            mime: request.mime,
            lastModified: request.lastModified,
        }, request.options);
        const response = { type: 'result', id: request.id, result };
        scope.postMessage(response);
    }
    catch (err) {
        const response = {
            type: 'error',
            id: request.id,
            message: err instanceof Error ? err.message : String(err),
        };
        scope.postMessage(response);
    }
});
//# sourceMappingURL=worker.js.map