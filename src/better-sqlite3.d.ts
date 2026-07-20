/**
 * Ambient declaration for the OPTIONAL better-sqlite3 dependency.
 * It is loaded dynamically (daemon mode only) and may be absent at runtime,
 * so we deliberately type it as `any` instead of depending on its types.
 */
declare module 'better-sqlite3';
