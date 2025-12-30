import { PlusOutlined } from '@ant-design/icons';
import { Input, Tag } from 'antd';
import React, { useContext, useState } from 'react';
import styled from 'styled-components';
import { Context } from '../context';
import { parseCategories, formatCategories } from '../converters';
import { getRecipeFromState, getAppUserFromState, getBoxFromState } from '../state';
import { canUpdateRecipe } from '../utils';
import { RecipeCardProps } from './RecipeCard';
import { useMediaQuery } from 'react-responsive'


const TagsArea = styled.div`
  display: flex;
  flex-wrap: wrap;
  gap: var(--space-xs);
  align-items: center;
`

const StyledTag = styled(Tag)`
  border-radius: var(--radius-sm);
  font-size: var(--font-size-sm);
  padding: 2px 8px;
  margin: 0;
`

const NewTagButton = styled(Tag)`
  border-radius: var(--radius-sm);
  font-size: var(--font-size-sm);
  padding: 2px 8px;
  margin: 0;
  border-style: dashed;
  background: transparent;
  color: var(--color-text-muted);
  cursor: pointer;
  transition: all 0.2s ease;

  &:hover {
    color: var(--color-primary);
    border-color: var(--color-primary);
  }
`

function Tags(props: RecipeCardProps) {
  const { recipeId, boxId } = props;
  const [editableTag, setEditableTag] = useState<number>();
  const [inputValue, setInputValue] = useState("");
  const { state, dispatch } = useContext(Context);

  const recipe = getRecipeFromState(state, boxId, recipeId)
  const box = getBoxFromState(state, boxId)
  const rd = recipe ? (recipe.changed ? recipe.changed : recipe.data) : { recipeCategory: [] }
  const tags = parseCategories(rd.recipeCategory)
  const isTabletOrMobile = useMediaQuery({ query: '(max-width: 1224px)' })

  if (recipe === undefined || box === undefined || isTabletOrMobile) { return null }

  function setTags(tags: string[]) {
    dispatch({ type: "SET_CATEGORIES", recipeId, boxId, payload: formatCategories(tags) })
  }

  const user = getAppUserFromState(state);
  const editable = (state.writeable && canUpdateRecipe(recipe, box, user))

  function onClose(idx: number) {
    const newTags = tags.filter((_, tidx) => idx !== tidx);
    setTags(newTags);
  }

  function confirmEdits(idx: number) {
    const newTags = [...tags];
    newTags[idx] = inputValue;
    setTags(newTags);
    setEditableTag(undefined);
  }

  function newTag() {
    const newTags = [...tags, ""];
    setTags(newTags);
    setInputValue("");
    setEditableTag(newTags.length - 1);
  }

  function formatTags(tags: string[]) {
    if (tags === undefined)
      return null;
    const elts: React.ReactNode[] = tags.map(
      (rc, idx) => {
        if (editable && idx === editableTag) {
          return (
            <Input
              key={idx}
              autoFocus
              size="small"
              value={inputValue}
              style={{ display: 'inline', width: "100px" }}
              onChange={e => setInputValue(e.target.value)}
              onBlur={() => confirmEdits(idx)}
              onPressEnter={() => confirmEdits(idx)}
            />
          );
        } else {
          return (
            <StyledTag
              closable={editable}
              onClose={() => onClose(idx)}
              key={idx}
              onDoubleClick={() => { setInputValue(rc); setEditableTag(idx); }}
            >
              {rc}
            </StyledTag>
          );
        }
      }
    );
    if (editable && editableTag === undefined) {
      elts.push(
        <NewTagButton key="__new_tag__" onClick={() => newTag()}>
          <PlusOutlined /> Add tag
        </NewTagButton>
      );
    }
    return elts;
  }

  return (
    <TagsArea>
      {formatTags([...tags])}
    </TagsArea>
  )
}

export default Tags;