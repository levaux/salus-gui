/**
 * @salus-gui/mock-salus — a deterministic double of the Salus fleet.
 *
 * One h2c Connect hub answering the whole service catalog, so the console runs
 * fully offline and the same code connects to a real fleet unchanged.
 */
export * from './deterministic.js';
export * from './fleet.js';
export * from './headers.js';
export * from './router.js';
export * from './scripted-stream.js';
export * from './server.js';
