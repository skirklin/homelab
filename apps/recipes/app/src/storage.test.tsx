import {
  type PlainBox,
  type PlainRecipe,
  type PlainUser,
  cloneBox,
  cloneRecipe,
  getBoxName,
  getRecipeData,
  getRecipeDescription,
  getRecipeName,
} from './storage';
import { EnrichmentStatus, Visibility } from './types';

describe('PlainRecipe helpers', () => {
  const createRecipe = (name = "Test Recipe"): PlainRecipe => ({
    id: "recipe123",
    data: {
      "@type": "Recipe",
      name,
      description: "A test recipe",
      recipeIngredient: ["flour", "sugar"],
      recipeInstructions: [{ "@type": "HowToStep", text: "Mix well" }],
    },
    owners: ["user1", "user2"],
    editing: false,
    creator: "user1",
    visibility: Visibility.private,
    created: new Date("2024-01-01"),
    updated: new Date("2024-06-01"),
    lastUpdatedBy: "user2",
    enrichmentStatus: EnrichmentStatus.needed,
  });

  describe('shape', () => {
    it('initializes with provided values', () => {
      const recipe = createRecipe();

      expect(recipe.data.name).toBe("Test Recipe");
      expect(recipe.owners).toEqual(["user1", "user2"]);
      expect(recipe.visibility).toBe(Visibility.private);
      expect(recipe.creator).toBe("user1");
      expect(recipe.id).toBe("recipe123");
      expect(recipe.lastUpdatedBy).toBe("user2");
      expect(recipe.editing).toBe(false);
    });
  });

  describe('cloneRecipe', () => {
    it('creates a deep copy of the recipe', () => {
      const original = createRecipe();
      const cloned = cloneRecipe(original);

      expect(cloned).not.toBe(original);
      expect(cloned.data).not.toBe(original.data);
      expect(cloned.data.name).toBe(original.data.name);
    });

    it('preserves editing state', () => {
      const original = { ...createRecipe(), editing: true };
      const cloned = cloneRecipe(original);

      expect(cloned.editing).toBe(true);
    });

    it('modifications to clone do not affect original', () => {
      const original = createRecipe();
      const cloned = cloneRecipe(original);

      (cloned.data as { name: string }).name = "Modified Name";

      expect(original.data.name).toBe("Test Recipe");
    });
  });

  describe('getRecipeData', () => {
    it('returns data when no changes pending', () => {
      const recipe = createRecipe();

      expect(getRecipeData(recipe)).toBe(recipe.data);
    });

    it('returns changed when changes are pending', () => {
      const recipe = { ...createRecipe(), changed: { "@type": "Recipe" as const, name: "Modified" } };

      expect(getRecipeData(recipe)).toBe(recipe.changed);
      expect(getRecipeData(recipe).name).toBe("Modified");
    });
  });

  describe('getRecipeName', () => {
    it('returns recipe name from data', () => {
      const recipe = createRecipe("Apple Pie");
      expect(getRecipeName(recipe)).toBe("Apple Pie");
    });

    it('returns changed name when pending', () => {
      const recipe = { ...createRecipe("Apple Pie"), changed: { "@type": "Recipe" as const, name: "Cherry Pie" } };

      expect(getRecipeName(recipe)).toBe("Cherry Pie");
    });

    it('decodes HTML entities in name', () => {
      const recipe = createRecipe("It&#39;s Good");
      expect(getRecipeName(recipe)).toBe("It's Good");
    });
  });

  describe('getRecipeDescription', () => {
    it('returns recipe description', () => {
      const recipe = createRecipe();
      expect(getRecipeDescription(recipe)).toBe("A test recipe");
    });

    it('returns changed description when pending', () => {
      const recipe = { ...createRecipe(), changed: { "@type": "Recipe" as const, name: "Test", description: "New description" } };

      expect(getRecipeDescription(recipe)).toBe("New description");
    });

    it('decodes HTML entities in description', () => {
      const recipe: PlainRecipe = {
        id: "id",
        data: { "@type": "Recipe", name: "Test", description: "It&#39;s tasty" },
        owners: ["user1"],
        editing: false,
        creator: "user1",
        visibility: Visibility.private,
        created: new Date(),
        updated: new Date(),
        lastUpdatedBy: "user1",
        enrichmentStatus: EnrichmentStatus.needed,
      };
      expect(getRecipeDescription(recipe)).toBe("It's tasty");
    });
  });
});

describe('PlainBox helpers', () => {
  const createBox = (name = "Test Box"): PlainBox => ({
    id: "box123",
    data: { name, description: "A test box" },
    owners: ["user1", "user2"],
    subscribers: [],
    creator: "user1",
    visibility: Visibility.public,
    recipes: new Map(),
    created: new Date("2024-01-01"),
    updated: new Date("2024-06-01"),
    lastUpdatedBy: "user2",
  });

  describe('shape', () => {
    it('initializes with provided values', () => {
      const box = createBox();

      expect(box.data.name).toBe("Test Box");
      expect(box.data.description).toBe("A test box");
      expect(box.owners).toEqual(["user1", "user2"]);
      expect(box.visibility).toBe(Visibility.public);
      expect(box.creator).toBe("user1");
      expect(box.id).toBe("box123");
      expect(box.lastUpdatedBy).toBe("user2");
      expect(box.recipes.size).toBe(0);
    });
  });

  describe('cloneBox', () => {
    it('creates a deep copy of the box', () => {
      const original = createBox();
      const recipe: PlainRecipe = {
        id: "r1",
        data: { "@type": "Recipe", name: "Test" },
        owners: ["user1"],
        editing: false,
        creator: "user1",
        visibility: Visibility.private,
        created: new Date(),
        updated: new Date(),
        lastUpdatedBy: "user1",
        enrichmentStatus: EnrichmentStatus.needed,
      };
      original.recipes.set("r1", recipe);

      const cloned = cloneBox(original);

      expect(cloned).not.toBe(original);
      expect(cloned.data).not.toBe(original.data);
      expect(cloned.recipes).not.toBe(original.recipes);
      expect(cloned.data.name).toBe(original.data.name);
      expect(cloned.recipes.size).toBe(1);
    });

    it('creates independent owners array', () => {
      const original = createBox();
      const cloned = cloneBox(original);

      cloned.owners.push("user3");

      expect(original.owners).toEqual(["user1", "user2"]);
      expect(cloned.owners).toEqual(["user1", "user2", "user3"]);
    });

    it('modifications to clone do not affect original', () => {
      const original = createBox();
      const cloned = cloneBox(original);

      cloned.data.name = "Modified Name";

      expect(original.data.name).toBe("Test Box");
    });
  });

  describe('getBoxName', () => {
    it('returns box name', () => {
      const box = createBox("Family Recipes");
      expect(getBoxName(box)).toBe("Family Recipes");
    });

    it('decodes HTML entities in name', () => {
      const box: PlainBox = {
        id: "id",
        data: { name: "Mom&#39;s Recipes" },
        owners: ["user1"],
        subscribers: [],
        creator: "user1",
        visibility: Visibility.private,
        recipes: new Map(),
        created: new Date(),
        updated: new Date(),
        lastUpdatedBy: "user1",
      };
      expect(getBoxName(box)).toBe("Mom's Recipes");
    });
  });
});

describe('adapters lastUpdatedBy fallback', () => {
  // The previous class-based code defaulted lastUpdatedBy to creator when the
  // backend didn't supply it; the adapters preserve that fallback so the
  // ownership UI stays meaningful for legacy records.
  it('recipeFromBackend defaults lastUpdatedBy to creator when missing', async () => {
    const { recipeFromBackend } = await import('./adapters');
    const recipe = recipeFromBackend({
      id: 'r1',
      data: { name: 'X' },
      owners: ['u1'],
      visibility: 'private',
      creator: 'u1',
      created: new Date().toISOString(),
      updated: new Date().toISOString(),
      lastUpdatedBy: '', // empty string from PB
    } as Parameters<typeof recipeFromBackend>[0]);
    expect(recipe.lastUpdatedBy).toBe('u1');
  });

  it('boxFromBackend defaults lastUpdatedBy to creator when missing', async () => {
    const { boxFromBackend } = await import('./adapters');
    const box = boxFromBackend({
      id: 'b1',
      name: 'My Box',
      owners: ['u1'],
      visibility: 'private',
      creator: 'u1',
      created: new Date().toISOString(),
      updated: new Date().toISOString(),
      lastUpdatedBy: '',
    } as Parameters<typeof boxFromBackend>[0]);
    expect(box.lastUpdatedBy).toBe('u1');
  });
});

describe('PlainUser shape', () => {
  it('holds the expected fields', () => {
    const lastSeen = new Date("2024-01-01");
    const newSeen = new Date("2024-02-01");
    const user: PlainUser = {
      id: "user123",
      name: "John Doe",
      visibility: Visibility.public,
      boxes: ["box1", "box2"],
      lastSeen,
      newSeen,
      lastSeenUpdateVersion: 0,
    };

    expect(user.name).toBe("John Doe");
    expect(user.visibility).toBe(Visibility.public);
    expect(user.boxes).toEqual(["box1", "box2"]);
    expect(user.lastSeen).toBe(lastSeen);
    expect(user.newSeen).toBe(newSeen);
    expect(user.id).toBe("user123");
  });
});
