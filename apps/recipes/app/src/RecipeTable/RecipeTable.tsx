import _ from 'lodash';
import { useContext, useMemo, useState } from 'react';
import { Popconfirm, Table, Tooltip } from 'antd';
import type { ColumnsType } from 'antd/es/table';

import type { Key, SorterResult, TableRowSelection } from 'antd/es/table/interface';
import { DeleteOutlined, CopyOutlined, RobotOutlined } from '@ant-design/icons';
import { useNavigate } from 'react-router-dom';
import { useBasePath } from '../RecipesRoutes';
import Filterbox from './Filterbox';
import NewButton from '../Buttons/NewRecipe';
import UploadButton from '../Buttons/UploadRecipes';
import ImportButton from '../Buttons/ImportRecipes';
import { useRecipesBackend, useUrlParam } from '@kirkl/shared';
import { recipeDataToBackend } from '../adapters';
import { getRecentViews } from '../recentlyViewed';
import { Context } from '../context';
import { PickBoxModal } from '../Modals/PickBoxModal';
import BatchEnrichmentModal from '../Modals/BatchEnrichmentModal';
import { ActionButton } from '../StyledComponents';
import './RecipeTable.css'
import { type PlainBox, type PlainRecipe, getBoxName, getRecipeDescription, getRecipeName } from '../storage';
import { type BoxId, Visibility } from '../types';
import styled from 'styled-components';
import { useMediaQuery } from 'react-responsive'
import VisibilityControl from '../Buttons/Visibility';

const TableContainer = styled.div`
  background: var(--color-bg);
`

const Toolbar = styled.div`
  display: flex;
  align-items: center;
  gap: var(--space-sm);
  padding: var(--space-sm) 0;
  flex-wrap: wrap;

  @media (max-width: 768px) {
    flex-direction: column;
    align-items: stretch;
  }
`

const SearchSection = styled.div`
  flex: 1;
  min-width: 200px;
  max-width: 400px;

  @media (max-width: 768px) {
    max-width: none;
  }
`

const ActionsSection = styled.div`
  display: flex;
  align-items: center;
  gap: var(--space-xs);
  flex-wrap: wrap;
`

const RecipeName = styled.span`
  font-weight: 500;
  color: var(--color-text);
`

const BoxName = styled.span`
  color: var(--color-text-secondary);
`

const Description = styled.span`
  color: var(--color-text-secondary);
  font-size: var(--font-size-sm);
`

const AIIndicator = styled.span`
  color: #9370db;
  margin-left: var(--space-xs);
`

const NameCell = styled.div`
  display: flex;
  align-items: center;
`

function sortfunc(a: string, b: string) {
  const A = a.toUpperCase(); // ignore upper and lowercase
  const B = b.toUpperCase(); // ignore upper and lowercase
  if (A < B) {
    return -1;
  }
  if (A > B) {
    return 1;
  }

  return 0;
}

export interface RowType {
  box: PlainBox,
  recipe: PlainRecipe
  key: string
}

interface RecipeTableProps {
  recipes: RowType[]
  writeable: boolean
  boxId?: string
}


export function RecipeTable(props: RecipeTableProps) {
  /// https://ant.design/components/table/#components-table-demo-row-selection-and-operation
  const [selectedRowKeys, setSelectedRowKeys] = useState<Key[]>([]);
  const [selectedRows, setSelectedRows] = useState<RowType[]>([]);
  const [isModalVisible, setIsModalVisible] = useState(false);
  const [isBatchModalVisible, setIsBatchModalVisible] = useState(false);
  const navigate = useNavigate();
  const basePath = useBasePath();

  const { writeable, recipes, boxId } = props;
  const { state, dispatch } = useContext(Context)
  const recipesBackend = useRecipesBackend();
  // `undefined` = no filter active; render the full `recipes` list (sorted).
  const [filteredRows, setFilteredRows] = useState<RowType[] | undefined>(undefined)

  // Count recipes with pending changes (enrichments or modifications)
  const pendingChangesCount = recipes.filter(r => r.recipe.pendingChanges).length;

  // URL-backed sort. `null` sortKey means "no explicit sort" — fall back to
  // recency (recently-viewed first, then by updated time). When the user
  // toggles a column off, both params get cleared by the hook (default match).
  const [sortKey, setSortKey] = useUrlParam<string | null>("sort", {
    parse: (raw) => raw,
    serialize: (v) => v,
    default: null,
  });
  const [sortDir, setSortDir] = useUrlParam<"asc" | "desc">("dir", {
    parse: (raw) => (raw === "desc" ? "desc" : "asc"),
    serialize: (v) => (v === "desc" ? "desc" : null),
    default: "asc",
  });

  // The default (no-sort) ordering: recently-viewed first, then by updated.
  const recencySorted = useMemo(() => {
    const recentViews = getRecentViews();
    return _.sortBy(recipes, (row) => {
      const viewedAt = recentViews.get(row.recipe.id);
      return viewedAt ? -viewedAt : -row.recipe.updated;
    });
  }, [recipes]);

  // What we actually feed to <Table>. Filterbox sets `filteredRows` when a
  // query is active; otherwise we show the recency-sorted list and let antd
  // apply the controlled sort on top.
  const dataSource = filteredRows ?? recencySorted;


  const onSelectChange = (selectedRowKeys: Key[], selectedRows: RowType[]) => {
    setSelectedRowKeys(selectedRowKeys);
    setSelectedRows(selectedRows);
  };

  const rowSelection: TableRowSelection<RowType> = {
    selectedRowKeys,
    onChange: onSelectChange,
  };

  const onNameCell = (record: RowType, _rowIndex: number | undefined) => {
    return {
      onClick: () => navigate(`${basePath}/boxes/${record.box.id}/recipes/${record.recipe.id}`),
    }
  }
  const onBoxCell = (record: RowType, _rowIndex: number | undefined) => {
    return {
      onClick: () => navigate(`${basePath}/boxes/${record.box.id}`),
    }
  }

  const hasSelected = selectedRowKeys.length > 0;

  async function del() {
    for (const value of selectedRows) {
      dispatch({ type: "REMOVE_RECIPE", boxId: value.box.id, recipeId: value.recipe.id });
      await recipesBackend.deleteRecipe(value.recipe.id);
    }
    setSelectedRowKeys([])
    setSelectedRows([])
  }

  async function fork(boxId: BoxId) {
    for (const value of selectedRows) {
      const data = recipeDataToBackend(value.recipe);
      const userId = value.recipe.owners[0] || "";
      await recipesBackend.addRecipe(boxId, data, userId);
    }
    navigate(`${basePath}/boxes/${boxId}`)
  }

  function handleVisiblityChange(e: { key: string }) {
    selectedRows.forEach(
      (value: RowType) => {
        recipesBackend.setRecipeVisibility(value.recipe.id, e.key as Visibility)
      }
    )
  }

  const columns: ColumnsType<RowType> = [
    {
      key: 'name',
      title: 'Name',
      render: (_value, record) => (
        <NameCell>
          <RecipeName>{getRecipeName(record.recipe)}</RecipeName>
          {record.recipe.pendingChanges && (
            <Tooltip title="AI suggestions available">
              <AIIndicator><RobotOutlined /></AIIndicator>
            </Tooltip>
          )}
        </NameCell>
      ),
      sorter: (a: RowType, b: RowType) => sortfunc(getRecipeName(a.recipe) || "", getRecipeName(b.recipe) || ""),
      sortOrder: sortKey === 'name' ? (sortDir === 'desc' ? 'descend' : 'ascend') : null,
      onCell: onNameCell,
      className: "recipe-table-clickable-column",
      width: 200,
    }
  ]

  if (boxId === undefined) {
    columns.push(
      {
        key: 'box',
        title: 'Box',
        onCell: onBoxCell,
        render: (_value, record) => <BoxName>{getBoxName(record.box)}</BoxName>,
        className: "recipe-table-clickable-column",
        width: 150,
      }
    )
  }

  const isTabletOrMobile = useMediaQuery({ query: '(max-width: 1224px)' })
  if (!isTabletOrMobile) {
    columns.push(
      {
        key: 'description',
        title: 'Description',
        render: (_value, record) => <Description>{getRecipeDescription(record.recipe)}</Description>,
        ellipsis: true,
      }
    )
  }

  return (
    <TableContainer>
      <Toolbar>
        <SearchSection>
          <Filterbox data={recipes} setFilteredRows={setFilteredRows} />
        </SearchSection>
        <ActionsSection>
          <NewButton boxId={boxId} disabled={!writeable} element="button" />
          <UploadButton boxId={boxId} disabled={!writeable} element="button" />
          <ImportButton boxId={boxId} disabled={!writeable} element="button" />
          {pendingChangesCount > 0 && (
            <Tooltip title={`Review ${pendingChangesCount} AI suggestion${pendingChangesCount > 1 ? 's' : ''}`}>
              <ActionButton
                onClick={() => setIsBatchModalVisible(true)}
                icon={<RobotOutlined />}
                style={{ color: '#9370db', borderColor: '#9370db' }}
              >
                AI ({pendingChangesCount})
              </ActionButton>
            </Tooltip>
          )}
          <VisibilityControl
            disabled={!writeable || !hasSelected}
            handleChange={handleVisiblityChange}
            value={Visibility.public}
            element="button"
          />
          <Popconfirm
            title={`Are you sure to delete ${selectedRowKeys.length > 1 ? "these recipes" : "this recipe"}?`}
            onConfirm={del}
            okText="Yes"
            cancelText="No"
          >
            <Tooltip title="Delete selected">
              <ActionButton
                disabled={!writeable || !hasSelected}
                icon={<DeleteOutlined />}
              >Delete</ActionButton>
            </Tooltip>
          </Popconfirm>
          <Tooltip title="Copy to another box">
            <ActionButton
              onClick={() => setIsModalVisible(true)}
              disabled={!hasSelected}
              icon={<CopyOutlined />}
            >Copy</ActionButton>
          </Tooltip>
          <PickBoxModal handleOk={fork} isVisible={isModalVisible} setIsVisible={setIsModalVisible} />
          <BatchEnrichmentModal open={isBatchModalVisible} onClose={() => setIsBatchModalVisible(false)} />
        </ActionsSection>
      </Toolbar>
      <Table<RowType>
        pagination={false}
        rowSelection={rowSelection}
        columns={columns}
        dataSource={dataSource}
        size="middle"
        onChange={(_pag, _filters, sorter) => {
          // We only sort by a single column; if antd ever hands us an array
          // (multi-column sort) pick the first entry.
          const s = Array.isArray(sorter) ? sorter[0] : sorter as SorterResult<RowType>;
          const order = s?.order;
          if (!order) {
            // User cleared the sort — drop both params.
            setSortKey(null);
            setSortDir("asc");
            return;
          }
          setSortKey(s.columnKey != null ? String(s.columnKey) : null);
          setSortDir(order === "descend" ? "desc" : "asc");
        }}
      />
    </TableContainer>
  )
}