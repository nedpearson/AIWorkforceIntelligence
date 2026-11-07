// Ambient fallbacks so the collector type-checks on machines (and CI) where the optional native
// dependencies are not installed. When the real packages are present their own types win.
declare module "active-win" {
  const activeWindow: () => Promise<{ title?: string; owner?: { name?: string; processId?: number; bundleId?: string; path?: string } } | undefined>;
  export default activeWindow;
  export { activeWindow };
}
declare module "desktop-idle" {
  export function getIdleTime(): number;
}
