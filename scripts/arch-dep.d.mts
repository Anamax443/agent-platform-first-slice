// scripts/ is plain Node JS, outside tsconfig.json's "include" (it is not typechecked as TypeScript at all — see
// that file's own "include" list). This hand-written declaration exists only so tests/arch.test.ts, which IS
// typechecked, can import checkEscapeHatches() directly (a pure function over config/*/profile.json) instead of
// parsing it back out of the CLI's stdout the way the rest of that file has to for arch-dep.mjs's other checks.
export function checkEscapeHatches(configDir?: string): string[];
