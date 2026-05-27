import { useContext, useEffect, useState } from 'react';
import { useNavigationType, useParams } from 'react-router-dom';
import { Spin } from 'antd';
import { useAuth, useRecipesBackend } from '@kirkl/shared';
import { Context } from '../context';
import RecipeCard from '../RecipeCard/RecipeCard';
import { boxFromBackend, recipeFromBackend } from '../adapters';
import { getRecipeFromState } from '../state';
import { recordRecentView } from '../recentlyViewed';
import type { BoxId, RecipeId } from '../types';

interface RecipeProps {
  boxId: BoxId
  recipeId: RecipeId
}


export function Recipe(props: RecipeProps) {
  const { recipeId, boxId } = props;
  const { state, dispatch } = useContext(Context)
  const { user } = useAuth();
  const recipesBackend = useRecipesBackend();
  const navigationType = useNavigationType();
  const [fetchAttempted, setFetchAttempted] = useState(false);

  // Skip recording on browser back/forward — otherwise back-nav re-promotes the
  // recipe in "Recently viewed" every time.
  useEffect(() => {
    if (navigationType !== "POP") {
      recordRecentView(recipeId);
    }
  }, [recipeId, navigationType]);

  const recipe = getRecipeFromState(state, boxId, recipeId)

  // Subscriptions only cover boxes the user has subscribed to. A deep link to
  // a recipe in an unsubscribed (but accessible) box otherwise never resolves.
  // Mirror Box.tsx's self-fetch fallback so a single getBox call hydrates the
  // box + its recipes into local state.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      if (recipe !== undefined || fetchAttempted) return;
      if (!state.subscriptionsReady || state.loading > 0) return;
      const result = await recipesBackend.getBox(boxId, user?.uid ?? null);
      if (cancelled) return;
      if (result !== null) {
        const fetchedBox = boxFromBackend(result.box);
        for (const r of result.recipes) {
          fetchedBox.recipes.set(r.id, recipeFromBackend(r));
        }
        dispatch({ type: "ADD_BOX", payload: fetchedBox, boxId });
      }
      setFetchAttempted(true);
    })();
    return () => { cancelled = true; };
  }, [boxId, recipe, fetchAttempted, state.subscriptionsReady, state.loading, recipesBackend, user?.uid, dispatch]);

  // Wait for subscriptions to fully load, and for any pending self-fetch, before
  // showing "not found". subscriptionsReady becomes true after the first loading
  // cycle completes; fetchAttempted gates the self-fetch escape hatch.
  const isLoading = !state.subscriptionsReady || state.loading > 0 || (recipe === undefined && !fetchAttempted);

  if (isLoading && recipe === undefined) {
    return <Spin tip="Loading recipe..."><div style={{ minHeight: 200 }} /></Spin>
  }

  if (recipe === undefined) {
    return <div>Unable to find recipe.</div>
  }

  return (
    <>
      <RecipeCard {...props} />
    </>
  )
}

export default function RoutedRecipe() {
  const params = useParams();
  if (params.boxId === undefined || params.recipeId === undefined) {
    throw new Error("Must have a boxId and recipeId.")
  }

  return <Recipe recipeId={params.recipeId} boxId={params.boxId} />
}
