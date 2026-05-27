import { Breadcrumb, Dropdown } from 'antd';
import { useContext } from 'react';
import { Link, useLocation, useParams, type Params } from 'react-router-dom';
import { Context } from '../context';
import { useMediaQuery } from 'react-responsive'

import './Header.css';
import type { AppState } from '../types';
import { getBoxName, getRecipeName } from '../storage';
import { EllipsisOutlined } from '@ant-design/icons';
import type { ItemType } from 'antd/es/breadcrumb/Breadcrumb';

function getPartMap(params: Readonly<Params<string>>, state: AppState) {

  const partMap = new Map<string, string>()
  const { boxId, recipeId } = params;
  if (boxId !== undefined) {
    const box = state.boxes.get(boxId)
    if (box !== undefined) {
      const boxName = getBoxName(box)
      if (boxName) partMap.set(boxId, boxName)

      if (recipeId !== undefined) {
        const recipe = box.recipes.get(recipeId)
        if (recipe !== undefined) {
          const recipeName = getRecipeName(recipe)
          if (recipeName) partMap.set(recipeId, recipeName)
        }
      }
    }
  }
  return partMap
}

// Check if we're embedded in the home app (path starts with /recipes)
function isEmbedded(pathname: string): boolean {
  const parts = pathname.split('/').filter(i => i);
  return parts[0] === 'recipes';
}

// Filter out the app's base path segment (e.g., "recipes" when embedded at /recipes)
function getContentParts(pathname: string): string[] {
  const parts = pathname.split('/').filter(i => i);
  // Skip the "recipes" prefix if present (when embedded in home app)
  if (parts[0] === 'recipes') {
    return parts.slice(1);
  }
  return parts;
}

// Build URL with correct prefix based on embedded status
function buildUrl(contentParts: string[], index: number, embedded: boolean): string {
  const path = `/${contentParts.slice(0, index + 1).join('/')}`;
  return embedded ? `/recipes${path}` : path;
}

function getHomeUrl(embedded: boolean): string {
  return embedded ? '/recipes' : '/';
}

// Route-only path segments that are logical containers, not navigable destinations.
// Filtered out of the breadcrumb chain so /boxes/:boxId/recipes/:recipeId renders
// as "Recipes / <box> / <recipe>" rather than "Recipes / boxes / <box> / recipes / <recipe>".
const ROUTE_ONLY_SEGMENTS = new Set(['boxes', 'recipes']);

function FullBreadcrumbs() {
  const location = useLocation();
  const params = useParams();
  const { state } = useContext(Context);
  const partMap = getPartMap(params, state)

  const embedded = isEmbedded(location.pathname);
  const contentParts = getContentParts(location.pathname);

  const items: ItemType[] = [
    {
      key: 'home',
      className: 'recipes-breadcrumb',
      title: <Link to={getHomeUrl(embedded)}>Recipes</Link>,
    },
    ...contentParts
      .map((part, index) => ({ part, index }))
      .filter(({ part }) => !ROUTE_ONLY_SEGMENTS.has(part))
      .map(({ part, index }) => {
        const url = buildUrl(contentParts, index, embedded);
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
  const embedded = isEmbedded(location.pathname);
  const contentParts = getContentParts(location.pathname);

  const menuItems = contentParts
    .map((part, index) => ({ part, index }))
    .filter(({ part }) => !ROUTE_ONLY_SEGMENTS.has(part))
    .map(({ part, index }) => {
      const url = buildUrl(contentParts, index, embedded);
      return {
        key: url,
        label: <Link to={url}>{partMap.get(part) || part} /</Link>,
      };
    });

  const items: ItemType[] = [
    {
      key: 'home',
      className: 'recipes-breadcrumb',
      title: <Link to={getHomeUrl(embedded)}>Recipes</Link>,
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
