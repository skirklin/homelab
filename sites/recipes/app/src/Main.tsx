import { useContext } from 'react';

import { Context } from './context';
import Header from './Header/Header';
import { Outlet } from 'react-router-dom';

import { Spin } from 'antd';
import ErrorBoundary from './ErrorBoundary';
import WhatsNew from './Modals/WhatsNew';

function Main() {
  const { state } = useContext(Context)

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
