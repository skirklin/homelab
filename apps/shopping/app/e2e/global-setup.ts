import PocketBase from "pocketbase";

const PB_URL = process.env.PB_TEST_URL || "http://127.0.0.1:8091";
const TEST_EMAIL = "playwright@test.local";
const TEST_EMAIL_2 = "playwright2@test.local";
const TEST_PASSWORD = "testpassword123";

async function globalSetup() {
  console.log("Setting up Playwright test environment...");

  // Verify PocketBase is running
  const pb = new PocketBase(PB_URL);
  try {
    await pb.health.check();
  } catch {
    throw new Error(
      `PocketBase not running at ${PB_URL}. Start it with: docker compose -f docker-compose.test.yml up -d`
    );
  }

  // Auth as admin
  await pb.collection("_superusers").authWithPassword(
    "test-admin@test.local",
    "testpassword1234"
  );

  // Create a test user for Playwright (idempotent)
  try {
    const existing = await pb.collection("users").getFirstListItem(
      `email = "${TEST_EMAIL}"`
    );
    // Update password in case it changed
    await pb.collection("users").update(existing.id, {
      password: TEST_PASSWORD,
      passwordConfirm: TEST_PASSWORD,
    });
  } catch {
    await pb.collection("users").create({
      email: TEST_EMAIL,
      password: TEST_PASSWORD,
      passwordConfirm: TEST_PASSWORD,
      name: "Playwright Test User",
    });
  }

  // Create a second test user for sharing tests (idempotent)
  try {
    const existing = await pb.collection("users").getFirstListItem(
      `email = "${TEST_EMAIL_2}"`
    );
    await pb.collection("users").update(existing.id, {
      password: TEST_PASSWORD,
      passwordConfirm: TEST_PASSWORD,
    });
  } catch {
    await pb.collection("users").create({
      email: TEST_EMAIL_2,
      password: TEST_PASSWORD,
      passwordConfirm: TEST_PASSWORD,
      name: "Playwright Test User 2",
    });
  }

  console.log("Test environment ready");
}

export default globalSetup;
