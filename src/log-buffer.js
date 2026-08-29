// Per-task log buffer for live streaming via GET /logs/:taskId
// TODO: implement SSE endpoint in server.js to stream these

const buffers = new Map(); // taskId → string[]

function append(taskId, chunk) {
  if (!buffers.has(taskId)) buffers.set(taskId, []);
  buffers.get(taskId).push(chunk);
}

function get(taskId) {
  return (buffers.get(taskId) || []).join('');
}

function clear(taskId) {
  buffers.delete(taskId);
}

module.exports = { append, get, clear };
