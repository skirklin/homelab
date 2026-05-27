import { useCallback, useEffect, useMemo, useState } from "react";
import { Input } from "antd";
import { SearchOutlined } from "@ant-design/icons";
import _ from "lodash";
import type { Recipe } from "schema-dts";
import type { RowType } from "./RecipeTable";
import Document from "flexsearch/dist/module/document";
import styled from "styled-components";
import { useUrlParam } from "@kirkl/shared";

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
  setFilteredRows: (rows: RowType[] | undefined) => void,
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

  // URL-backed query: instant local state for typing feedback; URL lags by 250ms.
  const [urlQuery, setUrlQuery] = useUrlParam<string>("q", {
    parse: (raw) => raw ?? "",
    serialize: (v) => v || null,
    default: "",
    debounce: 250,
  });
  const [query, setQueryLocal] = useState(urlQuery);
  const setQuery = useCallback(
    (next: string) => {
      setQueryLocal(next);
      setUrlQuery(next);
    },
    [setUrlQuery],
  );

  // Rebuild the flexsearch index only when `data` changes, not every render.
  const index = useMemo(() => {
    const idx = new Document({
      document: {
        id: "name",
        index: ["name", "instructions", "ingredients", "tags"],
      },
    });
    data.forEach((row, i) => {
      idx.add(i, {
        name: row.recipe.data.name,
        ingredients: row.recipe.data.recipeIngredient,
        instructions: row.recipe.data.recipeInstructions,
        tags: row.recipe.data.recipeCategory,
      });
    });
    return idx;
  }, [data]);

  // Run the filter whenever the query OR the underlying data changes. This
  // covers both initial mount with `?q=foo` and live data updates mid-search.
  useEffect(() => {
    if (query === "") {
      setFilteredRows(undefined);
      return;
    }
    const result = index.search(query);
    const seen = new Set<number>();
    let rows: RowType[] = [];
    result.forEach((obj: { result: (string | number)[] }) =>
      obj.result.forEach((elt) => {
        const i = typeof elt === "string" ? parseInt(elt) : elt;
        if (!seen.has(i)) {
          seen.add(i);
          rows.push(data[i]);
        }
      }),
    );
    if (rows.length === 0) {
      rows = _.filter(data, (row) => filterFunc(row, query));
    }
    setFilteredRows(rows);
  }, [query, data, index, setFilteredRows]);

  return (
    <SearchInput
      placeholder="Search recipes..."
      prefix={<SearchOutlined style={{ color: 'var(--color-text-muted)' }} />}
      value={query}
      onChange={(e) => setQuery(e.target.value ?? "")}
      allowClear
      size="large"
    />
  )
}

export default Filterbox
