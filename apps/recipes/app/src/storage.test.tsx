import { BoxEntry, RecipeEntry, UserEntry } from './storage';
import { Visibility } from './types';

describe('RecipeEntry', () => {
  const createRecipe = (name = "Test Recipe"): RecipeEntry =>
    new RecipeEntry(
      {
        "@type": "Recipe",
        name,
        description: "A test recipe",
        recipeIngredient: ["flour", "sugar"],
        recipeInstructions: [{ "@type": "HowToStep", text: "Mix well" }],
      },
      ["user1", "user2"],
      Visibility.private,
      "user1",
      "recipe123",
      new Date("2024-01-01"),
      new Date("2024-06-01"),
      "user2"
    );

  describe('constructor', () => {
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

    it('defaults lastUpdatedBy to creator if not provided', () => {
      const recipe = new RecipeEntry(
        { "@type": "Recipe", name: "Test" },
        ["user1"],
        Visibility.private,
        "user1",
        "id",
        new Date(),
        new Date(),
        "" // empty string
      );
      expect(recipe.lastUpdatedBy).toBe("user1");
    });
  });

  describe('clone', () => {
    it('creates a deep copy of the recipe', () => {
      const original = createRecipe();
      const cloned = original.clone();

      expect(cloned).not.toBe(original);
      expect(cloned.data).not.toBe(original.data);
      expect(cloned.data.name).toBe(original.data.name);
    });

    it('preserves editing state', () => {
      const original = createRecipe();
      original.editing = true;

      const cloned = original.clone();

      expect(cloned.editing).toBe(true);
    });

    it('modifications to clone do not affect original', () => {
      const original = createRecipe();
      const cloned = original.clone();

      cloned.data.name = "Modified Name";

      expect(original.data.name).toBe("Test Recipe");
    });
  });

  describe('toString', () => {
    it('returns formatted recipe string', () => {
      const recipe = createRecipe("Chocolate Cake");
      expect(recipe.toString()).toBe("Recipe: Chocolate Cake");
    });
  });

  describe('getData', () => {
    it('returns data when no changes pending', () => {
      const recipe = createRecipe();

      expect(recipe.getData()).toBe(recipe.data);
    });

    it('returns changed when changes are pending', () => {
      const recipe = createRecipe();
      recipe.changed = { "@type": "Recipe", name: "Modified" };

      expect(recipe.getData()).toBe(recipe.changed);
      expect(recipe.getData().name).toBe("Modified");
    });
  });

  describe('getName', () => {
    it('returns recipe name from data', () => {
      const recipe = createRecipe("Apple Pie");
      expect(recipe.getName()).toBe("Apple Pie");
    });

    it('returns changed name when pending', () => {
      const recipe = createRecipe("Apple Pie");
      recipe.changed = { "@type": "Recipe", name: "Cherry Pie" };

      expect(recipe.getName()).toBe("Cherry Pie");
    });

    it('decodes HTML entities in name', () => {
      const recipe = createRecipe("It&#39;s Good");
      expect(recipe.getName()).toBe("It's Good");
    });
  });

  describe('getDescription', () => {
    it('returns recipe description', () => {
      const recipe = createRecipe();
      expect(recipe.getDescription()).toBe("A test recipe");
    });

    it('returns changed description when pending', () => {
      const recipe = createRecipe();
      recipe.changed = { "@type": "Recipe", name: "Test", description: "New description" };

      expect(recipe.getDescription()).toBe("New description");
    });

    it('decodes HTML entities in description', () => {
      const recipe = new RecipeEntry(
        { "@type": "Recipe", name: "Test", description: "It&#39;s tasty" },
        ["user1"],
        Visibility.private,
        "user1",
        "id",
        new Date(),
        new Date(),
        "user1"
      );
      expect(recipe.getDescription()).toBe("It's tasty");
    });
  });

});

describe('BoxEntry', () => {
  const createBox = (name = "Test Box"): BoxEntry =>
    new BoxEntry(
      { name, description: "A test box" },
      ["user1", "user2"],
      Visibility.public,
      "user1",
      "box123",
      new Date("2024-01-01"),
      new Date("2024-06-01"),
      "user2"
    );

  describe('constructor', () => {
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

    it('defaults lastUpdatedBy to creator if not provided', () => {
      const box = new BoxEntry(
        { name: "Test" },
        ["user1"],
        Visibility.private,
        "user1",
        "id",
        new Date(),
        new Date(),
        ""
      );
      expect(box.lastUpdatedBy).toBe("user1");
    });
  });

  describe('toString', () => {
    it('returns formatted box string', () => {
      const box = createBox("My Recipes");
      expect(box.toString()).toBe("Box: box123 = My Recipes");
    });
  });

  describe('clone', () => {
    it('creates a deep copy of the box', () => {
      const original = createBox();
      original.recipes.set("r1", new RecipeEntry(
        { "@type": "Recipe", name: "Test" },
        ["user1"],
        Visibility.private,
        "user1",
        "r1",
        new Date(),
        new Date(),
        "user1"
      ));

      const cloned = original.clone();

      expect(cloned).not.toBe(original);
      expect(cloned.data).not.toBe(original.data);
      expect(cloned.recipes).not.toBe(original.recipes);
      expect(cloned.data.name).toBe(original.data.name);
      expect(cloned.recipes.size).toBe(1);
    });

    it('creates independent owners array', () => {
      const original = createBox();
      const cloned = original.clone();

      cloned.owners.push("user3");

      expect(original.owners).toEqual(["user1", "user2"]);
      expect(cloned.owners).toEqual(["user1", "user2", "user3"]);
    });

    it('modifications to clone do not affect original', () => {
      const original = createBox();
      const cloned = original.clone();

      cloned.data.name = "Modified Name";

      expect(original.data.name).toBe("Test Box");
    });
  });

  describe('getName', () => {
    it('returns box name', () => {
      const box = createBox("Family Recipes");
      expect(box.getName()).toBe("Family Recipes");
    });

    it('decodes HTML entities in name', () => {
      const box = new BoxEntry(
        { name: "Mom&#39;s Recipes" },
        ["user1"],
        Visibility.private,
        "user1",
        "id",
        new Date(),
        new Date(),
        "user1"
      );
      expect(box.getName()).toBe("Mom's Recipes");
    });
  });
});

describe('UserEntry', () => {
  describe('constructor', () => {
    it('initializes with provided values', () => {
      const lastSeen = new Date("2024-01-01");
      const newSeen = new Date("2024-02-01");
      const user = new UserEntry(
        "John Doe",
        Visibility.public,
        ["box1", "box2"],
        lastSeen,
        newSeen,
        "user123"
      );

      expect(user.name).toBe("John Doe");
      expect(user.visibility).toBe(Visibility.public);
      expect(user.boxes).toEqual(["box1", "box2"]);
      expect(user.lastSeen).toBe(lastSeen);
      expect(user.newSeen).toBe(newSeen);
      expect(user.id).toBe("user123");
    });
  });
});
