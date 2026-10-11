import { ChatPane } from './components/ChatPane';
import { Header } from './components/Header';
import { Inspector } from './components/Inspector';
import { MapBanner } from './components/MapBanner';
import { MapGrid } from './components/MapGrid';
import { Scrubber } from './components/Scrubber';
import { TurnSummary } from './components/TurnSummary';

export function App() {
  return (
    <div className="app">
      <ChatPane />
      <Header />
      <main className="stage">
        <MapBanner />
        <MapGrid />
        <Inspector />
      </main>
      <footer className="bottom">
        <TurnSummary />
        <Scrubber />
      </footer>
    </div>
  );
}
