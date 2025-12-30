import { useContext } from 'react';
import { useParams } from 'react-router-dom';
import { Spin } from 'antd';
import { Context } from '../context';
import RecipeCard from '../RecipeCard/RecipeCard';
import { getRecipeFromState } from '../state';
import { BoxId, RecipeId } from '../types';

interface RecipeProps {
  boxId: BoxId
  recipeId: RecipeId
}


export function Recipe(props: RecipeProps) {
  const { recipeId, boxId } = props;
  const { state } = useContext(Context)

  const recipe = getRecipeFromState(state, boxId, recipeId)

  // Wait for subscriptions to fully load before showing "not found"
  // subscriptionsReady becomes true after the first loading cycle completes
  const isLoading = !state.subscriptionsReady || state.loading > 0;

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