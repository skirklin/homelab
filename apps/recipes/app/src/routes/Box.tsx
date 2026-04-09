import { useContext, useEffect, useState } from "react";
import { useParams } from "react-router-dom";
import { Spin } from "antd";
import { useAuth } from "@kirkl/shared";
import { Context } from "../context";

import { useRecipesBackend } from "@kirkl/shared";
import { boxFromBackend, recipeFromBackend } from "../adapters";
import { getBoxFromState } from "../state";
import type { BoxId } from "../types";
import BoxView from '../BoxView/BoxView'

interface BoxProps {
  boxId: BoxId
}

function Box(props: BoxProps) {
  const { boxId } = props;
  const { state, dispatch } = useContext(Context)
  const { user } = useAuth();
  const recipesBackend = useRecipesBackend();
  const [loading, setLoading] = useState(true);
  const [fetchAttempted, setFetchAttempted] = useState(false);

  const box = getBoxFromState(state, boxId)

  useEffect(() => {
    let cancelled = false;

    (async () => {
      if (box === undefined && !fetchAttempted) {
        setLoading(true);
        const result = await recipesBackend.getBox(boxId, user?.uid ?? null);
        if (!cancelled) {
          if (result !== null) {
            const fetchedBox = boxFromBackend(result.box);
            for (const r of result.recipes) {
              fetchedBox.recipes.set(r.id, recipeFromBackend(r));
            }
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
  }, [boxId, dispatch, box, fetchAttempted, user?.uid, recipesBackend])

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