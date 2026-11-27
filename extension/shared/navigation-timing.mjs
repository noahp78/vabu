export function navigationTiming(href) {
  if (window !== window.top || location.href !== href) return null;
  const nav = performance.getEntriesByType('navigation')[0];
  return nav ? { type: nav.type, responseStart: nav.responseStart, domInteractive: nav.domInteractive,
    domContentLoaded: nav.domContentLoadedEventEnd, load: nav.loadEventEnd } : null;
}
