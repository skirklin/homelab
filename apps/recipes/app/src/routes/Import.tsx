import { useContext, useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { Alert, Button, Checkbox, Result, Select, Space, Spin, Typography } from 'antd';
import type { RecipeData } from '@homelab/backend';
import { useRecipesBackend } from '@kirkl/shared';
import { useAuth } from '@kirkl/shared';

import { Context } from '../context';
import { useBasePath } from '../RecipesRoutes';

const { Title, Text } = Typography;

/**
 * Recipe import landing page for the "Clip Recipe" bookmarklet.
 *
 * The bookmarklet extracts schema.org JSON-LD Recipe objects from a recipe
 * page (in the user's own browser, so site WAFs never see us) and hands them
 * off via the URL hash: `/import#<encodeURIComponent(JSON.stringify(recipes))>`.
 * The hash channel keeps the payload out of server access logs and survives
 * the auth redirect (Auth gates above the router without navigating).
 *
 * This page parses the hash, lets the user pick which recipe(s) + which box,
 * and saves via the SAME path the in-app URL importer uses
 * (`recipesBackend.addRecipe`, see Modals/ImportModal.tsx:96).
 */

type ParsedHash =
  | { kind: 'recipes'; recipes: RecipeData[] }
  | { kind: 'empty' }
  | { kind: 'error' };

function parseHash(): ParsedHash {
  // location.hash includes the leading '#'
  const raw = window.location.hash.replace(/^#/, '');
  if (!raw) return { kind: 'empty' };
  try {
    const decoded = decodeURIComponent(raw);
    const parsed = JSON.parse(decoded);
    const arr: unknown[] = Array.isArray(parsed) ? parsed : [parsed];
    const recipes = arr.filter(
      (r): r is RecipeData => !!r && typeof r === 'object',
    );
    if (recipes.length === 0) return { kind: 'empty' };
    return { kind: 'recipes', recipes };
  } catch {
    return { kind: 'error' };
  }
}

function recipeName(r: RecipeData, i: number): string {
  const n = r.name;
  if (typeof n === 'string' && n.trim()) return n.trim();
  return `Untitled recipe ${i + 1}`;
}

export default function Import() {
  const basePath = useBasePath();
  const { state } = useContext(Context);
  const { user: authUser } = useAuth();
  const recipesBackend = useRecipesBackend();

  // Parse once on mount. The hash is the source of truth; we never clear it,
  // so a logged-out user who signs in (Auth re-renders children) re-parses
  // the same payload.
  const parsed = useMemo(() => parseHash(), []);

  const recipes = parsed.kind === 'recipes' ? parsed.recipes : [];

  // Which recipes the user wants to import (default: all).
  const [selected, setSelected] = useState<Set<number>>(
    () => new Set(recipes.map((_r, i) => i)),
  );
  const [boxId, setBoxId] = useState<string>('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | undefined>();
  const [savedBoxId, setSavedBoxId] = useState<string | undefined>();
  const [savedRecipeId, setSavedRecipeId] = useState<string | undefined>();

  const boxOptions = useMemo(
    () =>
      Array.from(state.boxes.entries()).map(([id, box]) => ({
        value: id,
        label: box.data.name,
      })),
    [state.boxes],
  );

  // Default the box select to the first box once boxes load.
  useEffect(() => {
    if (!boxId && boxOptions.length > 0) {
      setBoxId(boxOptions[0].value);
    }
  }, [boxId, boxOptions]);

  function toggle(i: number) {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(i)) next.delete(i);
      else next.add(i);
      return next;
    });
  }

  async function save() {
    if (!authUser?.uid || !boxId) return;
    const picks = recipes.filter((_r, i) => selected.has(i));
    if (picks.length === 0) return;

    setSaving(true);
    setError(undefined);
    try {
      let lastId: string | undefined;
      for (const data of picks) {
        // Stored verbatim like the scraper output (Modals/ImportModal.tsx).
        lastId = await recipesBackend.addRecipe(boxId, data, authUser.uid);
      }
      setSavedBoxId(boxId);
      setSavedRecipeId(picks.length === 1 ? lastId : undefined);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to save recipe');
    }
    setSaving(false);
  }

  // --- Success ---
  if (savedBoxId) {
    const count = recipes.filter((_r, i) => selected.has(i)).length;
    const recipePath =
      savedRecipeId !== undefined
        ? `${basePath}/boxes/${savedBoxId}/recipes/${savedRecipeId}`
        : `${basePath}/boxes/${savedBoxId}`;
    return (
      <Result
        status="success"
        title={`Saved ${count} recipe${count !== 1 ? 's' : ''}`}
        extra={[
          <Link key="view" to={recipePath}>
            <Button type="primary">
              {savedRecipeId !== undefined ? 'View recipe' : 'View box'}
            </Button>
          </Link>,
          <Link key="home" to={basePath || '/'}>
            <Button>Done</Button>
          </Link>,
        ]}
      />
    );
  }

  // --- No / bad data ---
  if (parsed.kind !== 'recipes') {
    return (
      <div style={{ maxWidth: 560, margin: '40px auto', padding: 24 }}>
        <Result
          status="info"
          title="No recipe data"
          subTitle={
            parsed.kind === 'error'
              ? "Couldn't read the recipe data from this link. Use the Clip bookmarklet on a recipe page."
              : 'Use the Clip bookmarklet on a recipe page to import a recipe.'
          }
          extra={
            <Link to={`${basePath}/clip`}>
              <Button type="primary">Get the Clip bookmarklet</Button>
            </Link>
          }
        />
      </div>
    );
  }

  // --- Pick + save ---
  return (
    <div style={{ maxWidth: 560, margin: '24px auto', padding: 24 }}>
      <Title level={3}>Import recipe</Title>
      <Space direction="vertical" size="middle" style={{ width: '100%' }}>
        {recipes.length === 1 ? (
          <Text strong>{recipeName(recipes[0], 0)}</Text>
        ) : (
          <div>
            <Text strong>Choose which recipes to import:</Text>
            <div style={{ marginTop: 8, display: 'flex', flexDirection: 'column', gap: 4 }}>
              {recipes.map((r, i) => (
                <Checkbox key={i} checked={selected.has(i)} onChange={() => toggle(i)}>
                  {recipeName(r, i)}
                </Checkbox>
              ))}
            </div>
          </div>
        )}

        <div>
          <Text strong>Save to box:</Text>
          <div style={{ marginTop: 8 }}>
            <Select
              style={{ width: '100%' }}
              value={boxId || undefined}
              onChange={setBoxId}
              placeholder="Select a box..."
              options={boxOptions}
              notFoundContent="No boxes yet — create one in Manage Boxes"
            />
          </div>
        </div>

        {error && <Alert type="error" message={error} showIcon />}

        <Spin spinning={saving}>
          <Button
            type="primary"
            onClick={save}
            disabled={!boxId || selected.size === 0}
            data-testid="import-save"
          >
            Save {selected.size} recipe{selected.size !== 1 ? 's' : ''}
          </Button>
        </Spin>
      </Space>
    </div>
  );
}
