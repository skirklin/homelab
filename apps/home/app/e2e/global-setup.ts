import PocketBase from "pocketbase";

const PB_URL = process.env.PB_TEST_URL || "http://127.0.0.1:8091";
const API_URL = process.env.VITE_API_URL || "http://127.0.0.1:3001";

async function globalSetup() {
  console.log("Verifying test environment...");

  const pb = new PocketBase(PB_URL);
  try {
    await pb.health.check();
  } catch {
    throw new Error(
      `PocketBase not running at ${PB_URL}. Start the test env with: pnpm test:env:up`
    );
  }

  try {
    const resp = await fetch(`${API_URL}/health`);
    if (!resp.ok) throw new Error(`status ${resp.status}`);
  } catch (e) {
    throw new Error(
      `API service not running at ${API_URL}. Start the test env with: pnpm test:env:up\n${e}`
    );
  }

  console.log("✓ Test environment ready\n");
}

export default globalSetup;
