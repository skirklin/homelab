import {
  BrowserRouter,
} from "react-router-dom";

import { RecipesRoutes } from './RecipesRoutes';
import Auth from "./Auth";

function Router() {
  return (
    <Auth>
      <BrowserRouter future={{ v7_startTransition: true, v7_relativeSplatPath: true }}>
        <RecipesRoutes />
      </BrowserRouter>
    </Auth>
  )
}


export default Router