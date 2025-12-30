import { useContext, useEffect, useState } from "react";
import { useParams } from "react-router-dom";
import { Spin } from "antd";
import { Context } from "../context";

import { getBox } from "../firestore";
import { getBoxFromState } from "../state";
import { BoxId } from "../types";
import BoxView from '../BoxView/BoxView'

interface BoxProps {
  boxId: BoxId
}

function Box(props: BoxProps) {
  const { boxId } = props;
  const { state, dispatch } = useContext(Context)
  const [loading, setLoading] = useState(true);
  const [fetchAttempted, setFetchAttempted] = useState(false);

  const box = getBoxFromState(state, boxId)

  useEffect(() => {
    let cancelled = false;

    (async () => {
      if (box === undefined && !fetchAttempted) {
        setLoading(true);
        const fetchedBox = await getBox(state, boxId)
        if (!cancelled) {
          if (fetchedBox !== undefined) {
            dispatch({ type: "ADD_BOX", payload: fetchedBox, boxId })
          }
          setFetchAttempted(true);
          setLoading(false);
        }
      } else if (box !== undefined) {
        setLoading(false);
      }
    })()

    return () => { cancelled = true; }
  }, [state, boxId, dispatch, box, fetchAttempted])

  if (loading && box === undefined) {
    return <Spin tip="Loading box..."><div style={{ minHeight: 200 }} /></Spin>
  }

  if (box === undefined) {
    return <div>Unable to find box.</div>
  }

  return (
    <>
      <BoxView {...props} />
    </>
  )
}

export default function RoutedBox() {
  const params = useParams();
  if (params.boxId === undefined) { throw new Error("Must have a boxId.") }

  return <Box boxId={params.boxId} />
}