import { useState } from "react";
import { Button, Modal, Input, Space, Typography, message } from "antd";
import { ShareAltOutlined, CopyOutlined } from "@ant-design/icons";
import { getBackend } from "@kirkl/shared";

/** Small helper — resolves API base URL from the PB backend URL. */
function getApiBase(): string {
  const pbUrl = getBackend().baseURL.replace(/\/$/, "");
  const isLocal = pbUrl.includes("localhost") || pbUrl.includes("127.0.0.1");
  if (isLocal && typeof window !== "undefined") return window.location.origin + "/fn";
  return pbUrl + "/fn";
}

export function ShareLogButton({ logId }: { logId: string }) {
  const [open, setOpen] = useState(false);
  const [loading, setLoading] = useState(false);
  const [url, setUrl] = useState<string>("");

  const createInvite = async () => {
    setLoading(true);
    setUrl("");
    try {
      const pb = getBackend();
      const res = await fetch(`${getApiBase()}/sharing/invite`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Authorization": `Bearer ${pb.authStore.token}`,
        },
        body: JSON.stringify({ targetType: "travel_log", targetId: logId }),
      });
      if (!res.ok) {
        const err = await res.json().catch(() => ({ error: res.statusText }));
        throw new Error((err as { error?: string }).error || `API error ${res.status}`);
      }
      const data = await res.json() as { code: string; url: string };
      setUrl(data.url);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : "Failed to create invite";
      message.error(msg);
    }
    setLoading(false);
  };

  const handleOpen = () => {
    setOpen(true);
    createInvite();
  };

  const handleCopy = () => {
    navigator.clipboard.writeText(url);
    message.success("Link copied");
  };

  return (
    <>
      <Button size="small" icon={<ShareAltOutlined />} onClick={handleOpen}>
        Share
      </Button>
      <Modal
        title="Share travel log"
        open={open}
        onCancel={() => setOpen(false)}
        footer={null}
      >
        <Typography.Paragraph type="secondary" style={{ fontSize: 13 }}>
          Anyone with this link can accept the invite and become a co-owner of the travel log.
          The link can only be used once.
        </Typography.Paragraph>
        {url ? (
          <Space.Compact style={{ width: "100%" }}>
            <Input value={url} readOnly />
            <Button icon={<CopyOutlined />} onClick={handleCopy}>Copy</Button>
          </Space.Compact>
        ) : (
          <Button loading={loading} onClick={createInvite}>Generate invite link</Button>
        )}
      </Modal>
    </>
  );
}
