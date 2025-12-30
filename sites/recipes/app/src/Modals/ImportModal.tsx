import { DeleteOutlined } from '@ant-design/icons';
import { Button, Modal, Spin, Space, Typography, Input } from 'antd';
import _ from 'lodash';

import { useContext, useState } from 'react';
import { Recipe } from 'schema-dts';
import { getRecipes } from '../backend';
import { Context } from '../context';
import { RecipeEntry } from '../storage';
import { BoxId, Visibility } from '../types';
import { addRecipe } from '../firestore';
import { getAppUserFromState } from '../state';

const { Text } = Typography;
const { TextArea } = Input;

interface ImportProps {
  boxId: BoxId | undefined
  isVisible: boolean
  setIsVisible: (isVisible: boolean) => void
}

interface PossibleRecipeProps {
  recipe: RecipeEntry
  remove: () => void
}

function PossibleRecipe(props: PossibleRecipeProps) {
  const { recipe, remove } = props;
  return (
    <div>
      <Button onClick={() => remove()} icon={<DeleteOutlined />} />{String(recipe.data.name ?? '')}
    </div>
  )
}

function ImportModal(props: ImportProps) {
  const { isVisible, setIsVisible, boxId } = props;
  const [spinning, setSpinning] = useState(false)
  const [value, setValue] = useState<string>();
  const [discovered, setDiscovered] = useState<RecipeEntry[]>([])
  const { dispatch, state } = useContext(Context)

  const user = getAppUserFromState(state)
  async function import_() {
    setSpinning(true)
    if (boxId === undefined || value === "") {
      return
    }
    if (user === undefined) {
      return
    }
    const response = (await getRecipes({ url: value })) as { data: { error?: string, recipes: string } }
    const data = response.data

    if (data.error) {
      alert(data.error)
    }
    const recipes = JSON.parse(data.recipes)
    const now = new Date()
    const fullRecipes = recipes.map(
      (recipe: Recipe) => {
        delete recipe.review
        delete recipe.comment
        delete recipe.commentCount
        return new RecipeEntry(recipe, [user.id], Visibility.private, user.id, "", now, now, user.id)
      }
    )
    setDiscovered([...discovered, ...fullRecipes])
    setSpinning(false)
  }

  function makeRemover(i: number) {
    const remover = () => {
      setDiscovered(_.filter(discovered, (x, id) => id !== i))
    }
    return remover
  }

  function addRecipes(boxId: string) {

    discovered.forEach(recipe => addRecipe(boxId, recipe))
    setDiscovered([]);
    setValue("");
    setIsVisible(false);
  }

  if (boxId === undefined) {
    return null
  }


  const possibleRecipes = discovered.map((recipe, i) => { return <PossibleRecipe key={i} recipe={recipe} remove={makeRemover(i)} /> })
  return (
    <Modal
      title="Import Recipes from URL"
      open={isVisible}
      onCancel={() => setIsVisible(false)}
      footer={null}
    >
      <Space direction="vertical" style={{ width: '100%' }} size="middle">
        <div>
          <Text strong>Enter a recipe URL:</Text>
          <div style={{ marginTop: 8 }}>
            <TextArea
              autoFocus
              placeholder="Paste a URL containing recipe data..."
              value={value}
              onChange={e => setValue(e.target.value)}
            />
          </div>
        </div>
        <Spin spinning={spinning}>
          <Button type="primary" onClick={() => import_()}>Read URL</Button>
        </Spin>
        {possibleRecipes.length > 0 && (
          <div>
            <Text strong>Recipes found ({possibleRecipes.length}):</Text>
            <div style={{ marginTop: 8 }}>
              {possibleRecipes}
            </div>
            <div style={{ marginTop: 12 }}>
              <Button type="primary" onClick={() => addRecipes(boxId)}>
                Add {possibleRecipes.length} recipe{possibleRecipes.length !== 1 ? 's' : ''} to box
              </Button>
            </div>
          </div>
        )}
      </Space>
    </Modal>
  )
}

export default ImportModal