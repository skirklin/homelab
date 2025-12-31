import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Routes, Route } from 'react-router-dom';
import { JoinList } from './JoinList';
import * as firestore from '../firestore';
import * as context from '../context';

// Mock the firestore module
vi.mock('../firestore', () => ({
  getListById: vi.fn(),
  setUserSlug: vi.fn(),
}));

// Mock the context
vi.mock('../context', () => ({
  useAppContext: vi.fn(),
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

function renderJoinList(listId: string) {
  return render(
    <MemoryRouter initialEntries={[`/join/${listId}`]}>
      <Routes>
        <Route path="/join/:listId" element={<JoinList />} />
      </Routes>
    </MemoryRouter>
  );
}

describe('JoinList', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(context.useAppContext).mockReturnValue({
      state: {
        authUser: { uid: 'user123' } as any,
        userSlugs: {},
        list: null,
        tasks: new Map(),
        completions: [],
        loading: false,
      },
      dispatch: vi.fn(),
    });
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
    expect(mockNavigate).toHaveBeenCalledWith('/home');
  });

  it('shows error when slug already exists', async () => {
    const user = userEvent.setup();
    const { message } = await import('antd');

    vi.mocked(context.useAppContext).mockReturnValue({
      state: {
        authUser: { uid: 'user123' } as any,
        userSlugs: { home: 'existing-list' },
        list: null,
        tasks: new Map(),
        completions: [],
        loading: false,
      },
      dispatch: vi.fn(),
    });
    vi.mocked(firestore.getListById).mockResolvedValue({ name: 'Home' });

    renderJoinList('list123');

    await waitFor(() => {
      expect(screen.getByText('Home')).toBeInTheDocument();
    });

    const joinButton = screen.getByRole('button', { name: 'Add to My Lists' });
    await user.click(joinButton);

    expect(message.error).toHaveBeenCalledWith('You already have a list at "/home"');
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

  it('navigates to home on cancel', async () => {
    const user = userEvent.setup();
    vi.mocked(firestore.getListById).mockResolvedValue({ name: 'Home' });

    renderJoinList('list123');

    await waitFor(() => {
      expect(screen.getByText('Home')).toBeInTheDocument();
    });

    const cancelButton = screen.getByRole('button', { name: 'Cancel' });
    await user.click(cancelButton);

    expect(mockNavigate).toHaveBeenCalledWith('/');
  });
});
