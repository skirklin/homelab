/**
 * Routing tests for embedded modules in the home app
 *
 * These tests verify that navigation within embedded modules works correctly
 * when the modules are mounted at non-root paths (e.g., /groceries/*, /recipes/*).
 *
 * The key issue: modules using absolute paths like navigate(`/${slug}`) navigate
 * to the root of the app instead of staying within the module's path.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { MemoryRouter, Routes, Route, useNavigate, useLocation, Outlet } from "react-router-dom";
import { ReactNode } from "react";

// Mock Firebase and shared auth to avoid real Firebase calls
vi.mock("@kirkl/shared", () => ({
  useAuth: () => ({ user: { uid: "test-user" }, loading: false }),
  AuthProvider: ({ children }: { children: ReactNode }) => <>{children}</>,
  initializeBackend: () => {},
  getBackend: () => ({ auth: {}, db: {} }),
}));

// Helper component that displays current location
function LocationDisplay() {
  const location = useLocation();
  return <div data-testid="location">{location.pathname}</div>;
}

// Test component that simulates module navigation with ABSOLUTE paths (the bug)
function AbsolutePathModule() {
  const navigate = useNavigate();
  return (
    <div>
      <button onClick={() => navigate("/mylist")}>Go to List (absolute)</button>
      <button onClick={() => navigate("/")}>Go to Root (absolute)</button>
      <Outlet />
    </div>
  );
}

// Test component that simulates module navigation with RELATIVE paths (the fix)
function RelativePathModule() {
  const navigate = useNavigate();
  return (
    <div>
      <button onClick={() => navigate("mylist")}>Go to List (relative)</button>
      <button onClick={() => navigate(".")}>Go to Module Root (relative)</button>
      <Outlet />
    </div>
  );
}

describe("Embedded Module Routing", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe("Absolute Path Navigation (BUG)", () => {
    it("navigates to root instead of module path when using absolute paths", async () => {
      render(
        <MemoryRouter initialEntries={["/groceries"]}>
          <Routes>
            <Route path="/" element={<LocationDisplay />} />
            <Route path="/:slug" element={<LocationDisplay />} />
            <Route path="/groceries/*" element={<AbsolutePathModule />}>
              <Route index element={<LocationDisplay />} />
              <Route path=":slug" element={<LocationDisplay />} />
            </Route>
          </Routes>
        </MemoryRouter>
      );

      // We start at /groceries
      expect(screen.getByTestId("location")).toHaveTextContent("/groceries");

      // Click "Go to List" which uses navigate("/mylist") - ABSOLUTE path
      fireEvent.click(screen.getByText("Go to List (absolute)"));

      // BUG: This goes to /mylist (root level), not /groceries/mylist
      await waitFor(() => {
        expect(screen.getByTestId("location")).toHaveTextContent("/mylist");
      });

      // This is the WRONG location - it should be /groceries/mylist
      expect(screen.getByTestId("location").textContent).not.toBe("/groceries/mylist");
    });

    it("navigates to app root instead of module root when using navigate('/')", async () => {
      render(
        <MemoryRouter initialEntries={["/groceries/mylist"]}>
          <Routes>
            <Route path="/" element={<LocationDisplay />} />
            <Route path="/groceries/*" element={<AbsolutePathModule />}>
              <Route index element={<LocationDisplay />} />
              <Route path=":slug" element={<LocationDisplay />} />
            </Route>
          </Routes>
        </MemoryRouter>
      );

      // We start at /groceries/mylist
      expect(screen.getByTestId("location")).toHaveTextContent("/groceries/mylist");

      // Click "Go to Root" which uses navigate("/") - goes to APP root
      fireEvent.click(screen.getByText("Go to Root (absolute)"));

      // BUG: This goes to / (app root), not /groceries (module root)
      await waitFor(() => {
        expect(screen.getByTestId("location")).toHaveTextContent("/");
      });

      // This is the WRONG location - user expected to go to /groceries
      expect(screen.getByTestId("location").textContent).not.toBe("/groceries");
    });
  });

  describe("Relative Path Navigation (FIX)", () => {
    it("navigates within module when using relative paths", async () => {
      render(
        <MemoryRouter initialEntries={["/groceries"]}>
          <Routes>
            <Route path="/" element={<LocationDisplay />} />
            <Route path="/groceries/*" element={<RelativePathModule />}>
              <Route index element={<LocationDisplay />} />
              <Route path=":slug" element={<LocationDisplay />} />
            </Route>
          </Routes>
        </MemoryRouter>
      );

      // We start at /groceries
      expect(screen.getByTestId("location")).toHaveTextContent("/groceries");

      // Click "Go to List" which uses navigate("mylist") - RELATIVE path
      fireEvent.click(screen.getByText("Go to List (relative)"));

      // CORRECT: This stays within /groceries/*
      await waitFor(() => {
        expect(screen.getByTestId("location")).toHaveTextContent("/groceries/mylist");
      });
    });

    it("navigates to module root when using navigate('.')", async () => {
      render(
        <MemoryRouter initialEntries={["/groceries/mylist"]}>
          <Routes>
            <Route path="/" element={<LocationDisplay />} />
            <Route path="/groceries/*" element={<RelativePathModule />}>
              <Route index element={<LocationDisplay />} />
              <Route path=":slug" element={<LocationDisplay />} />
            </Route>
          </Routes>
        </MemoryRouter>
      );

      // We start at /groceries/mylist
      expect(screen.getByTestId("location")).toHaveTextContent("/groceries/mylist");

      // Click "Go to Module Root" which uses navigate(".") - goes to module root
      fireEvent.click(screen.getByText("Go to Module Root (relative)"));

      // CORRECT: This goes to /groceries (module root)
      await waitFor(() => {
        expect(screen.getByTestId("location")).toHaveTextContent("/groceries");
      });
    });
  });

  describe("Recipes Module Path Patterns", () => {
    it("absolute path navigate('/boxes/123') goes to wrong location", async () => {
      function RecipesAbsoluteModule() {
        const navigate = useNavigate();
        return (
          <div>
            <button onClick={() => navigate("/boxes/box-123")}>Open Box (absolute)</button>
            <Outlet />
          </div>
        );
      }

      render(
        <MemoryRouter initialEntries={["/recipes"]}>
          <Routes>
            <Route path="/" element={<LocationDisplay />} />
            <Route path="/boxes/:boxId" element={<LocationDisplay />} />
            <Route path="/recipes/*" element={<RecipesAbsoluteModule />}>
              <Route index element={<LocationDisplay />} />
              <Route path="boxes/:boxId" element={<LocationDisplay />} />
            </Route>
          </Routes>
        </MemoryRouter>
      );

      expect(screen.getByTestId("location")).toHaveTextContent("/recipes");

      fireEvent.click(screen.getByText("Open Box (absolute)"));

      // BUG: Goes to /boxes/box-123 (root level) instead of /recipes/boxes/box-123
      await waitFor(() => {
        expect(screen.getByTestId("location")).toHaveTextContent("/boxes/box-123");
      });
    });

    it("relative path navigate('boxes/123') stays in module", async () => {
      function RecipesRelativeModule() {
        const navigate = useNavigate();
        return (
          <div>
            <button onClick={() => navigate("boxes/box-123")}>Open Box (relative)</button>
            <Outlet />
          </div>
        );
      }

      render(
        <MemoryRouter initialEntries={["/recipes"]}>
          <Routes>
            <Route path="/" element={<LocationDisplay />} />
            <Route path="/boxes/:boxId" element={<LocationDisplay />} />
            <Route path="/recipes/*" element={<RecipesRelativeModule />}>
              <Route index element={<LocationDisplay />} />
              <Route path="boxes/:boxId" element={<LocationDisplay />} />
            </Route>
          </Routes>
        </MemoryRouter>
      );

      expect(screen.getByTestId("location")).toHaveTextContent("/recipes");

      fireEvent.click(screen.getByText("Open Box (relative)"));

      // CORRECT: Stays within /recipes/*
      await waitFor(() => {
        expect(screen.getByTestId("location")).toHaveTextContent("/recipes/boxes/box-123");
      });
    });
  });
});
