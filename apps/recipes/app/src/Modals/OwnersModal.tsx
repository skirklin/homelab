import { Modal, List, Spin, Typography } from 'antd';
import { UserOutlined, StarOutlined } from '@ant-design/icons';
import { useEffect, useState } from 'react';
import { getOwnerInfo } from '../backend';

interface OwnerInfo {
  uid: string;
  name: string | null;
  email: string | null;
}

interface OwnersModalProps {
  isVisible: boolean;
  setIsVisible: (visible: boolean) => void;
  ownerIds: string[];
  subscriberIds?: string[];
}

export function OwnersModal({ isVisible, setIsVisible, ownerIds, subscriberIds = [] }: OwnersModalProps) {
  const [owners, setOwners] = useState<OwnerInfo[]>([]);
  const [subscribers, setSubscribers] = useState<OwnerInfo[]>([]);
  const [loading, setLoading] = useState(false);

  // Subscribers who are not also owners
  const subscriberOnlyIds = subscriberIds.filter(id => !ownerIds.includes(id));

  useEffect(() => {
    if (!isVisible) return;
    const allIds = [...new Set([...ownerIds, ...subscriberOnlyIds])];
    if (allIds.length === 0) return;

    setLoading(true);
    getOwnerInfo({ ownerIds: allIds })
      .then(result => {
        const infoMap = new Map(result.owners.map(o => [o.uid, o]));
        setOwners(ownerIds.map(uid => infoMap.get(uid) || { uid, name: null, email: null }));
        setSubscribers(subscriberOnlyIds.map(uid => infoMap.get(uid) || { uid, name: null, email: null }));
      })
      .catch(() => {
        setOwners(ownerIds.map(uid => ({ uid, name: null, email: null })));
        setSubscribers(subscriberOnlyIds.map(uid => ({ uid, name: null, email: null })));
      })
      .finally(() => setLoading(false));
  }, [isVisible, ownerIds.join(','), subscriberIds.join(',')]);

  const renderUser = (user: OwnerInfo) => (
    <List.Item>
      <List.Item.Meta
        avatar={<UserOutlined />}
        title={user.name || user.email || 'Unknown user'}
        description={user.name && user.email ? user.email : undefined}
      />
    </List.Item>
  );

  return (
    <Modal
      title="People"
      open={isVisible}
      onCancel={() => setIsVisible(false)}
      footer={null}
    >
      {loading ? (
        <Spin />
      ) : (
        <>
          <Typography.Text type="secondary" strong>
            <StarOutlined /> Owners ({owners.length})
          </Typography.Text>
          <List dataSource={owners} renderItem={renderUser} />
          {subscribers.length > 0 && (
            <>
              <Typography.Text type="secondary" strong style={{ marginTop: 12, display: 'block' }}>
                <UserOutlined /> Subscribers ({subscribers.length})
              </Typography.Text>
              <List dataSource={subscribers} renderItem={renderUser} />
            </>
          )}
        </>
      )}
    </Modal>
  );
}
