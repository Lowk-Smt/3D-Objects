/* ============================================================
   Wireframe preparation Web Worker

   Receives one mesh's geometry as tightly packed XYZ positions (plus an
   optional index), runs the shared edge extraction off the main thread, and
   posts back a transferable Float32Array of XYZ segment pairs.

   Packing happens on the main thread (see buildWorkerPayload in
   ./wireframe.js), so the worker has a single input shape and its inner
   loop never has to touch a stride, an offset or a normalized value.

   Message protocol
   ----------------
   in : { type: 'extract', id, thresholdAngle,
          positions: Float32Array, index: { array, count } | null }
   out: { type: 'result', id, positions: Float32Array }   // transferred
   out: { type: 'error',  id, message }                   // task abandoned
   ============================================================ */

import { extractWireframeEdges, DEFAULT_THRESHOLD_ANGLE } from './wireframe.js';

function reconstructGeometry(message) {
  const positions = message.positions;
  const position = { array: positions, itemSize: 3, normalized: false, count: positions.length / 3 };
  const index = message.index
    ? { count: message.index.count, getX: (i) => message.index.array[i] }
    : null;

  return {
    getAttribute(name) {
      return name === 'position' ? position : null;
    },
    getIndex() {
      return index;
    }
  };
}

self.onmessage = (event) => {
  const message = event.data;
  if (!message || message.type !== 'extract') return;
  const id = message.id;

  try {
    const positions = message.positions;
    if (!positions || typeof positions.length !== 'number' || positions.length === 0) {
      throw new Error('wireframe worker received no packed positions');
    }
    const edges = extractWireframeEdges(
      reconstructGeometry(message),
      typeof message.thresholdAngle === 'number' ? message.thresholdAngle : DEFAULT_THRESHOLD_ANGLE
    );
    self.postMessage({ type: 'result', id, positions: edges }, [edges.buffer]);
  } catch (err) {
    self.postMessage({
      type: 'error',
      id,
      message: (err && err.message) ? err.message : String(err)
    });
  }
};
