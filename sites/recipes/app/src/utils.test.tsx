import { Recipe } from 'schema-dts';
import { BoxEntry, RecipeEntry, UserEntry } from './storage';
import { AppState, Visibility } from './types';
import {
  strToIngredients,
  ingredientsToStr,
  strToInstructions,
  instructionsToStr,
  authorToStr,
  strToAuthor,
  commentToStr,
  strToComment,
  parseCategories,
  formatCategories,
  decodeStr,
} from './converters';
import {
  getRecipeFromState,
  getBoxFromState,
  getUserFromState,
  getAppUserFromState,
} from './state';
import { canUpdateRecipe } from './utils';

describe('ingredient conversions', () => {
  it('converts multiline string to ingredient array', () => {
    const input = "1 cup flour\n2 eggs\n1 tsp salt";
    const result = strToIngredients(input);
    expect(result).toEqual(["1 cup flour", "2 eggs", "1 tsp salt"]);
  });

  it('handles empty string', () => {
    expect(strToIngredients("")).toEqual([""]);
  });

  it('handles single ingredient', () => {
    expect(strToIngredients("1 cup flour")).toEqual(["1 cup flour"]);
  });

  it('converts ingredient array back to string', () => {
    const ingredients = ["1 cup flour", "2 eggs", "1 tsp salt"];
    const result = ingredientsToStr(ingredients);
    expect(result).toBe("1 cup flour\n2 eggs\n1 tsp salt");
  });

  it('round-trips ingredients correctly', () => {
    const original = "flour\neggs\nsugar";
    const parsed = strToIngredients(original);
    const backToStr = ingredientsToStr(parsed);
    expect(backToStr).toBe(original);
  });
});

describe('instruction conversions', () => {
  it('converts multiline string to HowToStep array', () => {
    const input = "Mix ingredients\nBake at 350F\nCool for 10 min";
    const result = strToInstructions(input);
    expect(result).toEqual([
      { "@type": "HowToStep", text: "Mix ingredients" },
      { "@type": "HowToStep", text: "Bake at 350F" },
      { "@type": "HowToStep", text: "Cool for 10 min" },
    ]);
  });

  it('filters out empty lines', () => {
    const input = "Step one\n\nStep two";
    const result = strToInstructions(input);
    expect(result).toEqual([
      { "@type": "HowToStep", text: "Step one" },
      { "@type": "HowToStep", text: "Step two" },
    ]);
  });

  it('handles empty string', () => {
    expect(strToInstructions("")).toEqual([]);
  });

  it('converts HowToStep array back to string', () => {
    const instructions = [
      { "@type": "HowToStep" as const, text: "Mix ingredients" },
      { "@type": "HowToStep" as const, text: "Bake at 350F" },
    ];
    const result = instructionsToStr(instructions);
    expect(result).toBe("Mix ingredients\n\nBake at 350F");
  });

  it('handles string instructions', () => {
    expect(instructionsToStr("Just do it")).toBe("Just do it");
  });

  it('handles undefined instructions', () => {
    expect(instructionsToStr(undefined)).toBe("");
  });

  it('handles steps with extra whitespace', () => {
    const instructions = [
      { "@type": "HowToStep" as const, text: "  Mix ingredients  " },
    ];
    expect(instructionsToStr(instructions)).toBe("Mix ingredients");
  });
});

describe('author conversions', () => {
  it('creates Person author from string', () => {
    const result = strToAuthor("Julia Child");
    expect(result).toEqual({ "@type": "Person", name: "Julia Child" });
  });

  it('extracts name from Person object', () => {
    const author = { "@type": "Person" as const, name: "Julia Child" };
    expect(authorToStr(author)).toBe("Julia Child");
  });

  it('extracts name from simple object with name property', () => {
    const author = { name: "Chef Bob" };
    expect(authorToStr(author as any)).toBe("Chef Bob");
  });

  it('handles array of Person authors', () => {
    const authors = [
      { "@type": "Person" as const, name: "Alice" },
      { "@type": "Person" as const, name: "Bob" },
    ];
    expect(authorToStr(authors)).toBe("Alice, Bob");
  });

  it('filters non-Person types in array', () => {
    const authors = [
      { "@type": "Person" as const, name: "Alice" },
      { "@type": "Organization" as const, name: "Acme Corp" },
    ];
    expect(authorToStr(authors as any)).toBe("Alice");
  });

  it('returns undefined for undefined author', () => {
    expect(authorToStr(undefined)).toBeUndefined();
  });
});

describe('comment conversions', () => {
  it('creates Comment from string', () => {
    const result = strToComment("Great recipe!");
    expect(result).toEqual({ "@type": "Comment", text: "Great recipe!" });
  });

  it('extracts text from Comment object', () => {
    const comment = { text: "Delicious!" };
    expect(commentToStr(comment as any)).toBe("Delicious!");
  });

  it('returns undefined for undefined comment', () => {
    expect(commentToStr(undefined)).toBeUndefined();
  });
});

describe('category parsing', () => {
  it('parses array of categories', () => {
    const categories = ["Dinner", "Italian", "Quick"];
    expect(parseCategories(categories)).toEqual(["Dinner", "Italian", "Quick"]);
  });

  it('wraps single string category in array', () => {
    expect(parseCategories("Breakfast")).toEqual(["Breakfast"]);
  });

  it('returns empty array for undefined', () => {
    expect(parseCategories(undefined)).toEqual([]);
  });

  it('formatCategories returns lowercase array', () => {
    const tags = ["A", "B", "C"];
    expect(formatCategories(tags)).toEqual(["a", "b", "c"]);
  });
});

describe('decodeStr', () => {
  it('decodes HTML decimal apostrophe entity', () => {
    expect(decodeStr("It&#39;s delicious")).toBe("It's delicious");
  });

  it('decodes HTML hex apostrophe entity', () => {
    expect(decodeStr("P. F. Chang&#x27;s")).toBe("P. F. Chang's");
  });

  it('decodes multiple entities', () => {
    expect(decodeStr("Tom &amp; Jerry&#x27;s &quot;Best&quot; Show")).toBe("Tom & Jerry's \"Best\" Show");
  });

  it('returns undefined for undefined input', () => {
    expect(decodeStr(undefined)).toBeUndefined();
  });

  it('returns string unchanged if no entities', () => {
    expect(decodeStr("Plain text")).toBe("Plain text");
  });
});

describe('canUpdateRecipe', () => {
  const createUser = (id: string): UserEntry =>
    new UserEntry("Test User", Visibility.private, [], new Date(), new Date(), id);

  const createRecipe = (owners: string[]): RecipeEntry =>
    new RecipeEntry(
      { "@type": "Recipe", name: "Test" },
      owners,
      Visibility.private,
      owners[0],
      "recipe1",
      new Date(),
      new Date(),
      owners[0]
    );

  const createBox = (owners: string[]): BoxEntry =>
    new BoxEntry(
      { name: "Test Box" },
      owners,
      Visibility.private,
      owners[0],
      "box1",
      new Date(),
      new Date(),
      owners[0]
    );

  it('returns true when user owns recipe', () => {
    const user = createUser("user1");
    const recipe = createRecipe(["user1"]);
    const box = createBox(["other"]);
    expect(canUpdateRecipe(recipe, box, user)).toBe(true);
  });

  it('returns true when user owns box', () => {
    const user = createUser("user1");
    const recipe = createRecipe(["other"]);
    const box = createBox(["user1"]);
    expect(canUpdateRecipe(recipe, box, user)).toBe(true);
  });

  it('returns false when user owns neither', () => {
    const user = createUser("user1");
    const recipe = createRecipe(["other1"]);
    const box = createBox(["other2"]);
    expect(canUpdateRecipe(recipe, box, user)).toBe(false);
  });

  it('returns false for undefined user', () => {
    const recipe = createRecipe(["user1"]);
    const box = createBox(["user1"]);
    expect(canUpdateRecipe(recipe, box, undefined)).toBe(false);
  });

  it('returns false for undefined recipe', () => {
    const user = createUser("user1");
    const box = createBox(["user1"]);
    expect(canUpdateRecipe(undefined, box, user)).toBe(false);
  });

  it('returns false for undefined box', () => {
    const user = createUser("user1");
    const recipe = createRecipe(["user1"]);
    expect(canUpdateRecipe(recipe, undefined, user)).toBe(false);
  });
});

describe('state accessor functions', () => {
  const createTestState = (): AppState => {
    const user = new UserEntry("Test", Visibility.private, [], new Date(), new Date(), "user1");
    const recipe = new RecipeEntry(
      { "@type": "Recipe", name: "Test Recipe" },
      ["user1"],
      Visibility.private,
      "user1",
      "recipe1",
      new Date(),
      new Date(),
      "user1"
    );
    const box = new BoxEntry(
      { name: "Test Box" },
      ["user1"],
      Visibility.private,
      "user1",
      "box1",
      new Date(),
      new Date(),
      "user1"
    );
    box.recipes.set("recipe1", recipe);

    return {
      boxes: new Map([["box1", box]]),
      users: new Map([["user1", user]]),
      authUser: { uid: "user1" } as any,
      writeable: true,
      loading: 0,
    };
  };

  describe('getRecipeFromState', () => {
    it('returns recipe when box and recipe exist', () => {
      const state = createTestState();
      const recipe = getRecipeFromState(state, "box1", "recipe1");
      expect(recipe).toBeDefined();
      expect(recipe?.data.name).toBe("Test Recipe");
    });

    it('returns undefined for nonexistent box', () => {
      const state = createTestState();
      expect(getRecipeFromState(state, "nonexistent", "recipe1")).toBeUndefined();
    });

    it('returns undefined for nonexistent recipe', () => {
      const state = createTestState();
      expect(getRecipeFromState(state, "box1", "nonexistent")).toBeUndefined();
    });
  });

  describe('getBoxFromState', () => {
    it('returns box when it exists', () => {
      const state = createTestState();
      const box = getBoxFromState(state, "box1");
      expect(box).toBeDefined();
      expect(box?.data.name).toBe("Test Box");
    });

    it('returns undefined for nonexistent box', () => {
      const state = createTestState();
      expect(getBoxFromState(state, "nonexistent")).toBeUndefined();
    });
  });

  describe('getUserFromState', () => {
    it('returns user when they exist', () => {
      const state = createTestState();
      const user = getUserFromState(state, "user1");
      expect(user).toBeDefined();
      expect(user?.name).toBe("Test");
    });

    it('returns undefined for nonexistent user', () => {
      const state = createTestState();
      expect(getUserFromState(state, "nonexistent")).toBeUndefined();
    });
  });

  describe('getAppUserFromState', () => {
    it('returns current auth user from state', () => {
      const state = createTestState();
      const user = getAppUserFromState(state);
      expect(user).toBeDefined();
      expect(user?.id).toBe("user1");
    });

    it('returns undefined when not authenticated', () => {
      const state = createTestState();
      state.authUser = null;
      expect(getAppUserFromState(state)).toBeUndefined();
    });
  });
});
