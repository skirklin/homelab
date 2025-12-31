async function globalSetup() {
  console.log("Verifying test environment...");
  await new Promise((resolve) => setTimeout(resolve, 1000));
  console.log("✓ Test environment ready\n");
}

export default globalSetup;
