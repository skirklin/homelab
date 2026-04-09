import { Popconfirm, Table, Tooltip } from "antd";
import type { ColumnsType } from "antd/es/table";
import type { Key, TableRowSelection } from "antd/es/table/interface";
import { useContext, useState } from "react";
import { useNavigate } from 'react-router-dom';
import { useBasePath } from '../RecipesRoutes';
import styled from "styled-components";
import { ActionButton } from "../StyledComponents";
import NewBoxButton from '../Buttons/NewBox';

import './BoxTable.css';
import { Context } from "../context";
import { useRecipesBackend } from "@kirkl/shared";
import { DeleteOutlined } from "@ant-design/icons";
import { type BoxId, Visibility } from "../types";
import type { UserEntry } from "../storage";
import VisibilityControl from "../Buttons/Visibility";

const TableContainer = styled.div`
  background: var(--color-bg);
`

const Toolbar = styled.div`
  display: flex;
  align-items: center;
  justify-content: flex-end;
  gap: var(--space-xs);
  padding: var(--space-sm) 0;
`

const BoxNameCell = styled.span`
  font-weight: 500;
  color: var(--color-text);
`

const OwnersCell = styled.span`
  color: var(--color-text-secondary);
  font-size: var(--font-size-sm);
`

const CountCell = styled.span`
  color: var(--color-text-secondary);
`

export type RowType = {
  name: string
  owners: UserEntry[]
  numRecipes: number
  boxId: BoxId
  key: string
}

const columns: ColumnsType<RowType> = [
  {
    key: 'name',
    title: 'Name',
    dataIndex: 'name',
    render: (value: string) => <BoxNameCell>{value}</BoxNameCell>,
  },
  {
    key: 'owners',
    title: 'Owners',
    dataIndex: ['owners'],
    render: (value: UserEntry[]) => <OwnersCell>{value.map(u => u.name).join(', ')}</OwnersCell>,
  },
  {
    key: 'numRecipes',
    title: 'Recipes',
    dataIndex: 'numRecipes',
    render: (value: number) => <CountCell>{value}</CountCell>,
    width: 100,
  }
]

interface BoxTableProps {
  rows: RowType[]

}

export function BoxTable(props: BoxTableProps) {
  const { state, dispatch } = useContext(Context)
  const recipesBackend = useRecipesBackend();
  const { writeable } = state;

  const { rows } = props;
  const navigate = useNavigate();
  const basePath = useBasePath();

  const onRow = (record: RowType, _rowIndex: number | undefined) => {
    return {
      onClick: () => navigate(`${basePath}/boxes/${record.boxId}`),
    }
  }

  const [selectedRowKeys, setSelectedRowKeys] = useState<Key[]>([]);
  const [selectedRows, setSelectedRows] = useState<RowType[]>([]);

  const onSelectChange = (selectedRowKeys: Key[], selectedRows: RowType[]) => {
    setSelectedRowKeys(selectedRowKeys);
    setSelectedRows(selectedRows);
  };

  const rowSelection: TableRowSelection<RowType> = {
    selectedRowKeys,
    onChange: onSelectChange,
  };

  async function del() {
    for (const value of selectedRows) {
      dispatch({ type: "REMOVE_BOX", boxId: value.boxId });
      await recipesBackend.deleteBox(value.boxId);
    }
    setSelectedRowKeys([]);
    setSelectedRows([]);
  }
  const hasSelected = (selectedRows.length > 0)

  function handleVisiblityChange(e: { key: string }) {
    selectedRows.forEach(
      (value: RowType) => {
        recipesBackend.setBoxVisibility(value.boxId, e.key as Visibility)
      }
    )
  }

  return (
    <TableContainer>
      <Toolbar>
        <NewBoxButton disabled={!writeable} />
        <VisibilityControl
          disabled={!writeable || !hasSelected}
          handleChange={handleVisiblityChange}
          value={Visibility.public}
          element="button"
        />
        <Popconfirm
          title={`Are you sure to delete ${selectedRowKeys.length > 1 ? "these boxes" : "this box"}?`}
          onConfirm={del}
          okText="Yes"
          disabled={!writeable || !hasSelected}
          cancelText="No"
        >
          <Tooltip title="Delete selected">
            <ActionButton
              disabled={!writeable || !hasSelected}
              icon={<DeleteOutlined />}
            >Delete</ActionButton>
          </Tooltip>
        </Popconfirm>
      </Toolbar>

      <Table<RowType>
        dataSource={rows}
        columns={columns}
        onRow={onRow}
        rowSelection={rowSelection}
        rowClassName={() => "box-row"}
        size="middle"
        pagination={false}
      />
    </TableContainer>
  )
}