import { recipeBoxReducer, initState } from './context';
import { BoxEntry, RecipeEntry, UserEntry } from './storage';
import { AppState, Visibility } from './types';

const createRecipe = (name: string, id: string): RecipeEntry =>
  new RecipeEntry(
    { "@type": "Recipe", name, recipeIngredient: ["flour"], recipeInstructions: [] },
    ["user1"],
    Visibility.private,
    "user1",
    id,
    new Date(),
    new Date(),
    "user1"
  );

const createBox = (name: string, id: string): BoxEntry =>
  new BoxEntry(
    { name },
    ["user1"],
    Visibility.private,
    "user1",
    id,
    new Date(),
    new Date(),
    "user1"
  );

const createUser = (name: string, id: string): UserEntry =>
  new UserEntry(name, Visibility.private, [], new Date(), new Date(), id);

const createStateWithBox = (): AppState => {
  const box = createBox("Test Box", "box1");
  const recipe = createRecipe("Test Recipe", "recipe1");
  box.recipes.set("recipe1", recipe);

  return {
    ...initState(),
    boxes: new Map([["box1", box]]),
    users: new Map([["user1", createUser("Test User", "user1")]]),
  };
};

describe('recipeBoxReducer', () => {
  describe('initState', () => {
    it('creates empty initial state', () => {
      const state = initState();
      expect(state.boxes.size).toBe(0);
      expect(state.users.size).toBe(0);
      expect(state.authUser).toBeNull();
      expect(state.writeable).toBe(true);
      expect(state.loading).toBe(0);
    });
  });

  describe('loading actions', () => {
    it('INCR_LOADING increments loading counter', () => {
      const state = initState();
      const newState = recipeBoxReducer(state, { type: "INCR_LOADING" });
      expect(newState.loading).toBe(1);

      const newState2 = recipeBoxReducer(newState, { type: "INCR_LOADING" });
      expect(newState2.loading).toBe(2);
    });

    it('DECR_LOADING decrements loading counter', () => {
      const state = { ...initState(), loading: 2 };
      const newState = recipeBoxReducer(state, { type: "DECR_LOADING" });
      expect(newState.loading).toBe(1);
    });
  });

  describe('SET_AUTH_USER', () => {
    it('sets auth user and resets state', () => {
      const state = createStateWithBox();
      const authUser = { uid: "user2" } as any;

      const newState = recipeBoxReducer(state, { type: "SET_AUTH_USER", authUser });

      expect(newState.authUser).toBe(authUser);
      expect(newState.boxes.size).toBe(0); // reset
    });

    it('returns same state if authUser unchanged', () => {
      const authUser = { uid: "user1" } as any;
      const state = { ...initState(), authUser };

      const newState = recipeBoxReducer(state, { type: "SET_AUTH_USER", authUser });

      expect(newState).toBe(state);
    });

    it('handles null authUser (logout)', () => {
      const state = createStateWithBox();
      state.authUser = { uid: "user1" } as any;

      const newState = recipeBoxReducer(state, { type: "SET_AUTH_USER", authUser: null });

      expect(newState.authUser).toBeNull();
      expect(newState.boxes.size).toBe(0);
    });
  });

  describe('ADD_USER', () => {
    it('adds user to state', () => {
      const state = initState();
      const user = createUser("New User", "user1");

      const newState = recipeBoxReducer(state, { type: "ADD_USER", user });

      expect(newState.users.get("user1")).toBe(user);
    });

    it('returns unchanged state if user undefined', () => {
      const state = initState();
      const newState = recipeBoxReducer(state, { type: "ADD_USER" });
      expect(newState).toBe(state);
    });
  });

  describe('ADD_BOX', () => {
    it('adds box to state', () => {
      const state = initState();
      const box = createBox("New Box", "box1");

      const newState = recipeBoxReducer(state, {
        type: "ADD_BOX",
        boxId: "box1",
        payload: box
      });

      expect(newState.boxes.get("box1")).toBeDefined();
      expect(newState.boxes.get("box1")?.data.name).toBe("New Box");
    });

    it('preserves existing recipes when updating box', () => {
      const state = createStateWithBox();
      const updatedBox = createBox("Updated Box", "box1");

      const newState = recipeBoxReducer(state, {
        type: "ADD_BOX",
        boxId: "box1",
        payload: updatedBox
      });

      expect(newState.boxes.get("box1")?.data.name).toBe("Updated Box");
      expect(newState.boxes.get("box1")?.recipes.size).toBe(1);
    });

    it('returns unchanged state if boxId missing', () => {
      const state = initState();
      const newState = recipeBoxReducer(state, { type: "ADD_BOX", payload: createBox("Box", "box1") });
      expect(newState).toBe(state);
    });

    it('returns unchanged state if payload missing', () => {
      const state = initState();
      const newState = recipeBoxReducer(state, { type: "ADD_BOX", boxId: "box1" });
      expect(newState).toBe(state);
    });
  });

  describe('REMOVE_BOX', () => {
    it('removes box from state', () => {
      const state = createStateWithBox();

      const newState = recipeBoxReducer(state, { type: "REMOVE_BOX", boxId: "box1" });

      expect(newState.boxes.has("box1")).toBe(false);
    });

    it('returns unchanged state if boxId missing', () => {
      const state = createStateWithBox();
      const newState = recipeBoxReducer(state, { type: "REMOVE_BOX" });
      expect(newState).toBe(state);
    });
  });

  describe('ADD_RECIPE', () => {
    it('adds recipe to existing box', () => {
      const state = createStateWithBox();
      const newRecipe = createRecipe("New Recipe", "recipe2");

      const newState = recipeBoxReducer(state, {
        type: "ADD_RECIPE",
        boxId: "box1",
        recipeId: "recipe2",
        payload: newRecipe
      });

      expect(newState.boxes.get("box1")?.recipes.get("recipe2")).toBeDefined();
      expect(newState.boxes.get("box1")?.recipes.size).toBe(2);
    });

    it('returns unchanged state if box does not exist', () => {
      const state = createStateWithBox();
      const newRecipe = createRecipe("New Recipe", "recipe2");

      const newState = recipeBoxReducer(state, {
        type: "ADD_RECIPE",
        boxId: "nonexistent",
        recipeId: "recipe2",
        payload: newRecipe
      });

      expect(newState).toBe(state);
    });

    it('returns unchanged state if missing required fields', () => {
      const state = createStateWithBox();

      expect(recipeBoxReducer(state, { type: "ADD_RECIPE", boxId: "box1" })).toBe(state);
      expect(recipeBoxReducer(state, { type: "ADD_RECIPE", recipeId: "r1" })).toBe(state);
    });
  });

  describe('REMOVE_RECIPE', () => {
    it('removes recipe from box', () => {
      const state = createStateWithBox();

      const newState = recipeBoxReducer(state, {
        type: "REMOVE_RECIPE",
        boxId: "box1",
        recipeId: "recipe1"
      });

      expect(newState.boxes.get("box1")?.recipes.has("recipe1")).toBe(false);
    });

    it('returns unchanged state if missing boxId or recipeId', () => {
      const state = createStateWithBox();

      expect(recipeBoxReducer(state, { type: "REMOVE_RECIPE", boxId: "box1" })).toBe(state);
      expect(recipeBoxReducer(state, { type: "REMOVE_RECIPE", recipeId: "r1" })).toBe(state);
    });
  });

  describe('SET_BOXES', () => {
    it('merges new boxes into state', () => {
      const state = createStateWithBox();
      const newBox = createBox("Box 2", "box2");

      const newState = recipeBoxReducer(state, {
        type: "SET_BOXES",
        payload: new Map([["box2", newBox]])
      });

      expect(newState.boxes.size).toBe(2);
      expect(newState.boxes.get("box1")).toBeDefined();
      expect(newState.boxes.get("box2")).toBeDefined();
    });
  });

  describe('CLEAR_BOXES', () => {
    it('removes all boxes', () => {
      const state = createStateWithBox();

      const newState = recipeBoxReducer(state, { type: "CLEAR_BOXES" });

      expect(newState.boxes.size).toBe(0);
    });
  });

  describe('SET_READONLY', () => {
    it('sets writeable to false', () => {
      const state = initState();

      const newState = recipeBoxReducer(state, { type: "SET_READONLY", payload: false });

      expect(newState.writeable).toBe(false);
    });
  });

  describe('recipe property changes', () => {
    it('SET_RECIPE_NAME sets changed.name on recipe', () => {
      const state = createStateWithBox();

      const newState = recipeBoxReducer(state, {
        type: "SET_RECIPE_NAME",
        boxId: "box1",
        recipeId: "recipe1",
        payload: "Updated Name"
      });

      const recipe = newState.boxes.get("box1")?.recipes.get("recipe1");
      expect(recipe?.changed?.name).toBe("Updated Name");
      expect(recipe?.data.name).toBe("Test Recipe"); // original unchanged
    });

    it('SET_INGREDIENTS sets changed.recipeIngredient', () => {
      const state = createStateWithBox();
      const ingredients = ["new ingredient 1", "new ingredient 2"];

      const newState = recipeBoxReducer(state, {
        type: "SET_INGREDIENTS",
        boxId: "box1",
        recipeId: "recipe1",
        payload: ingredients
      });

      const recipe = newState.boxes.get("box1")?.recipes.get("recipe1");
      expect(recipe?.changed?.recipeIngredient).toEqual(ingredients);
    });

    it('SET_INSTRUCTIONS sets changed.recipeInstructions', () => {
      const state = createStateWithBox();
      const instructions = [{ "@type": "HowToStep" as const, text: "Do something" }];

      const newState = recipeBoxReducer(state, {
        type: "SET_INSTRUCTIONS",
        boxId: "box1",
        recipeId: "recipe1",
        payload: instructions
      });

      const recipe = newState.boxes.get("box1")?.recipes.get("recipe1");
      expect(recipe?.changed?.recipeInstructions).toEqual(instructions);
    });

    it('SET_CATEGORIES sets changed.recipeCategory', () => {
      const state = createStateWithBox();

      const newState = recipeBoxReducer(state, {
        type: "SET_CATEGORIES",
        boxId: "box1",
        recipeId: "recipe1",
        payload: ["Italian", "Pasta"]
      });

      const recipe = newState.boxes.get("box1")?.recipes.get("recipe1");
      expect(recipe?.changed?.recipeCategory).toEqual(["Italian", "Pasta"]);
    });

    it('SET_DESCRIPTION sets changed.description', () => {
      const state = createStateWithBox();

      const newState = recipeBoxReducer(state, {
        type: "SET_DESCRIPTION",
        boxId: "box1",
        recipeId: "recipe1",
        payload: "A delicious recipe"
      });

      const recipe = newState.boxes.get("box1")?.recipes.get("recipe1");
      expect(recipe?.changed?.description).toBe("A delicious recipe");
    });

    it('SET_AUTHOR sets changed.author', () => {
      const state = createStateWithBox();
      const author = { "@type": "Person" as const, name: "Chef Julia" };

      const newState = recipeBoxReducer(state, {
        type: "SET_AUTHOR",
        boxId: "box1",
        recipeId: "recipe1",
        payload: author
      });

      const recipe = newState.boxes.get("box1")?.recipes.get("recipe1");
      expect(recipe?.changed?.author).toEqual(author);
    });

    it('SET_COMMENT sets changed.comment', () => {
      const state = createStateWithBox();
      const comment = { "@type": "Comment" as const, text: "Tasty!" };

      const newState = recipeBoxReducer(state, {
        type: "SET_COMMENT",
        boxId: "box1",
        recipeId: "recipe1",
        payload: comment
      });

      const recipe = newState.boxes.get("box1")?.recipes.get("recipe1");
      expect(recipe?.changed?.comment).toEqual(comment);
    });

    it('returns unchanged state if recipe not found', () => {
      const state = createStateWithBox();

      const newState = recipeBoxReducer(state, {
        type: "SET_RECIPE_NAME",
        boxId: "box1",
        recipeId: "nonexistent",
        payload: "Name"
      });

      expect(newState).toBe(state);
    });

    it('returns unchanged state if boxId missing', () => {
      const state = createStateWithBox();

      const newState = recipeBoxReducer(state, {
        type: "SET_RECIPE_NAME",
        recipeId: "recipe1",
        payload: "Name"
      });

      expect(newState).toBe(state);
    });
  });

  describe('SET_EDITABLE', () => {
    it('marks recipe as editing and clones data to changed', () => {
      const state = createStateWithBox();

      const newState = recipeBoxReducer(state, {
        type: "SET_EDITABLE",
        boxId: "box1",
        recipeId: "recipe1"
      });

      const recipe = newState.boxes.get("box1")?.recipes.get("recipe1");
      expect(recipe?.editing).toBe(true);
      expect(recipe?.changed).toBeDefined();
      expect(recipe?.changed?.name).toBe("Test Recipe");
    });

    it('returns unchanged state if recipe not found', () => {
      const state = createStateWithBox();

      const newState = recipeBoxReducer(state, {
        type: "SET_EDITABLE",
        boxId: "box1",
        recipeId: "nonexistent"
      });

      expect(newState).toBe(state);
    });
  });

  describe('RESET_RECIPE', () => {
    it('clears changed and editing state', () => {
      const state = createStateWithBox();
      const recipe = state.boxes.get("box1")?.recipes.get("recipe1");
      recipe!.editing = true;
      recipe!.changed = { "@type": "Recipe", name: "Modified" };

      const newState = recipeBoxReducer(state, {
        type: "RESET_RECIPE",
        boxId: "box1",
        recipeId: "recipe1"
      });

      const resetRecipe = newState.boxes.get("box1")?.recipes.get("recipe1");
      expect(resetRecipe?.editing).toBe(false);
      expect(resetRecipe?.changed).toBeUndefined();
    });
  });

  describe('box property changes', () => {
    it('SET_BOX_NAME sets changed.name on box', () => {
      const state = createStateWithBox();

      const newState = recipeBoxReducer(state, {
        type: "SET_BOX_NAME",
        boxId: "box1",
        payload: "Updated Box Name"
      });

      const box = newState.boxes.get("box1");
      expect(box?.changed?.name).toBe("Updated Box Name");
      expect(box?.data.name).toBe("Test Box"); // original unchanged
    });

    it('returns unchanged state if box not found', () => {
      const state = createStateWithBox();

      const newState = recipeBoxReducer(state, {
        type: "SET_BOX_NAME",
        boxId: "nonexistent",
        payload: "Name"
      });

      expect(newState).toBe(state);
    });
  });

  describe('RESET_BOX', () => {
    it('clears changed state on box', () => {
      const state = createStateWithBox();
      const box = state.boxes.get("box1");
      box!.changed = { name: "Modified" };

      const newState = recipeBoxReducer(state, {
        type: "RESET_BOX",
        boxId: "box1"
      });

      expect(newState.boxes.get("box1")?.changed).toBeUndefined();
    });
  });

  describe('unknown action', () => {
    it('returns unchanged state for unknown action type', () => {
      const state = createStateWithBox();

      const newState = recipeBoxReducer(state, { type: "UNKNOWN_ACTION" });

      expect(newState).toBe(state);
    });
  });
});
