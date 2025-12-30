import { DownloadOutlined } from '@ant-design/icons';
import { Menu } from 'antd';
import { useContext } from 'react';
import { Context } from '../context';
import { ActionButton } from '../StyledComponents';
import { BoxId, RecipeId } from '../types';
import { getRecipeFromState } from '../state';
import { download } from '../utils';

interface DownloadProps {
  recipeId: RecipeId
  boxId: BoxId
  element: "button" | "menu"
}

export function DownloadButton(props: DownloadProps) {
  const { state } = useContext(Context)
  const { boxId, recipeId, element } = props;
  const recipe = getRecipeFromState(state, boxId, recipeId)
  if (process.env.NODE_ENV !== "development") {
    return null
  }
  if (recipe === undefined) return null

  let elt;
  switch (element) {
    case "button":
      elt = <ActionButton title="Delete this box?" onClick={() => download(recipe)} icon={<DownloadOutlined />} >Download</ActionButton>
      break;
    case "menu":
      elt = <Menu.Item key="download" title="Delete this box?" onClick={() => download(recipe)} icon={<DownloadOutlined />} >Download</Menu.Item>
      break;
  }

  return elt
}

export default DownloadButton