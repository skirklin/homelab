/**
 * Tests using real recipe JSON files from the recipes/ directory.
 * These test that our converters and storage classes work correctly
 * with actual Schema.org Recipe data scraped from real websites.
 */
import { Recipe } from 'schema-dts';
import { RecipeEntry } from './storage';
import { Visibility } from './types';
import {
  instructionsToStr,
  ingredientsToStr,
  authorToStr,
  parseCategories,
  decodeStr,
} from './converters';

// Import recipe JSON files
import chickenLettuceWraps from '../../recipes/Chicken Lettuce Wraps.json';
import breakfastSausage from '../../recipes/Breakfast Sausage.json';
import shepherdsPie from "../../recipes/Shepherd's Pie.json";
import pumpkinMuffins from '../../recipes/Best Ever Pumpkin Muffins.json';
import lionsMushroom from "../../recipes/Lion's Mane Mushroom Recipes_ Crab Cakes.json";
import chocolateChipCookies from '../../recipes/The Food Labs Chocolate Chip Cookies Recipe.json';
import thaiStickyRice from '../../recipes/Thai Sweet Sticky Rice With Mango (Khao Neeo Mamuang).json';
import chileVerde from '../../recipes/Chicken Chile Verde Pressure Cooker Recipe.json';

const recipes = [
  { name: 'Chicken Lettuce Wraps', data: chickenLettuceWraps },
  { name: 'Breakfast Sausage', data: breakfastSausage },
  { name: "Shepherd's Pie", data: shepherdsPie },
  { name: 'Pumpkin Muffins', data: pumpkinMuffins },
  { name: "Lion's Mane Crab Cakes", data: lionsMushroom },
  { name: 'Chocolate Chip Cookies', data: chocolateChipCookies },
  { name: 'Thai Sticky Rice', data: thaiStickyRice },
  { name: 'Chile Verde', data: chileVerde },
];

describe('Real recipe data', () => {
  describe('RecipeEntry creation', () => {
    it.each(recipes)('can create RecipeEntry from $name', ({ data }) => {
      const entry = new RecipeEntry(
        data as Recipe,
        ['testUser'],
        Visibility.private,
        'testUser',
        'testId',
        new Date(),
        new Date(),
        'testUser'
      );

      expect(entry).toBeDefined();
      // @type can be 'Recipe' or ['Recipe'] in valid JSON-LD
      const type = entry.data['@type'];
      expect(type === 'Recipe' || (Array.isArray(type) && type.includes('Recipe'))).toBe(true);
      expect(entry.data.name).toBeDefined();
    });

    it.each(recipes)('$name has extractable name via getName()', ({ data }) => {
      const entry = new RecipeEntry(
        data as Recipe,
        ['testUser'],
        Visibility.private,
        'testUser',
        'testId',
        new Date(),
        new Date(),
        'testUser'
      );

      const name = entry.getName();
      expect(name).toBeDefined();
      expect(typeof name).toBe('string');
      expect(name!.length).toBeGreaterThan(0);
    });
  });

  describe('Ingredient parsing', () => {
    it('parses Chicken Lettuce Wraps ingredients correctly', () => {
      const ingredients = chickenLettuceWraps.recipeIngredient;
      expect(Array.isArray(ingredients)).toBe(true);
      expect(ingredients.length).toBeGreaterThan(5);

      const str = ingredientsToStr(ingredients);
      expect(str).toContain('ground chicken');
      expect(str).toContain('garlic');
    });

    it('parses Breakfast Sausage ingredients correctly', () => {
      const ingredients = breakfastSausage.recipeIngredient;
      expect(Array.isArray(ingredients)).toBe(true);

      const str = ingredientsToStr(ingredients);
      expect(str).toContain('pork');
      expect(str).toContain('sage');
    });

    it.each(recipes)('$name ingredients convert to non-empty string', ({ data }) => {
      const recipe = data as Recipe;
      if (recipe.recipeIngredient) {
        const str = ingredientsToStr(recipe.recipeIngredient);
        expect(str.length).toBeGreaterThan(0);
      }
    });
  });

  describe('Instruction parsing', () => {
    it('parses Chicken Lettuce Wraps instructions correctly', () => {
      const instructions = chickenLettuceWraps.recipeInstructions;
      expect(Array.isArray(instructions)).toBe(true);
      expect(instructions.length).toBe(3);

      const str = instructionsToStr(instructions);
      expect(str).toContain('chicken');
      expect(str).toContain('lettuce');
    });

    it('parses single-step Breakfast Sausage instructions', () => {
      const instructions = breakfastSausage.recipeInstructions;
      expect(Array.isArray(instructions)).toBe(true);
      expect(instructions.length).toBe(1);

      const str = instructionsToStr(instructions);
      expect(str).toContain('grind');
    });

    it.each(recipes)('$name instructions convert to non-empty string', ({ data }) => {
      const recipe = data as Recipe;
      if (recipe.recipeInstructions) {
        const str = instructionsToStr(recipe.recipeInstructions);
        expect(str.length).toBeGreaterThan(0);
      }
    });
  });

  describe('Author parsing', () => {
    it('parses single Person author (Chicken Lettuce Wraps)', () => {
      const author = chickenLettuceWraps.author;
      const str = authorToStr(author as Recipe['author']);
      expect(str).toBe('Rasa Malaysia');
    });

    it('parses author array (Breakfast Sausage)', () => {
      const author = breakfastSausage.author;
      const str = authorToStr(author as Recipe['author']);
      expect(str).toBe('Alton Brown');
    });

    it.each(recipes)('$name author parses without error', ({ data }) => {
      const recipe = data as Recipe;
      // Should not throw, may return undefined for missing authors
      const str = authorToStr(recipe.author);
      expect(str === undefined || typeof str === 'string').toBe(true);
    });
  });

  describe('Category parsing', () => {
    it('parses single category string', () => {
      const categories = chickenLettuceWraps.recipeCategory;
      const parsed = parseCategories(categories as Recipe['recipeCategory']);
      expect(Array.isArray(parsed)).toBe(true);
      expect(parsed).toContain('Chinese Recipes');
    });

    it.each(recipes)('$name categories parse to array', ({ data }) => {
      const recipe = data as Recipe;
      const parsed = parseCategories(recipe.recipeCategory);
      expect(Array.isArray(parsed)).toBe(true);
    });
  });

  describe('HTML entity decoding', () => {
    it('decodes &#x27; in Chicken Lettuce Wraps description', () => {
      const description = chickenLettuceWraps.description;
      expect(description).toContain('&#x27;');

      const decoded = decodeStr(description);
      expect(decoded).not.toContain('&#x27;');
      expect(decoded).toContain("P. F. Chang's");
    });

    it.each(recipes)('$name description decodes without error', ({ data }) => {
      const recipe = data as Recipe;
      if (recipe.description && typeof recipe.description === 'string') {
        const decoded = decodeStr(recipe.description);
        expect(decoded).toBeDefined();
        // Should not contain common HTML entities after decoding
        expect(decoded).not.toMatch(/&#x[0-9a-fA-F]+;/);
        expect(decoded).not.toMatch(/&#[0-9]+;/);
      }
    });
  });

  describe('Edge cases from real data', () => {
    it('handles recipes with nutrition info', () => {
      const recipe = chickenLettuceWraps as Recipe;
      expect(recipe.nutrition).toBeDefined();

      const entry = new RecipeEntry(
        recipe,
        ['testUser'],
        Visibility.private,
        'testUser',
        'testId',
        new Date(),
        new Date(),
        'testUser'
      );
      expect(entry.data.nutrition).toBeDefined();
    });

    it('handles recipes with aggregate ratings', () => {
      const recipe = breakfastSausage as Recipe;
      expect(recipe.aggregateRating).toBeDefined();
    });

    it('handles recipes with video content', () => {
      const recipe = breakfastSausage as Recipe;
      expect(recipe.video).toBeDefined();
    });

    it('handles recipes with multiple images', () => {
      const recipe = chickenLettuceWraps as Recipe;
      expect(Array.isArray(recipe.image)).toBe(true);
    });

    it('handles recipes with ISO 8601 duration times', () => {
      const recipe = chickenLettuceWraps as Recipe;
      expect(recipe.prepTime).toMatch(/^PT/);
      expect(recipe.cookTime).toMatch(/^PT/);
      expect(recipe.totalTime).toMatch(/^PT/);
    });
  });
});
