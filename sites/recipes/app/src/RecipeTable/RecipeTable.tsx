import _ from 'lodash';
import { useContext, useEffect, useState } from 'react';
import { Popconfirm, Table, Tooltip } from 'antd';
import { ColumnsType } from 'antd/es/table';

import { Key, TableRowSelection } from 'antd/es/table/interface';
import { DeleteOutlined, CopyOutlined, RobotOutlined } from '@ant-design/icons';
import { useNavigate } from 'react-router-dom';
import Filterbox from './Filterbox';
import NewButton from '../Buttons/NewRecipe';
import UploadButton from '../Buttons/UploadRecipes';
import ImportButton from '../Buttons/ImportRecipes';
import GenerateButton from '../Buttons/GenerateRecipe';
import { addRecipe, deleteRecipe, setRecipeVisibility } from '../firestore';
import { Context } from '../context';
import { PickBoxModal } from '../Modals/PickBoxModal';
import BatchEnrichmentModal from '../Modals/BatchEnrichmentModal';
import { ActionButton } from '../StyledComponents';
import './RecipeTable.css'
import { BoxEntry, RecipeEntry } from '../storage';
import { BoxId, Visibility } from '../types';
import styled from 'styled-components';
import { useMediaQuery } from 'react-responsive'
import VisibilityControl from '../Buttons/Visibility';
import { addRecipeOwner } from '../backend';

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
  box: BoxEntry,
  recipe: RecipeEntry
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

  const { writeable, recipes, boxId } = props;
  const { state, dispatch } = useContext(Context)
  const [filteredRows, setFilteredRows] = useState<RowType[]>()

  // Count recipes with pending enrichments
  const pendingEnrichmentCount = recipes.filter(r => r.recipe.pendingEnrichment).length;

  useEffect(() => {
    const sortedRecipes = _.sortBy(recipes, row => -row.recipe.updated)
    setFilteredRows(sortedRecipes)
  },
    [recipes]
  )


  const onSelectChange = (selectedRowKeys: Key[], selectedRows: RowType[]) => {
    setSelectedRowKeys(selectedRowKeys);
    setSelectedRows(selectedRows);
  };

  const rowSelection: TableRowSelection<RowType> = {
    selectedRowKeys,
    onChange: onSelectChange,
  };

  const onNameCell = (record: RowType, rowIndex: number | undefined) => {
    return {
      onClick: () => navigate(`/boxes/${record.box.id}/recipes/${record.recipe.id}`),
    }
  }
  const onBoxCell = (record: RowType, rowIndex: number | undefined) => {
    return {
      onClick: () => navigate(`/boxes/${record.box.id}`),
    }
  }

  const hasSelected = selectedRowKeys.length > 0;

  async function del() {
    selectedRows.forEach(
      (value: RowType) => {
        deleteRecipe(state, value.box.id, value.recipe.id, dispatch)
      }
    )
    setSelectedRowKeys([])
    setSelectedRows([])
  }

  async function fork(boxId: BoxId) {
    selectedRows.forEach(
      (value: RowType) => {
        addRecipe(boxId, _.cloneDeep(value.recipe))
      }
    )
    navigate(`/boxes/${boxId}`)
  }

  function handleVisiblityChange(e: { key: string }) {
    selectedRows.forEach(
      (value: RowType) => {
        setRecipeVisibility(value.box.id, value.recipe.id, e.key as Visibility)
      }
    )
  }

  function handleAddOwner(newOwnerEmail: string) {
    selectedRows.forEach(
      (value: RowType) => {
        addRecipeOwner({ boxId: value.box.id, recipeId: value.recipe.id, newOwnerEmail })
      }
    )
  }

  const columns: ColumnsType<RowType> = [
    {
      key: 'name',
      title: 'Name',
      render: (value, record) => (
        <NameCell>
          <RecipeName>{record.recipe.getName()}</RecipeName>
          {record.recipe.pendingEnrichment && (
            <Tooltip title="AI suggestions available">
              <AIIndicator><RobotOutlined /></AIIndicator>
            </Tooltip>
          )}
        </NameCell>
      ),
      sorter: (a: RowType, b: RowType) => sortfunc(a.recipe.getName() || "", b.recipe.getName() || ""),
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
        render: (value, record) => <BoxName>{record.box.getName()}</BoxName>,
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
        render: (value, record) => <Description>{record.recipe.getDescription()}</Description>,
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
          <GenerateButton boxId={boxId} disabled={!writeable} />
          {pendingEnrichmentCount > 0 && (
            <Tooltip title={`Review ${pendingEnrichmentCount} AI suggestion${pendingEnrichmentCount > 1 ? 's' : ''}`}>
              <ActionButton
                onClick={() => setIsBatchModalVisible(true)}
                icon={<RobotOutlined />}
                style={{ color: '#9370db', borderColor: '#9370db' }}
              >
                AI ({pendingEnrichmentCount})
              </ActionButton>
            </Tooltip>
          )}
          <VisibilityControl
            disabled={!writeable || !hasSelected}
            handleChange={handleVisiblityChange}
            handleAddOwner={handleAddOwner}
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
        dataSource={filteredRows}
        size="middle"
      />
    </TableContainer>
  )
}