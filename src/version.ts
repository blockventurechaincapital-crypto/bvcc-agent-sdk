/**
 * The SDK's own version, injected at build time from package.json (see tsup.config.ts),
 * so it cannot drift from the published package. Unbuilt sources (tests, tsx) read
 * "0.0.0-dev".
 */
declare const __SDK_VERSION__: string | undefined;

export const SDK_VERSION: string = typeof __SDK_VERSION__ === "string" ? __SDK_VERSION__ : "0.0.0-dev";
