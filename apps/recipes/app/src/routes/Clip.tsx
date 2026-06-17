import { useEffect, useRef, useState } from 'react';
import { Button, Input, Space, Typography } from 'antd';
import { CopyOutlined } from '@ant-design/icons';
import { useFeedback } from '@kirkl/shared';

import { CLIP_BOOKMARKLET } from '../clipBookmarklet';

const { Title, Paragraph, Text } = Typography;

/**
 * Setup page for the "Clip Recipe" bookmarklet.
 *
 * Renders a draggable bookmarklet link. CRITICAL: React strips `javascript:`
 * URLs from the `href` prop, so we set it imperatively via a ref. The anchor's
 * visible text is the name the bookmark gets when dragged to the bar.
 */
export default function Clip() {
  const linkRef = useRef<HTMLAnchorElement>(null);
  const [copied, setCopied] = useState(false);
  const { message } = useFeedback();

  useEffect(() => {
    if (linkRef.current) {
      linkRef.current.setAttribute('href', CLIP_BOOKMARKLET);
    }
  }, []);

  async function copyCode() {
    try {
      await navigator.clipboard.writeText(CLIP_BOOKMARKLET);
      setCopied(true);
      message.success('Bookmarklet copied');
      setTimeout(() => setCopied(false), 2000);
    } catch {
      message.error('Copy failed — select the code and copy manually');
    }
  }

  return (
    <div style={{ maxWidth: 640, margin: '24px auto', padding: 24 }}>
      <Title level={3}>Clip Recipe bookmarklet</Title>
      <Paragraph>
        Clip recipes from any site straight into your boxes. The bookmarklet
        reads the recipe from the page you're on (in your own browser, so paywalls
        and bot-blockers don't get in the way) and opens an import page here.
      </Paragraph>

      <Space direction="vertical" size="large" style={{ width: '100%' }}>
        <div>
          <a
            ref={linkRef}
            // href is set imperatively in useEffect — React strips javascript: hrefs.
            onClick={(e) => e.preventDefault()}
            draggable
            style={{
              display: 'inline-block',
              padding: '8px 16px',
              background: 'var(--color-primary, #1677ff)',
              color: '#fff',
              borderRadius: 6,
              fontWeight: 600,
              textDecoration: 'none',
              cursor: 'grab',
            }}
          >
            📋 Clip Recipe
          </a>
          <Paragraph type="secondary" style={{ marginTop: 8 }}>
            Drag this button to your bookmarks bar. Then click it on any recipe
            page to clip it.
          </Paragraph>
        </div>

        <div>
          <Text strong>Manual install</Text>
          <Paragraph type="secondary" style={{ marginBottom: 8 }}>
            If dragging doesn't work, create a new bookmark and paste this as the
            URL/address:
          </Paragraph>
          <Input.TextArea
            value={CLIP_BOOKMARKLET}
            readOnly
            autoSize={{ minRows: 3, maxRows: 8 }}
            onFocus={(e) => e.target.select()}
            style={{ fontFamily: 'monospace', fontSize: 12 }}
          />
          <Button
            icon={<CopyOutlined />}
            onClick={copyCode}
            style={{ marginTop: 8 }}
          >
            {copied ? 'Copied' : 'Copy code'}
          </Button>
        </div>
      </Space>
    </div>
  );
}
