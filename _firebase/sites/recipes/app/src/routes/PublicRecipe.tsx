/**
 * Public recipe view - accessible without authentication
 * Shows recipe in read-only mode with a prompt to sign in for full features
 */
import { useState, useEffect } from "react";
import { useParams, useNavigate } from "react-router-dom";
import { doc, getDoc } from "firebase/firestore";
import styled from "styled-components";
import { Spin, Button, Alert } from "antd";
import { LoginOutlined } from "@ant-design/icons";
import { db } from "../backend";
import { recipeConverter, boxConverter } from "../storage";
import type { RecipeEntry, BoxEntry } from "../storage";
import { decodeStr } from "../converters";
import { PageContainer, AppHeader } from "@kirkl/shared";

const RecipeContainer = styled.article`
  max-width: 800px;
  margin: 0 auto;
  padding: var(--space-md);
`;

const RecipeName = styled.h1`
  font-size: var(--font-size-2xl);
  font-weight: 600;
  color: var(--color-text);
  margin: 0 0 var(--space-sm) 0;
`;

const RecipeDescription = styled.p`
  font-size: var(--font-size-base);
  color: var(--color-text-secondary);
  margin-bottom: var(--space-lg);
  line-height: 1.6;
`;

const Section = styled.section`
  margin-bottom: var(--space-xl);
`;

const SectionTitle = styled.h2`
  font-size: var(--font-size-lg);
  font-weight: 600;
  color: var(--color-text);
  margin-bottom: var(--space-md);
  padding-bottom: var(--space-xs);
  border-bottom: 1px solid var(--color-border);
`;

const IngredientList = styled.ul`
  list-style: none;
  padding: 0;
  margin: 0;
`;

const IngredientItem = styled.li`
  padding: var(--space-xs) 0;
  border-bottom: 1px solid var(--color-border-light);

  &:last-child {
    border-bottom: none;
  }
`;

const InstructionList = styled.ol`
  padding-left: var(--space-lg);
  margin: 0;
`;

const InstructionItem = styled.li`
  padding: var(--space-sm) 0;
  line-height: 1.6;
`;

const SignInBanner = styled.div`
  margin-bottom: var(--space-lg);
`;

const LoadingContainer = styled.div`
  display: flex;
  justify-content: center;
  align-items: center;
  min-height: 200px;
`;

const ErrorContainer = styled.div`
  max-width: 600px;
  margin: var(--space-xl) auto;
  text-align: center;
`;

const TagList = styled.div`
  display: flex;
  flex-wrap: wrap;
  gap: var(--space-xs);
  margin-bottom: var(--space-md);
`;

const Tag = styled.span`
  background: var(--color-bg-muted);
  color: var(--color-text-secondary);
  padding: var(--space-xs) var(--space-sm);
  border-radius: var(--radius-sm);
  font-size: var(--font-size-sm);
`;

export function PublicRecipe() {
  const { boxId, recipeId } = useParams<{ boxId: string; recipeId: string }>();
  const navigate = useNavigate();
  const [recipe, setRecipe] = useState<RecipeEntry | null>(null);
  const [box, setBox] = useState<BoxEntry | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    async function fetchRecipe() {
      if (!boxId || !recipeId) {
        setError("Invalid recipe link");
        setLoading(false);
        return;
      }

      try {
        // Fetch box first to check visibility
        const boxRef = doc(db, "boxes", boxId).withConverter(boxConverter);
        const boxDoc = await getDoc(boxRef);

        if (!boxDoc.exists()) {
          setError("Recipe not found");
          setLoading(false);
          return;
        }

        const boxData = boxDoc.data();
        setBox(boxData);

        // Fetch recipe
        const recipeRef = doc(db, "boxes", boxId, "recipes", recipeId).withConverter(recipeConverter);
        const recipeDoc = await getDoc(recipeRef);

        if (!recipeDoc.exists()) {
          setError("Recipe not found");
          setLoading(false);
          return;
        }

        const recipeData = recipeDoc.data();

        // Check if recipe is accessible (public box or public recipe)
        if (boxData.visibility !== "public" && recipeData.visibility !== "public") {
          setError("This recipe is private. Sign in to view it.");
          setLoading(false);
          return;
        }

        setRecipe(recipeData);
      } catch (err) {
        console.error("Error fetching recipe:", err);
        setError("Unable to load recipe. It may be private or no longer exist.");
      } finally {
        setLoading(false);
      }
    }

    fetchRecipe();
  }, [boxId, recipeId]);

  const handleSignIn = () => {
    // Navigate to the main app which will show the auth screen
    // After signing in, user will be redirected back
    navigate(`/boxes/${boxId}/recipes/${recipeId}`);
  };

  if (loading) {
    return (
      <LoadingContainer>
        <Spin size="large" tip="Loading recipe..." />
      </LoadingContainer>
    );
  }

  if (error || !recipe) {
    return (
      <ErrorContainer>
        <Alert
          type="warning"
          message="Recipe Unavailable"
          description={error || "Unable to load this recipe."}
          showIcon
        />
        <Button
          type="primary"
          icon={<LoginOutlined />}
          onClick={handleSignIn}
          style={{ marginTop: 16 }}
        >
          Sign in to access recipes
        </Button>
      </ErrorContainer>
    );
  }

  const data = recipe.getData();
  const name = decodeStr(data.name as string) || "Untitled Recipe";
  const description = decodeStr(data.description as string);

  // Handle ingredients - can be string[] or HowToSection[]
  const ingredients: string[] = [];
  if (Array.isArray(data.recipeIngredient)) {
    for (const item of data.recipeIngredient) {
      if (typeof item === "string") {
        ingredients.push(item);
      } else if (typeof item === "object" && item !== null) {
        // HowToSection with itemListElement
        const section = item as { name?: string; itemListElement?: unknown[] };
        if (section.name) {
          ingredients.push(`## ${section.name}`);
        }
        if (Array.isArray(section.itemListElement)) {
          for (const subItem of section.itemListElement) {
            if (typeof subItem === "string") {
              ingredients.push(subItem);
            } else if (typeof subItem === "object" && subItem !== null && "text" in subItem) {
              ingredients.push((subItem as { text: string }).text);
            }
          }
        }
      }
    }
  }

  // Handle instructions - can be string[] or HowToStep[] or HowToSection[]
  const instructions: string[] = [];
  if (Array.isArray(data.recipeInstructions)) {
    for (const item of data.recipeInstructions) {
      if (typeof item === "string") {
        instructions.push(item);
      } else if (typeof item === "object" && item !== null) {
        const step = item as { text?: string; name?: string; itemListElement?: unknown[] };
        if (step.text) {
          instructions.push(step.text);
        } else if (step.itemListElement) {
          // HowToSection
          if (step.name) {
            instructions.push(`## ${step.name}`);
          }
          for (const subItem of step.itemListElement) {
            if (typeof subItem === "string") {
              instructions.push(subItem);
            } else if (typeof subItem === "object" && subItem !== null && "text" in subItem) {
              instructions.push((subItem as { text: string }).text);
            }
          }
        }
      }
    }
  }

  // Handle tags
  const tags: string[] = [];
  if (data.recipeCategory) {
    if (Array.isArray(data.recipeCategory)) {
      tags.push(...data.recipeCategory.map(t => String(t)));
    } else {
      tags.push(String(data.recipeCategory));
    }
  }

  return (
    <>
      <AppHeader
        title={box?.getName() || "Recipe"}
        onBack={() => navigate("/")}
      />
      <PageContainer>
        <RecipeContainer>
          <SignInBanner>
            <Alert
              type="info"
              message="Viewing shared recipe"
              description={
                <span>
                  Sign in to save this recipe to your collection, edit it, or track when you cook it.{" "}
                  <Button type="link" size="small" onClick={handleSignIn} style={{ padding: 0 }}>
                    Sign in
                  </Button>
                </span>
              }
              showIcon
            />
          </SignInBanner>

          <RecipeName>{name}</RecipeName>

          {tags.length > 0 && (
            <TagList>
              {tags.map((tag, i) => (
                <Tag key={i}>{tag}</Tag>
              ))}
            </TagList>
          )}

          {description && <RecipeDescription>{description}</RecipeDescription>}

          {ingredients.length > 0 && (
            <Section>
              <SectionTitle>Ingredients</SectionTitle>
              <IngredientList>
                {ingredients.map((ingredient, i) => (
                  <IngredientItem key={i}>
                    {ingredient.startsWith("## ") ? (
                      <strong>{ingredient.slice(3)}</strong>
                    ) : (
                      decodeStr(ingredient)
                    )}
                  </IngredientItem>
                ))}
              </IngredientList>
            </Section>
          )}

          {instructions.length > 0 && (
            <Section>
              <SectionTitle>Instructions</SectionTitle>
              <InstructionList>
                {instructions.map((instruction, i) => (
                  <InstructionItem key={i}>
                    {instruction.startsWith("## ") ? (
                      <strong>{instruction.slice(3)}</strong>
                    ) : (
                      decodeStr(instruction)
                    )}
                  </InstructionItem>
                ))}
              </InstructionList>
            </Section>
          )}
        </RecipeContainer>
      </PageContainer>
    </>
  );
}

export default PublicRecipe;
