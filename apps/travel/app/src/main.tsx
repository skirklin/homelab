import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { BrowserRouter } from "react-router-dom";
import { ConfigProvider } from "antd";
import { AuthProvider } from "@kirkl/shared";
import { TravelModule } from "./module";

import "./backend";

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <ConfigProvider>
      <BrowserRouter>
        <AuthProvider>
          <TravelModule />
        </AuthProvider>
      </BrowserRouter>
    </ConfigProvider>
  </StrictMode>
);
