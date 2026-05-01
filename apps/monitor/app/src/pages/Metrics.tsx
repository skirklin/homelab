// Iframe the Beszel hub UI directly. Same-tailnet origin so it loads cleanly;
// auth state is held by the iframe (cookies). For a fuller integration we'd
// query Beszel's PocketBase API directly, but iframe gives full feature parity
// with zero work.

export function Metrics() {
  return (
    <iframe
      className="metrics"
      src="https://homelab-0.tail56ca88.ts.net:9443/"
      title="Beszel system metrics"
    />
  );
}
