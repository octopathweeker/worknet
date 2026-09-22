import { useEffect, useState } from 'react';

export type PlatformView = 'home' | 'deliveries' | 'budget' | 'taker';
export type PlatformRoute = { view: PlatformView; goal?: string | undefined; tab?: 'runs' | 'executors' | undefined };

const PLATFORM_VIEWS: PlatformView[] = ['home', 'deliveries', 'budget', 'taker'];

export function readPlatformHash(hash: string = location.hash): PlatformRoute {
  const parts = hash.replace(/^#\/?/, '').split('/').filter(Boolean).map(decodeURIComponent);
  if (parts[0] === 'taker' || parts[0] === 'taker-executors') {
    const tab = parts[1] === 'runs' || parts[1] === 'executors' ? parts[1] : parts[0] === 'taker-executors' ? 'executors' : undefined;
    return { view: 'taker', tab };
  }
  const goalIdx = parts.indexOf('task');
  if (goalIdx >= 0 && parts[goalIdx + 1]) {
    const list = parts.slice(0, goalIdx)[0];
    return { view: PLATFORM_VIEWS.includes(list as PlatformView) && list !== 'taker' ? list as PlatformView : 'home', goal: parts[goalIdx + 1] };
  }
  if (PLATFORM_VIEWS.includes(parts[0] as PlatformView)) return { view: parts[0] as PlatformView };
  return { view: 'home' };
}

export function platformHash(route: { view?: PlatformView | undefined; goal?: string | undefined; tab?: string | undefined }): string {
  if (route.goal) return route.view && route.view !== 'home' ? `#/${route.view}/task/${encodeURIComponent(route.goal)}` : `#/task/${encodeURIComponent(route.goal)}`;
  if (route.view === 'taker' && route.tab && route.tab !== 'market') return `#/taker/${route.tab}`;
  if (route.view && route.view !== 'home') return `#/${route.view}`;
  return '#/';
}

export function usePlatformRoute(): PlatformRoute {
  const [route, setRoute] = useState<PlatformRoute>(() => readPlatformHash());
  useEffect(() => {
    const onChange = () => setRoute(readPlatformHash());
    window.addEventListener('hashchange', onChange);
    return () => window.removeEventListener('hashchange', onChange);
  }, []);
  return route;
}

export type LegacyView = 'home' | 'deliveries' | 'workers' | 'settings';
export type LegacyRoute = { view: LegacyView; goal?: string | undefined };

export function readLegacyHash(hash: string = location.hash): LegacyRoute {
  const parts = hash.replace(/^#\/?/, '').split('/').filter(Boolean).map(decodeURIComponent);
  if (parts[0] !== 'legacy') return { view: 'home' };
  const goalIdx = parts.indexOf('task');
  if (goalIdx >= 0 && parts[goalIdx + 1]) {
    const list = parts.slice(0, goalIdx)[1];
    return { view: list === 'deliveries' || list === 'workers' || list === 'settings' ? list : 'home', goal: parts[goalIdx + 1] };
  }
  const view = parts[1];
  return { view: view === 'deliveries' || view === 'workers' || view === 'settings' ? view : 'home' };
}

export function legacyHash(route: { view?: LegacyView | undefined; goal?: string | undefined }): string {
  if (route.goal) return route.view && route.view !== 'home' ? `#legacy/${route.view}/task/${encodeURIComponent(route.goal)}` : `#legacy/task/${encodeURIComponent(route.goal)}`;
  if (route.view && route.view !== 'home') return `#legacy/${route.view}`;
  return '#legacy';
}

export function useLegacyRoute(): LegacyRoute {
  const [route, setRoute] = useState<LegacyRoute>(() => readLegacyHash());
  useEffect(() => {
    const onChange = () => setRoute(readLegacyHash());
    window.addEventListener('hashchange', onChange);
    return () => window.removeEventListener('hashchange', onChange);
  }, []);
  return route;
}
