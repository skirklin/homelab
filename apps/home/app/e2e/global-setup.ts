import PocketBase from "pocketbase";

const PB_URL = process.env.PB_TEST_URL || "http://127.0.0.1:8091";

async function globalSetup() {
  console.log("Verifying test environment...");

  const pb = new PocketBase(PB_URL);
  try {
    await pb.health.check();
  } catch {
    throw new Error(
      `PocketBase not running at ${PB_URL}. Start it with: docker compose -f docker-compose.test.yml up -d`
    );
  }

  console.log("✓ Test environment ready\n");
}

export default globalSetup;
