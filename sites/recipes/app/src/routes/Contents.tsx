import { useContext } from 'react';
import styled from 'styled-components';

import { RecipeTable, RowType } from '../RecipeTable/RecipeTable'
import { Context } from '../context';

const PageContainer = styled.div`
  max-width: 1200px;
  margin: 0 auto;
  padding: var(--space-md);
`

const PageHeader = styled.div`
  margin-bottom: var(--space-md);
`

const PageTitle = styled.h1`
  font-size: var(--font-size-2xl);
  font-weight: 600;
  color: var(--color-primary);
  margin: 0;
`

const RecipeCount = styled.span`
  font-size: var(--font-size-base);
  color: var(--color-text-muted);
  font-weight: 400;
  margin-left: var(--space-sm);
`

function Contents() {
  const { state } = useContext(Context)
  const { writeable } = state;

  const data: RowType[] = []
  for (const [boxId, box] of state.boxes.entries()) {
    for (const [recipeId, recipe] of box.recipes.entries()) {
      data.push({ box, recipe, key: `recipeId=${recipeId}_boxId=${boxId}` })
    }
  }

  return (
    <PageContainer>
      <PageHeader>
        <PageTitle>
          All Recipes
          <RecipeCount>({data.length})</RecipeCount>
        </PageTitle>
      </PageHeader>
      <RecipeTable recipes={data} writeable={writeable}/>
    </PageContainer>
  )
}


export default Contents