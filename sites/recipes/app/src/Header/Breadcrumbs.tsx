import { Breadcrumb, Dropdown } from 'antd';
import { useContext } from 'react';
import { Link, Params, useLocation, useParams } from 'react-router-dom';
import { Context } from '../context';
import { useMediaQuery } from 'react-responsive'

import './Header.css';
import { AppState } from '../types';
import { EllipsisOutlined } from '@ant-design/icons';
import { ItemType } from 'antd/es/breadcrumb/Breadcrumb';

function getPartMap(params: Readonly<Params<string>>, state: AppState) {

  const partMap = new Map<string, string>()
  const { boxId, recipeId } = params;
  if (boxId !== undefined) {
    const box = state.boxes.get(boxId)
    if (box !== undefined) {
      const boxName = box.getName()
      if (boxName) partMap.set(boxId, boxName)

      if (recipeId !== undefined) {
        const recipe = box.recipes.get(recipeId)
        if (recipe !== undefined) {
          const recipeName = recipe.getName()
          if (recipeName) partMap.set(recipeId, recipeName)
        }
      }
    }
  }
  return partMap
}

function FullBreadcrumbs() {
  const location = useLocation();
  const params = useParams();
  const { state } = useContext(Context);
  const partMap = getPartMap(params, state)

  const pathParts = location.pathname.split('/').filter(i => i);

  const items: ItemType[] = [
    {
      key: 'home',
      className: 'recipes-breadcrumb',
      title: <Link to="/">Recipe box</Link>,
    },
    ...pathParts.map((part, index) => {
      const url = `/${pathParts.slice(0, index + 1).join('/')}`;
      return {
        key: url,
        className: 'recipes-breadcrumb',
        title: <Link to={url}>{partMap.get(part) || part}</Link>,
      };
    }),
  ];

  return <Breadcrumb className="recipes-breadcrumb" items={items} />
}

function CollapsedBreadcrumbs() {
  const location = useLocation();
  const params = useParams();
  const { state } = useContext(Context);
  const partMap = getPartMap(params, state)
  const pathParts = location.pathname.split('/').filter(i => i);

  const menuItems = pathParts.map((part, index) => {
    const url = `/${pathParts.slice(0, index + 1).join('/')}`;
    return {
      key: url,
      label: <Link to={url}>{partMap.get(part) || part} /</Link>,
    };
  });

  const items: ItemType[] = [
    {
      key: 'home',
      className: 'recipes-breadcrumb',
      title: <Link to="/">Recipes</Link>,
    },
    {
      key: 'ellipsis',
      className: 'recipes-breadcrumb',
      title: <Dropdown menu={{ items: menuItems }}><EllipsisOutlined /></Dropdown>,
    },
  ];

  return <Breadcrumb className="recipes-breadcrumb" items={items} />
}

function ResponsiveBreadcrumbs() {
  const isTabletOrMobile = useMediaQuery({ query: '(max-width: 1224px)' })
  if (isTabletOrMobile) {
    return <CollapsedBreadcrumbs />
  } else {
    return <FullBreadcrumbs />
  }
}

export default ResponsiveBreadcrumbs;
