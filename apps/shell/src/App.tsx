import { lazy, Suspense } from 'react';
import { ChatPane } from './components/ChatPane';
import { Header } from './components/Header';
import { Inspector } from './components/Inspector';
import { MapBanner } from './components/MapBanner';
import { MapGrid } from './components/MapGrid';
import { Scrubber } from './components/Scrubber';
import { TurnSummary } from './components/TurnSummary';

// `?map=v2` swaps in the N0 spike renderer (lazy, so v1 never loads React Flow or ELK); `&comp=1` is the D1 comp shell.
const params = new URLSearchParams(location.search);
const V2 = params.get('map') === 'v2';
const MapV2 = lazy(() => import('./v2/MapV2'));
const CompShell = lazy(() => import('./v2/CompShell'));

export function App() {
  if (V2 && params.has('comp')) {
    return (
      <Suspense fallback={null}>
        <CompShell />
      </Suspense>
    );
  }
  return (
    <div className="app">
      <ChatPane />
      <Header />
      <main className="stage">
        <MapBanner />
        {V2 ? (
          <Suspense fallback={null}>
            <MapV2 />
          </Suspense>
        ) : (
          <MapGrid />
        )}
        <Inspector />
      </main>
      <footer className="bottom">
        <TurnSummary />
        <Scrubber />
      </footer>
    </div>
  );
}
