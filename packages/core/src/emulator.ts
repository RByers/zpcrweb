/**
 * `@zpcrweb/core/emulator` — the CFX96 emulator, on a subpath of its own.
 *
 * Separate from the main entry deliberately: it carries a whole imitation instrument, and the web
 * app reaches it through a lazy `import()` so that a production build which never sets the mock
 * flag never downloads it. See `usb/emulator/index.ts` for what it is and `emulator.md` for how
 * far it is to be trusted.
 */
export * from "./usb/emulator/index.js";
