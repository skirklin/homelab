import { Input } from "antd";
import { SearchOutlined } from "@ant-design/icons";
import _ from "lodash";
import { Recipe } from "schema-dts";
import { RowType } from "./RecipeTable";
import Document from "flexsearch/dist/module/document";
import styled from "styled-components";

const SearchInput = styled(Input)`
  border-radius: var(--radius-md);

  &:hover, &:focus {
    border-color: var(--color-primary);
  }

  &:focus {
    box-shadow: 0 0 0 2px rgba(44, 166, 164, 0.1);
  }
`

interface FilterboxProps {
  setFilteredRows: (rows: RowType[]) => void,
  data: RowType[]
}

const getName = (name: Recipe["name"]) => name === undefined ? "" : name.toString()


function filterFunc(value: RowType, str: string): boolean {
  const recipe = value.recipe;
  const re = new RegExp(str.toLowerCase())
  if (getName(recipe.data.name).toLowerCase().match(re) !== null) {
    return true
  }

  const ingredients = Array.isArray(recipe.data.recipeIngredient) ? recipe.data.recipeIngredient : [];
  let matches = ingredients.filter((ri: any) => ri.toString().toLowerCase().match(re))
  if (matches.length > 0) {
    return true
  }

  const instructions = Array.isArray(recipe.data.recipeInstructions) ? recipe.data.recipeInstructions : [];
  matches = instructions.filter((ri: any) => (ri.text !== undefined && ri.text.toString().toLowerCase().match(re)))
  if (matches.length > 0) {
    return true
  }

  const categories = Array.isArray(recipe.data.recipeCategory) ? recipe.data.recipeCategory :
    (typeof recipe.data.recipeCategory === 'string' ? [recipe.data.recipeCategory] : []);
  matches = categories.filter((cat: any) => cat.toString().toLowerCase().match(re))
  if (matches.length > 0) {
    return true
  }

  return false
}


function Filterbox(props: FilterboxProps) {
  const { data, setFilteredRows } = props;

  const index = new Document({
    document: {
      id: "name",
      index: [
        "name",
        "instructions",
        "ingredients",
        "tags",
      ]
    }
  })
  data.forEach((row, idx) => {
    index.add(idx,
      {
        name: row.recipe.data.name,
        ingredients: row.recipe.data.recipeIngredient,
        instructions: row.recipe.data.recipeInstructions,
        tags: row.recipe.data.recipeCategory,
      }
    )
  }
  )
  function filterRecipes(e: { target: { value: string; }; }) {
    console.log("searched for:")
    console.log(e.target.value)
    if (e.target.value === "") {
      setFilteredRows(data)
    } else {
      const result = index.search(e.target.value)
      const idxs: number[] = [];
      let rows: RowType[] = [];
      result.forEach((obj: { result: number[] }) => obj.result.forEach(elt => {
        if (!idxs.includes(elt)) {
          idxs.push(elt);
          rows.push(data[elt])
        }
      }))
      console.log("found!")
      console.log(idxs)
      if (rows.length === 0)  {
        rows = _.filter(data, (row) => filterFunc(row, e.target.value))
      }
      if (rows.length > 0) setFilteredRows(rows)
    }
  }
  return (
    <SearchInput
      placeholder="Search recipes..."
      prefix={<SearchOutlined style={{ color: 'var(--color-text-muted)' }} />}
      onChange={filterRecipes}
      allowClear
      size="large"
    />
  )
}

export default Filterbox