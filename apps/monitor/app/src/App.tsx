import { BrowserRouter, NavLink, Route, Routes } from "react-router-dom";
import { Overview } from "./pages/Overview";

export default function App() {
  return (
    <BrowserRouter>
      <Layout />
    </BrowserRouter>
  );
}

function Layout() {
  return (
    <div className="layout">
      <aside className="sidebar">
        <h1>kirkl.in monitor</h1>
        <nav>
          <NavLink to="/" end>Overview</NavLink>
        </nav>
        <div className="ext">
          External:
          <br />
          <a href="https://beszel.tail56ca88.ts.net/" target="_blank" rel="noreferrer">Beszel (metrics) →</a>
          <br />
          <a href="https://gatus.tail56ca88.ts.net/" target="_blank" rel="noreferrer">Gatus (uptime) →</a>
        </div>
      </aside>
      <main className="main">
        <Routes>
          <Route path="/" element={<Overview />} />
        </Routes>
      </main>
    </div>
  );
}
