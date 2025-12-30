import { useEffect, useContext } from 'react';
import { Unsubscribe } from "firebase/auth";

import { UnsubMap } from './types';
import { Context } from './context';
import Header from './Header/Header';
import { Outlet } from 'react-router-dom';

import { subscribeToUser, unsubscribe } from './subscription';
import { Spin } from 'antd';
import ErrorBoundary from './ErrorBoundary';
import WhatsNew from './Modals/WhatsNew';

function Main() {

  const { dispatch, state } = useContext(Context)
  const { authUser } = state;

  useEffect(
    () => {
      if (authUser === null) {
        return
      }

      const unsubMap: UnsubMap = {
        userUnsub: undefined,
        boxesUnsub: undefined,
        boxMap: new Map<string, {
          boxUnsub: Unsubscribe,
          recipesUnsub: Unsubscribe
        }>(),
      }

      subscribeToUser(authUser, dispatch, unsubMap)
      return () => { console.debug("Unsubscribing from all."); unsubscribe(unsubMap) }
    }, [authUser, dispatch]
  )

  return (
    <>
      <Header />
      <WhatsNew />
      <Spin spinning={state.loading > 0}>
        <ErrorBoundary>
          <Outlet />
        </ErrorBoundary>
      </Spin>
    </>
  );
}


export default Main;
