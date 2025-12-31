import { useContext } from "react";
import styled from "styled-components";
import { useAuth } from "@kirkl/shared";
import { Context } from "../context";

import { setBoxVisibility } from "../firestore";
import { getBoxFromState } from "../state";
import { RecipeTable, RowType } from "../RecipeTable/RecipeTable"
import { Divider, RecipeActionGroup } from "../StyledComponents";
import { BoxId, Visibility } from "../types";
import DeleteBox from '../Buttons/DeleteBox';
import SubscribeButton from "../Buttons/Subscribe";
import VisibilityControl from "../Buttons/Visibility";
import Name from './Name';
import { addBoxOwner } from "../backend";
import SaveButton from "./Save";
import ClearButton from "./Clear";

const BoxContainer = styled.div`
  max-width: 1200px;
  margin: 0 auto;
  padding: var(--space-md);
`

const BoxHeader = styled.div`
  display: flex;
  align-items: center;
  gap: var(--space-md);
  margin-bottom: var(--space-sm);
`

const ActionButtonsRow = styled.div`
  display: flex;
  gap: var(--space-sm);
  margin-bottom: var(--space-md);
`

export interface BoxProps {
  boxId: BoxId
}

export default function BoxView(props: BoxProps) {
  const { boxId } = props;
  const { state } = useContext(Context)
  const { writeable } = state
  const { user } = useAuth();

  const box = getBoxFromState(state, boxId)

  if (!user) {
    return null
  }

  if (box === undefined) {
    return <div>Unable to find boxId={boxId}</div>
  }
  const recipes = box.recipes;
  const data: RowType[] = []
  for (const [recipeId, recipe] of recipes.entries()) {
    data.push({ box, recipe, key: `recipeId=${recipeId}_boxId=${boxId}` })
  }

  function handleVisiblityChange(e: { key: string }) {
    setBoxVisibility(boxId, e.key as Visibility)
  }

  function handleAddOwner(newOwnerEmail: string) {
    addBoxOwner({ boxId, newOwnerEmail })
  }


  return (
    <BoxContainer>
      <BoxHeader>
        <Name {...props} />
        <RecipeActionGroup>
          <SubscribeButton boxId={boxId} />
          <VisibilityControl
            value={box.visibility}
            element="button"
            boxId={boxId}
            handleChange={handleVisiblityChange}
            handleAddOwner={handleAddOwner}
            disabled={!(writeable && box.owners.includes(user.uid))}
          />
          <DeleteBox boxId={boxId} element="button" />
        </RecipeActionGroup>
      </BoxHeader>
      <ActionButtonsRow>
        <SaveButton {...props} />
        <ClearButton {...props} />
      </ActionButtonsRow>
      <Divider />
      <RecipeTable recipes={data} writeable={writeable && box.owners.includes(user.uid)} boxId={boxId} />
    </BoxContainer>
  )
}
