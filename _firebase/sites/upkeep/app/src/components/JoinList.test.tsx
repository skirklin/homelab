import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Routes, Route } from 'react-router-dom';
import { AuthContext } from '@kirkl/shared';
import { JoinList } from './JoinList';
import { UpkeepProvider } from '../upkeep-context';
import * as firestore from '../firestore';
import * as subscription from '../subscription';

// Mock the firestore module
vi.mock('../firestore', () => ({
  getListById: vi.fn(),
  setUserSlug: vi.fn(),
}));

// Mock the subscription module (used by UpkeepProvider)
vi.mock('../subscription', () => ({
  subscribeToUserSlugs: vi.fn(() => () => {}),
  subscribeToList: vi.fn(() => Promise.resolve([])),
  getTasksFromState: vi.fn(() => []),
  getTasksByUrgency: vi.fn(() => ({ today: [], thisWeek: [], later: [] })),
  getTasksByRoom: vi.fn(() => new Map()),
}));

// Mock antd message
vi.mock('antd', async () => {
  const actual = await vi.importActual('antd');
  return {
    ...actual,
    message: {
      error: vi.fn(),
      success: vi.fn(),
    },
  };
});

const mockNavigate = vi.fn();
vi.mock('react-router-dom', async () => {
  const actual = await vi.importActual('react-router-dom');
  return {
    ...actual,
    useNavigate: () => mockNavigate,
  };
});

// Test wrapper that provides auth context and upkeep context
function TestWrapper({ children, user = { uid: 'user123' } as any }: { children: React.ReactNode; user?: any }) {
  return (
    <AuthContext.Provider value={{ user, loading: false }}>
      <UpkeepProvider>
        {children}
      </UpkeepProvider>
    </AuthContext.Provider>
  );
}

function renderJoinList(listId: string, user: any = { uid: 'user123' }) {
  return render(
    <TestWrapper user={user}>
      <MemoryRouter initialEntries={[`/join/${listId}`]}>
        <Routes>
          <Route path="/join/:listId" element={<JoinList />} />
        </Routes>
      </MemoryRouter>
    </TestWrapper>
  );
}

describe('JoinList', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // Reset to default mock that returns empty slugs
    vi.mocked(subscription.subscribeToUserSlugs).mockImplementation(() => () => {});
  });

  it('shows loading spinner while fetching list', () => {
    vi.mocked(firestore.getListById).mockImplementation(
      () => new Promise(() => {}) // Never resolves
    );

    renderJoinList('list123');

    expect(screen.getByText('Join Task List')).toBeInTheDocument();
    expect(document.querySelector('.ant-spin')).toBeInTheDocument();
  });

  it('shows list name and join form when list exists', async () => {
    vi.mocked(firestore.getListById).mockResolvedValue({ name: 'Family Tasks' });

    renderJoinList('list123');

    await waitFor(() => {
      expect(screen.getByText('Family Tasks')).toBeInTheDocument();
    });
    expect(screen.getByText('Choose a URL for this list')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Add to My Lists' })).toBeInTheDocument();
  });

  it('shows error message when list does not exist', async () => {
    vi.mocked(firestore.getListById).mockResolvedValue(null);

    renderJoinList('nonexistent');

    await waitFor(() => {
      expect(screen.getByText('Cannot Join List')).toBeInTheDocument();
    });
    expect(screen.getByText('List not found. It may have been deleted.')).toBeInTheDocument();
  });

  it('shows error message when loading fails with permission error', async () => {
    vi.mocked(firestore.getListById).mockRejectedValue(new Error('Missing or insufficient permissions'));

    renderJoinList('list123');

    await waitFor(() => {
      expect(screen.getByText('Cannot Join List')).toBeInTheDocument();
    });
    expect(screen.getByText(/Permission denied/)).toBeInTheDocument();
  });

  it('suggests slug based on list name', async () => {
    vi.mocked(firestore.getListById).mockResolvedValue({ name: 'Family Tasks' });

    renderJoinList('list123');

    await waitFor(() => {
      expect(screen.getByText('Family Tasks')).toBeInTheDocument();
    });

    const input = screen.getByRole('textbox');
    expect(input).toHaveValue('family-tasks');
  });

  it('calls setUserSlug and navigates on successful join', async () => {
    const user = userEvent.setup();
    vi.mocked(firestore.getListById).mockResolvedValue({ name: 'Home' });
    vi.mocked(firestore.setUserSlug).mockResolvedValue(undefined);

    renderJoinList('list123');

    await waitFor(() => {
      expect(screen.getByText('Home')).toBeInTheDocument();
    });

    const joinButton = screen.getByRole('button', { name: 'Add to My Lists' });
    await user.click(joinButton);

    await waitFor(() => {
      expect(firestore.setUserSlug).toHaveBeenCalledWith('user123', 'home', 'list123');
    });
    expect(mockNavigate).toHaveBeenCalledWith('home');
  });

  it('shows error when slug already exists', async () => {
    const user = userEvent.setup();
    const { message } = await import('antd');

    // Mock the subscription to return existing slugs
    vi.mocked(subscription.subscribeToUserSlugs).mockImplementation((_uid, dispatch) => {
      // Simulate the subscription immediately dispatching existing slugs
      setTimeout(() => {
        dispatch({ type: 'SET_USER_SLUGS', slugs: { home: 'existing-list' } });
      }, 0);
      return () => {};
    });

    vi.mocked(firestore.getListById).mockResolvedValue({ name: 'Home' });

    renderJoinList('list123');

    await waitFor(() => {
      expect(screen.getByText('Home')).toBeInTheDocument();
    });

    const joinButton = screen.getByRole('button', { name: 'Add to My Lists' });
    await user.click(joinButton);

    await waitFor(() => {
      expect(message.error).toHaveBeenCalledWith('You already have a list at "/home"');
    });
    expect(firestore.setUserSlug).not.toHaveBeenCalled();
  });

  it('allows custom slug input', async () => {
    const user = userEvent.setup();
    vi.mocked(firestore.getListById).mockResolvedValue({ name: 'Family Tasks' });
    vi.mocked(firestore.setUserSlug).mockResolvedValue(undefined);

    renderJoinList('list123');

    await waitFor(() => {
      expect(screen.getByText('Family Tasks')).toBeInTheDocument();
    });

    const input = screen.getByRole('textbox');
    await user.clear(input);
    await user.type(input, 'my-family');

    const joinButton = screen.getByRole('button', { name: 'Add to My Lists' });
    await user.click(joinButton);

    await waitFor(() => {
      expect(firestore.setUserSlug).toHaveBeenCalledWith('user123', 'my-family', 'list123');
    });
  });

  it('navigates to parent route on cancel', async () => {
    const user = userEvent.setup();
    vi.mocked(firestore.getListById).mockResolvedValue({ name: 'Home' });

    renderJoinList('list123');

    await waitFor(() => {
      expect(screen.getByText('Home')).toBeInTheDocument();
    });

    const cancelButton = screen.getByRole('button', { name: 'Cancel' });
    await user.click(cancelButton);

    // Uses relative navigation to go back to parent route
    expect(mockNavigate).toHaveBeenCalledWith('..');
  });

  // === New tests for fixes ===

  describe('auth check fix', () => {
    it('shows error when user is not authenticated (null user)', async () => {
      vi.mocked(firestore.getListById).mockResolvedValue({ name: 'Home' });

      renderJoinList('list123', null); // Pass null user (not authenticated)

      await waitFor(() => {
        expect(screen.getByText('Cannot Join List')).toBeInTheDocument();
      });
      expect(screen.getByText('You must be signed in to join a list')).toBeInTheDocument();
    });

    it('waits while auth is loading (undefined user)', () => {
      vi.mocked(firestore.getListById).mockResolvedValue({ name: 'Home' });

      // Render with undefined user (auth still loading)
      render(
        <AuthContext.Provider value={{ user: undefined as any, loading: true }}>
          <UpkeepProvider>
            <MemoryRouter initialEntries={['/join/list123']}>
              <Routes>
                <Route path="/join/:listId" element={<JoinList />} />
              </Routes>
            </MemoryRouter>
          </UpkeepProvider>
        </AuthContext.Provider>
      );

      // Should show loading state while auth is determining
      expect(screen.getByText('Join Task List')).toBeInTheDocument();
      expect(document.querySelector('.ant-spin')).toBeInTheDocument();
    });
  });

  describe('slug validation fix', () => {
    it('rejects slugs with only special characters', async () => {
      const user = userEvent.setup();
      const { message } = await import('antd');
      vi.mocked(firestore.getListById).mockResolvedValue({ name: 'Test List' });

      renderJoinList('list123');

      await waitFor(() => {
        expect(screen.getByText('Test List')).toBeInTheDocument();
      });

      const input = screen.getByRole('textbox');
      await user.clear(input);
      await user.type(input, '---');

      const joinButton = screen.getByRole('button', { name: 'Add to My Lists' });
      await user.click(joinButton);

      expect(message.error).toHaveBeenCalledWith('Slug must contain at least one letter or number');
      expect(firestore.setUserSlug).not.toHaveBeenCalled();
    });

    it('rejects empty slugs', async () => {
      const user = userEvent.setup();
      vi.mocked(firestore.getListById).mockResolvedValue({ name: 'Test List' });

      renderJoinList('list123');

      await waitFor(() => {
        expect(screen.getByText('Test List')).toBeInTheDocument();
      });

      const input = screen.getByRole('textbox');
      await user.clear(input);

      const joinButton = screen.getByRole('button', { name: 'Add to My Lists' });
      // Button should be disabled or input validation prevents submission
      await user.click(joinButton);

      // Should not call setUserSlug with empty slug
      expect(firestore.setUserSlug).not.toHaveBeenCalled();
    });

    it('accepts valid slugs with alphanumeric characters', async () => {
      const user = userEvent.setup();
      vi.mocked(firestore.getListById).mockResolvedValue({ name: 'Test List' });
      vi.mocked(firestore.setUserSlug).mockResolvedValue(undefined);

      renderJoinList('list123');

      await waitFor(() => {
        expect(screen.getByText('Test List')).toBeInTheDocument();
      });

      const input = screen.getByRole('textbox');
      await user.clear(input);
      await user.type(input, 'my-list-123');

      const joinButton = screen.getByRole('button', { name: 'Add to My Lists' });
      await user.click(joinButton);

      await waitFor(() => {
        expect(firestore.setUserSlug).toHaveBeenCalledWith('user123', 'my-list-123', 'list123');
      });
    });

    it('strips leading and trailing dashes from slugs', async () => {
      const user = userEvent.setup();
      vi.mocked(firestore.getListById).mockResolvedValue({ name: 'Test List' });
      vi.mocked(firestore.setUserSlug).mockResolvedValue(undefined);

      renderJoinList('list123');

      await waitFor(() => {
        expect(screen.getByText('Test List')).toBeInTheDocument();
      });

      const input = screen.getByRole('textbox');
      await user.clear(input);
      await user.type(input, '--my-list--');

      const joinButton = screen.getByRole('button', { name: 'Add to My Lists' });
      await user.click(joinButton);

      await waitFor(() => {
        // Should strip leading/trailing dashes
        expect(firestore.setUserSlug).toHaveBeenCalledWith('user123', 'my-list', 'list123');
      });
    });
  });
});
