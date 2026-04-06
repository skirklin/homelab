import { describe, it, expect, vi, beforeEach } from 'vitest';
import { getDoc, setDoc, updateDoc, doc } from 'firebase/firestore';
import { getListById, setUserSlug, getUserSlugs } from './firestore';

// Mock firebase/firestore
vi.mock('firebase/firestore', async () => {
  const actual = await vi.importActual('firebase/firestore');
  return {
    ...actual,
    getDoc: vi.fn(),
    setDoc: vi.fn(),
    updateDoc: vi.fn(),
    doc: vi.fn(() => ({ id: 'mock-doc-ref' })),
    collection: vi.fn(),
    arrayUnion: vi.fn((val) => ({ _arrayUnion: val })),
  };
});

// Mock the backend module
vi.mock('./backend', () => ({
  db: {},
}));

describe('getListById', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('returns list data when list exists', async () => {
    const mockListData = { name: 'My Tasks', owners: ['user1'] };
    vi.mocked(getDoc).mockResolvedValue({
      exists: () => true,
      data: () => mockListData,
    } as any);

    const result = await getListById('list123');

    expect(result).toEqual({ name: 'My Tasks' });
    expect(doc).toHaveBeenCalledWith({}, 'taskLists', 'list123');
  });

  it('returns null when list does not exist', async () => {
    vi.mocked(getDoc).mockResolvedValue({
      exists: () => false,
      data: () => null,
    } as any);

    const result = await getListById('nonexistent');

    expect(result).toBeNull();
  });
});

describe('getUserSlugs', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('returns user slugs when user profile exists', async () => {
    const mockUserData = { householdSlugs: { home: 'list1', work: 'list2' } };
    vi.mocked(getDoc).mockResolvedValue({
      exists: () => true,
      data: () => mockUserData,
    } as any);

    const result = await getUserSlugs('user123');

    expect(result).toEqual({ home: 'list1', work: 'list2' });
  });

  it('returns empty object when user profile does not exist', async () => {
    vi.mocked(getDoc).mockResolvedValue({
      exists: () => false,
      data: () => null,
    } as any);

    const result = await getUserSlugs('newuser');

    expect(result).toEqual({});
  });

  it('returns empty object when householdSlugs is undefined', async () => {
    vi.mocked(getDoc).mockResolvedValue({
      exists: () => true,
      data: () => ({}),
    } as any);

    const result = await getUserSlugs('user123');

    expect(result).toEqual({});
  });
});

describe('setUserSlug', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('updates existing user profile with new slug', async () => {
    const existingData = { householdSlugs: { home: 'list1' } };
    vi.mocked(getDoc).mockResolvedValue({
      exists: () => true,
      data: () => existingData,
    } as any);

    await setUserSlug('user123', 'work', 'list2');

    expect(updateDoc).toHaveBeenCalledWith(
      expect.anything(),
      { householdSlugs: { home: 'list1', work: 'list2' } }
    );
  });

  it('creates new user profile when user does not exist', async () => {
    vi.mocked(getDoc).mockResolvedValue({
      exists: () => false,
      data: () => null,
    } as any);

    await setUserSlug('newuser', 'home', 'list1');

    expect(setDoc).toHaveBeenCalledWith(
      expect.anything(),
      { householdSlugs: { home: 'list1' } }
    );
  });

  it('adds user to list owners', async () => {
    vi.mocked(getDoc).mockResolvedValue({
      exists: () => true,
      data: () => ({ householdSlugs: {} }),
    } as any);

    await setUserSlug('user123', 'home', 'list1');

    // Should call updateDoc twice: once for user profile, once for list owners
    expect(updateDoc).toHaveBeenCalledTimes(2);
    expect(updateDoc).toHaveBeenLastCalledWith(
      expect.anything(),
      { owners: expect.objectContaining({ _arrayUnion: 'user123' }) }
    );
  });
});
