import { BrowserRouter, NavLink, Route, Routes, useLocation } from "react-router-dom";
import { Overview } from "./pages/Overview";
import { Metrics } from "./pages/Metrics";

export default function App() {
  return (
    <BrowserRouter>
      <Layout />
    </BrowserRouter>
  );
}

function Layout() {
  const isMetrics = useLocation().pathname.startsWith("/metrics");
  return (
    <div className="layout">
      <aside className="sidebar">
        <h1>kirkl.in monitor</h1>
        <nav>
          <NavLink to="/" end>Overview</NavLink>
          <NavLink to="/metrics">System metrics</NavLink>
        </nav>
        <div className="ext">
          <a href="https://homelab-0.tail56ca88.ts.net:9444/" target="_blank" rel="noreferrer">Open Gatus →</a>
          <br />
          <a href="https://homelab-0.tail56ca88.ts.net:9443/" target="_blank" rel="noreferrer">Open Beszel →</a>
        </div>
      </aside>
      <main className={isMetrics ? "main full" : "main"}>
        <Routes>
          <Route path="/" element={<Overview />} />
          <Route path="/metrics" element={<Metrics />} />
        </Routes>
      </main>
    </div>
  );
}
